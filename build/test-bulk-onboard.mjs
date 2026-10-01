// Offline tests for tools/bulk-onboard.mjs against an in-memory stand-in for the herdr CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const { main, agentName, readAgents, EXIT, STATE_FILE } = await import(pathToFileURL(path.join(repo, 'tools', 'bulk-onboard.mjs')).href);
const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function fakeHerdr({ running = true, installed = true, notReady = new Set(), statuses = {}, promptResult = {} } = {}) {
  const calls = [];
  let ws = 0;
  const ok = result => ({ code: 0, stdout: JSON.stringify({ id: 'x', result }), stderr: '' });
  const fail = (code, message) => ({ code: 1, stdout: '', stderr: JSON.stringify({ id: 'x', error: { code, message } }) });
  const herdr = args => {
    calls.push(args);
    if (!installed) return { code: 127, stdout: '', stderr: 'spawn herdr ENOENT' };
    if (!running) return fail('server_unavailable', 'no herdr server');
    const [a, b, c] = args;
    if (a === 'workspace' && b === 'list') return ok({ workspaces: [] });
    if (a === 'workspace' && b === 'create') {
      ws++;
      return ok({ workspace: { workspace_id: `w${ws}` }, tab: { tab_id: `w${ws}:t1` }, root_pane: { pane_id: `w${ws}:p1` } });
    }
    if (a === 'agent' && b === 'start') return notReady.has(c) ? fail('agent_not_ready', 'blocked during startup') : ok({ agent: { name: c, agent_status: 'idle' } });
    if (a === 'agent' && b === 'prompt') {
      const outcome = promptResult[c];
      if (outcome === 'stalled') return fail('agent_prompt_stalled', 'no activity after the prompt');
      if (outcome === 'blocked') return fail('agent_blocked', 'agent is blocked');
      if (outcome === 'timeout') return fail('timeout', 'timed out while working');
      return ok({ agent: { name: c, agent_status: 'done' } });
    }
    if (a === 'agent' && b === 'get') return ok({ agent: { name: c, agent_status: statuses[c] ?? 'working' } });
    return fail('unknown', `unexpected ${args.join(' ')}`);
  };
  return { herdr, calls };
}

function workspace(folders, { kit = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-'));
  roots.push(root);
  const lines = [];
  for (const f of folders) {
    const dir = path.join(root, f);
    fs.mkdirSync(dir, { recursive: true });
    if (kit) {
      fs.mkdirSync(path.join(dir, '.a365-kit'));
      fs.writeFileSync(path.join(dir, '.a365-kit', 'KIT-VERSION.json'), '{}');
    }
    lines.push(f);
  }
  const list = path.join(root, 'agents.txt');
  fs.writeFileSync(list, '# agents to onboard\n' + lines.join('\n') + '\n\n');
  return { root, list };
}

async function run(argv, h) {
  const out = [], errs = [];
  const code = await main(argv, { herdr: h.herdr, log: s => out.push(s), err: s => errs.push(s), bundleRoot: repo });
  return { code, out: out.join('\n'), err: errs.join('\n') };
}

test('names follow the herdr naming rule and stay unique', () => {
  assert.equal(agentName('HR Agent (v2)'), 'hr-agent-v2');
  assert.equal(agentName('365-bot'), 'bot');
  assert.equal(agentName('x'.repeat(40)).length, 32);
  assert.match(agentName('!!!'), /^[a-z][a-z0-9_-]*$/);
});

test('a quoted folder may contain a comma, with or without a name after it', () => {
  const { root } = workspace([]);
  const list = path.join(root, 'agents.txt');
  fs.writeFileSync(list, '"a,b"\n"c,d", Named\nplain, other\n');
  assert.deepEqual(readAgents(list).map(a => [path.basename(a.dir), a.name]), [['a,b', 'a-b'], ['c,d', 'named'], ['plain', 'other']]);
});

test('starts one workspace per agent, starts the CLI, and prompts it', async () => {
  const { list, root } = workspace(['hr-agent', 'expenses-agent']);
  const h = fakeHerdr();
  const r = await run([list, '--cli', 'claude'], h);
  assert.equal(r.code, EXIT.ok, r.err);
  assert.deepEqual(h.calls.map(c => c.slice(0, 2).join(' ')), [
    'workspace list',
    'workspace create', 'agent start', 'agent prompt',
    'workspace create', 'agent start', 'agent prompt',
  ]);
  assert.deepEqual(h.calls[1], ['workspace', 'create', '--cwd', path.join(root, 'hr-agent'), '--label', 'hr-agent', '--no-focus']);
  assert.deepEqual(h.calls[2], ['agent', 'start', 'hr-agent', '--kind', 'claude', '--pane', 'w1:p1', '--timeout', '120000']);
  assert.deepEqual(h.calls[3], ['agent', 'prompt', 'hr-agent', 'Onboard this agent to Agent 365.', '--wait', '--timeout', '30000']);
  const state = JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), 'utf8'));
  assert.equal(state.agents['expenses-agent'].pane, 'w2:p1');
  assert.equal(state.agents['expenses-agent'].prompted, true);
});

