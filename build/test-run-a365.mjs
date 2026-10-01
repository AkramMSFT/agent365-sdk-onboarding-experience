// Offline tests for payload/.a365-kit/run-a365.mjs with a stand-in for the a365 process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const kitDir = path.join(here, '..', 'payload', '.a365-kit');
const { runA365 } = await import(pathToFileURL(path.join(kitDir, 'run-a365.mjs')).href);
const { ADMIN_ACTION_EXIT_CODE, OBSERVABILITY_CONSENT_MESSAGE } =
  await import(pathToFileURL(path.join(kitDir, 'lib', 'observability-consent.mjs')).href);

function sink() {
  const chunks = [];
  return { write: chunk => { chunks.push(String(chunk)); return true; }, get text() { return chunks.join(''); } };
}

function fakeStart({ stdout = [], stderr = [], code = 0, signal = null, error = null } = {}) {
  const calls = [];
  const start = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(async () => {
      if (error) {
        child.emit('error', error);
        child.emit('close', -4058, null);
        return;
      }
      for (const chunk of stdout) child.stdout.write(chunk);
      for (const chunk of stderr) child.stderr.write(chunk);
      const ended = Promise.all([once(child.stdout, 'end'), once(child.stderr, 'end')]);
      child.stdout.end();
      child.stderr.end();
      await ended;
      child.emit('close', code, signal);
    });
    return child;
  };
  return { start, calls };
}

async function run(args, script) {
  const fake = fakeStart(script);
  const out = sink();
  const err = sink();
  const code = await runA365(args, { start: fake.start, stdout: out, stderr: err });
  return { code, out: out.text, err: err.text, calls: fake.calls };
}

test('forwards setup arguments to the installed CLI with piped output and inherited stdin', async () => {
  const r = await run(['setup', 'all', '--agent-name', 'hr'], { stdout: ['Setup complete\n'] });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Setup complete\n');
  assert.equal(r.err, '');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].command, process.platform === 'win32' ? 'a365.exe' : 'a365');
  assert.deepEqual(r.calls[0].args, ['setup', 'all', '--agent-name', 'hr']);
  assert.deepEqual(r.calls[0].options, { stdio: ['inherit', 'pipe', 'pipe'], shell: false });
});

test('exit 0 with the consent sentence becomes the admin-action exit code', async () => {
  const r = await run(['setup', 'all'], { stdout: [OBSERVABILITY_CONSENT_MESSAGE + '\n'] });
  assert.equal(ADMIN_ACTION_EXIT_CODE, 2);
  assert.equal(r.code, 2);
  assert.ok(r.out.includes(OBSERVABILITY_CONSENT_MESSAGE));
  assert.match(r.err, /Observability consent is pending administrator action/);
});

test('a nonzero CLI exit code is preserved, with or without the consent sentence', async () => {
  assert.equal((await run(['setup', 'all'], { code: 5 })).code, 5);
  const withSentence = await run(['setup', 'all'], { stderr: [OBSERVABILITY_CONSENT_MESSAGE], code: 3 });
  assert.equal(withSentence.code, 3);
  assert.match(withSentence.err, /Observability consent is pending administrator action/);
});

test('the sentence split across two chunks is still detected', async () => {
  const at = OBSERVABILITY_CONSENT_MESSAGE.indexOf('maven-prod') + 4;
  const r = await run(['setup', 'blueprint'], {
    stdout: [OBSERVABILITY_CONSENT_MESSAGE.slice(0, at), OBSERVABILITY_CONSENT_MESSAGE.slice(at) + '\n'],
  });
  assert.equal(r.code, 2);
  assert.match(r.err, /Observability consent is pending administrator action/);
});

test('output without the sentence leaves exit 0 and prints no guidance', async () => {
  const r = await run(['setup', 'all'], { stdout: ['maven-prod ', 'is mentioned but nothing is pending\n'] });
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
});

test('a launch error returns 1 with an installation hint', async () => {
  const error = Object.assign(new Error('spawn a365.exe ENOENT'), { code: 'ENOENT' });
  const r = await run(['setup', 'all'], { error });
  assert.equal(r.code, 1);
  assert.match(r.err, /Could not start the installed a365 CLI \(ENOENT\)/);
});

test('a CLI ended by a signal or without a status is not reported as complete', async () => {
  const bySignal = await run(['setup', 'all'], { code: null, signal: 'SIGTERM' });
  assert.equal(bySignal.code, 143);
  assert.match(bySignal.err, /ended due to SIGTERM/);
  const noStatus = await run(['setup', 'all'], { code: null });
  assert.equal(noStatus.code, 1);
  assert.match(noStatus.err, /ended without an exit status/);
});

test('help and the consent explanation print without starting the CLI', async () => {
  for (const args of [[], ['--help'], ['-h']]) {
    const r = await run(args);
    assert.equal(r.code, 0);
    assert.match(r.out, /^Usage: node \.a365-kit\/run-a365\.mjs setup <subcommand>/);
    assert.equal(r.err, '');
    assert.equal(r.calls.length, 0);
  }
  const explain = await run(['--explain-observability-consent']);
  assert.equal(explain.code, 0);
  assert.match(explain.out, /Observability consent is pending administrator action/);
  assert.equal(explain.calls.length, 0);
});

test('commands other than setup are refused without starting the CLI', async () => {
  for (const args of [['deploy'], ['--help', 'setup'], ['config', 'init']]) {
    const r = await run(args);
    assert.equal(r.code, 1);
    assert.equal(r.out, '');
    assert.match(r.err, /only forwards a365 setup commands/);
    assert.equal(r.calls.length, 0);
  }
});

test('runs when launched through a directory junction or symlink', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-a365-'));
  const link = path.join(root, 'kit');
  t.after(() => {
    // The link goes first, so the recursive delete cannot reach the kit through it.
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* not created */ } }
    if (!fs.lstatSync(link, { throwIfNoEntry: false })) fs.rmSync(root, { recursive: true, force: true });
  });
  try {
    fs.symlinkSync(kitDir, link, 'junction');
  } catch (error) {
    t.skip(`cannot create a directory link here (${error.code})`);
    return;
  }
  const r = spawnSync(process.execPath, [path.join(link, 'run-a365.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Usage: node \.a365-kit\/run-a365\.mjs setup <subcommand>/);
});