test('nothing starts when a folder lacks the kit', async () => {
  const { list } = workspace(['a', 'b'], { kit: false });
  const h = fakeHerdr();
  const r = await run([list], h);
  assert.equal(r.code, EXIT.usage);
  assert.match(r.err, /has no kit/);
  assert.ok(!h.calls.some(c => c[1] === 'create'));
});

test('a missing or stopped herdr is reported before anything starts', async () => {
  const { list } = workspace(['a']);
  assert.match((await run([list], fakeHerdr({ installed: false }))).err, /not installed or not on PATH/);
  const stopped = fakeHerdr({ running: false });
  const r = await run([list], stopped);
  assert.equal(r.code, EXIT.usage);
  assert.match(r.err, /herdr is not running/);
  assert.equal(stopped.calls.length, 1);
});

test('a CLI that stops at a question is left for the user, then prompted once with --send-prompt', async () => {
  const { list, root } = workspace(['hr-agent']);
  const h = fakeHerdr({ notReady: new Set(['hr-agent']), statuses: { 'hr-agent': 'idle' } });
  const first = await run([list], h);
  assert.equal(first.code, EXIT.ok);
  assert.match(first.out, /waiting for you/);
  assert.ok(!h.calls.some(c => c[1] === 'prompt'));

  const second = await run([list, '--send-prompt'], h);
  assert.match(second.out, /prompted/);
  assert.equal(h.calls.filter(c => c[1] === 'prompt').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), 'utf8')).agents['hr-agent'].prompted, true);

  await run([list, '--send-prompt'], h);
  assert.equal(h.calls.filter(c => c[1] === 'prompt').length, 1, 'the prompt is never sent twice');
});

test('a prompt is recorded as sent only when herdr sees the agent react to it', async () => {
  const { list, root } = workspace(['lost', 'busy', 'asking']);
  const h = fakeHerdr({ promptResult: { lost: 'stalled', busy: 'timeout', asking: 'blocked' }, statuses: { lost: 'idle' } });
  const r = await run([list], h);
  assert.equal(r.code, EXIT.ok, r.err);
  const state = JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), 'utf8')).agents;
  assert.equal(state.lost.prompted, false, 'a stalled prompt was never seen by the agent');
  assert.equal(state.busy.prompted, true, 'a timeout means the agent started working');
  assert.equal(state.asking.prompted, false);
  assert.match(r.out, /lost\s+w1:p1\s+request not confirmed/);
  assert.match(r.out, /asking\s+w3:p1\s+waiting for you/);
});

test('--status shows each agent state and flags blocked sessions', async () => {
  const { list } = workspace(['a', 'b']);
  const h = fakeHerdr({ statuses: { a: 'blocked', b: 'done' } });
  await run([list], h);
  const r = await run([list, '--status'], h);
  assert.match(r.out, /a\s+w1:p1\s+blocked/);
  assert.match(r.out, /b\s+w2:p1\s+done/);
});

test('an agent that was already started is not started again', async () => {
  const { list } = workspace(['a']);
  const h = fakeHerdr();
  await run([list], h);
  const r = await run([list], h);
  assert.equal(r.code, EXIT.usage);
  assert.match(r.err, /already started/);
});

test('--dry-run checks everything and starts nothing', async () => {
  const { list } = workspace(['a']);
  const h = fakeHerdr();
  const r = await run([list, '--dry-run', '--prompt', 'Add observability to this agent.'], h);
  assert.equal(r.code, EXIT.ok);
  assert.match(r.out, /prompt "Add observability to this agent\."/);
  assert.deepEqual(h.calls.map(c => c.slice(0, 2).join(' ')), ['workspace list']);
});

test('--install-kit copies the verified kit into a folder without one, and never overwrites', async () => {
  const { list, root } = workspace(['fresh', 'clash'], { kit: false });
  fs.writeFileSync(path.join(root, 'clash', 'agent365-kit.ps1'), 'my own file');
  const h = fakeHerdr();
  const r = await run([list, '--install-kit'], h);
  assert.equal(r.code, EXIT.partial);
  assert.ok(fs.existsSync(path.join(root, 'fresh', '.a365-kit', 'KIT-VERSION.json')));
  assert.ok(fs.existsSync(path.join(root, 'fresh', '.agents', 'skills', 'a365-setup', 'SKILL.md')));
  assert.equal(fs.readFileSync(path.join(root, 'clash', 'agent365-kit.ps1'), 'utf8'), 'my own file');
  assert.ok(!fs.existsSync(path.join(root, 'clash', '.a365-kit')));
  assert.match(r.out, /clash\s+-\s+failed: agent365-kit\.ps1 already exists/);
});

test('bad arguments are rejected', async () => {
  const h = fakeHerdr();
  assert.equal((await run([], h)).code, EXIT.usage);
  assert.equal((await run(['x.txt', '--cli', 'vim'], h)).code, EXIT.usage);
  assert.equal((await run(['x.txt', '--prompt'], h)).code, EXIT.usage);
  assert.equal((await run(['missing-file.txt'], h)).code, EXIT.usage);
});
