#!/usr/bin/env node
// Starts one herdr workspace per agent project and asks a coding CLI in each to run the
// Agent 365 onboarding, so several agents can be onboarded side by side.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, readVerifiedFile } from './prepare-workspace.mjs';

export const DEFAULT_PROMPT = 'Onboard this agent to Agent 365.';
export const STATE_FILE = '.a365-bulk-onboard.json';
export const EXIT = { ok: 0, usage: 2, partial: 3 };
const CLIS = ['copilot', 'claude'];

const HELP = `Usage: node tools/bulk-onboard.mjs <agents-file> [options]
       node tools/bulk-onboard.mjs <agents-file> --status
       node tools/bulk-onboard.mjs <agents-file> --send-prompt

  <agents-file>          One agent project folder per line. A short name may follow a comma:
                           C:\\src\\hr-agent, hr-agent
                         Blank lines and lines starting with # are ignored.
  --cli copilot|claude   CLI to start in each workspace (default: copilot).
  --prompt TEXT          What to ask each CLI (default: "${DEFAULT_PROMPT}").
  --install-kit          Copy this bundle's kit into folders that do not have it yet.
  --dry-run              Check everything and print the plan without starting anything.
  --status               Show each agent's state: working, blocked, done or idle.
  --send-prompt          Send the prompt to agents that started but were not prompted yet.

herdr must already be running: start it with "herdr" in another terminal.
Progress is recorded in ${STATE_FILE}, next to the agents file.
`;

export class UsageError extends Error {}

export function parseArgs(argv) {
  const o = { mode: 'start', cli: 'copilot', prompt: DEFAULT_PROMPT, installKit: false, dryRun: false };
  const value = (i, name) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.mode = 'help';
    else if (a === '--status') o.mode = 'status';
    else if (a === '--send-prompt') o.mode = 'send-prompt';
    else if (a === '--install-kit') o.installKit = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--cli') {
      o.cli = value(i++, a);
      if (!CLIS.includes(o.cli)) throw new UsageError(`--cli takes ${CLIS.join(' or ')}`);
    }
    else if (a === '--prompt') {
      o.prompt = value(i++, a);
      if (!o.prompt.trim()) throw new UsageError('--prompt cannot be empty');
    }
    else if (a.startsWith('--')) throw new UsageError(`Unknown option: ${a}`);
    else if (o.listFile) throw new UsageError('Give one agents file.');
    else o.listFile = a;
  }
  if (o.mode !== 'help' && !o.listFile) throw new UsageError('Give the agents file. See --help.');
  return o;
}

export function agentName(raw) {
  const n = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '') || 'agent';
  return n.slice(0, 32).replace(/-+$/, '');
}

export function readAgents(listFile) {
  if (!fs.existsSync(listFile)) throw new UsageError(`Agents file not found: ${listFile}`);
  const base = path.dirname(path.resolve(listFile));
  const agents = [];
  const used = new Set();
  for (const [index, line] of fs.readFileSync(listFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    // A quoted folder may itself contain a comma, so split after the closing quote.
    const quoted = text.match(/^"([^"]*)"\s*(?:,(.*))?$/);
    const comma = text.lastIndexOf(',');
    const [folder, label] = quoted ? [quoted[1], quoted[2]]
      : comma > 0 ? [text.slice(0, comma).trim(), text.slice(comma + 1)] : [text, undefined];
    const dir = path.resolve(base, folder);
    let name = agentName(label !== undefined ? label.trim() : path.basename(dir));
    if (used.has(name)) {
      let n = 2;
      while (used.has(`${name.slice(0, 29)}-${n}`)) n++;
      name = `${name.slice(0, 29)}-${n}`;
    }
    used.add(name);
    agents.push({ name, dir, line: index + 1 });
  }
  if (!agents.length) throw new UsageError('The agents file lists no folders.');
  return agents;
}

function herdrRunner(args) {
  const r = spawnSync('herdr', args, { encoding: 'utf8', timeout: 330_000 });
  if (r.error) return { code: 127, stdout: '', stderr: r.error.message };
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function json(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function herdrError(result) {
  const body = json(result.stderr) ?? json(result.stdout);
  return { code: body?.error?.code ?? `exit_${result.code}`, message: body?.error?.message ?? (result.stderr || result.stdout).trim() };
}

// herdr can report a CLI as ready while it is still updating itself, and text typed then is
// lost. With --wait, herdr fails with agent_prompt_stalled when the agent shows no activity
// within five seconds, and times out only after activity was seen.
export function sendPrompt(herdr, name, prompt) {
  const r = herdr(['agent', 'prompt', name, prompt, '--wait', '--timeout', '30000']);
  if (r.code === 0) return { sent: true };
  const e = herdrError(r);
  if (e.code === 'timeout') return { sent: true };
  if (e.code === 'agent_prompt_stalled') return { sent: false, note: 'request not confirmed; check the session, then --send-prompt' };
  if (e.code === 'agent_blocked') return { sent: false, note: 'waiting for you; answer it in herdr, then --send-prompt' };
  return { sent: false, failed: true, note: `prompt failed: ${e.message}` };
}

function kitInstalled(dir) {
  return fs.existsSync(path.join(dir, '.a365-kit', 'KIT-VERSION.json'));
}

// The same integrity rule as prepare-workspace.mjs: every kit file must match the manifest.
export function verifiedKit(bundleRoot) {
  return loadManifest(bundleRoot).files.filter(f => f.path.startsWith('kit/')).map(f => readVerifiedFile(bundleRoot, f));
}

export function installKit(kit, dir) {
  const plan = kit.map(({ parts, data }) => ({ out: path.join(dir, ...parts.slice(1)), data }));
  const clash = plan.find(p => fs.existsSync(p.out));
  if (clash) throw new Error(`${path.relative(dir, clash.out)} already exists; nothing was copied into ${dir}.`);
  for (const p of plan) {
    fs.mkdirSync(path.dirname(p.out), { recursive: true });
    fs.writeFileSync(p.out, p.data, { flag: 'wx' });
  }
  return plan.length;
}

function statePath(listFile) {
  return path.join(path.dirname(path.resolve(listFile)), STATE_FILE);
}

function loadState(listFile) {
  const p = statePath(listFile);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { agents: {} };
}

function saveState(listFile, state) {
  fs.writeFileSync(statePath(listFile), JSON.stringify(state, null, 2) + '\n');
}

function table(log, rows) {
  const w = [Math.max(5, ...rows.map(r => r[0].length)), Math.max(6, ...rows.map(r => r[1].length))];
  log(`${'Agent'.padEnd(w[0])}  ${'Pane'.padEnd(w[1])}  State`);
  for (const r of rows) log(`${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2]}`);
}

export async function main(argv, deps = {}) {
  const log = deps.log ?? (s => process.stdout.write(s + '\n'));
  const err = deps.err ?? (s => process.stderr.write(s + '\n'));
  const herdr = deps.herdr ?? herdrRunner;
  const bundleRoot = deps.bundleRoot ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  try {
    const o = parseArgs(argv);
    if (o.mode === 'help') { log(HELP); return EXIT.ok; }
    const agents = readAgents(o.listFile);
    const state = loadState(o.listFile);

    if (o.mode === 'status' || o.mode === 'send-prompt') {
      const rows = [];
      let failed = 0;
      for (const a of agents) {
        const s = state.agents[a.name];
        if (!s?.pane) { rows.push([a.name, '-', 'not started']); continue; }
        const got = herdr(['agent', 'get', a.name]);
        const status = got.code === 0 ? json(got.stdout)?.result?.agent?.agent_status ?? 'unknown' : 'not running';
        if (o.mode === 'send-prompt' && !s.prompted && (status === 'idle' || status === 'done')) {
          const sent = sendPrompt(herdr, a.name, o.prompt);
          if (sent.sent) { s.prompted = true; saveState(o.listFile, state); rows.push([a.name, s.pane, 'prompted']); continue; }
          failed++;
          rows.push([a.name, s.pane, sent.note]);
          continue;
        }
        const note = !s.prompted && status === 'blocked' ? ' (answer it in herdr, then --send-prompt)' : '';
        rows.push([a.name, s.pane, `${status}${s.prompted ? '' : ', not prompted'}${note}`]);
      }
      table(log, rows);
      return failed ? EXIT.partial : EXIT.ok;
    }

    const problems = [];
    for (const a of agents) {
      if (!fs.existsSync(a.dir) || !fs.statSync(a.dir).isDirectory()) problems.push(`line ${a.line}: ${a.dir} is not a folder`);
      else if (!kitInstalled(a.dir) && !o.installKit) problems.push(`line ${a.line}: ${a.dir} has no kit (add --install-kit, or extract the kit there first)`);
      if (state.agents[a.name]?.pane) problems.push(`line ${a.line}: ${a.name} was already started (see --status)`);
    }
    const probe = herdr(['workspace', 'list']);
    if (probe.code !== 0) {
      problems.push(probe.code === 127
        ? 'herdr is not installed or not on PATH. See docs/BULK-ONBOARDING.md.'
        : 'herdr is not running. Start it with "herdr" in another terminal, then run this again.');
    }
    if (problems.length) { for (const p of problems) err(p); err('Nothing was started.'); return EXIT.usage; }

    if (o.dryRun) {
      for (const a of agents) {
        log(`${a.name}: ${kitInstalled(a.dir) ? '' : 'install kit, '}workspace in ${a.dir}, start ${o.cli}, prompt "${o.prompt}"`);
      }
      log('Dry run: nothing was started.');
      return EXIT.ok;
    }

    const rows = [];
    let failed = 0;
    let kit;
    for (const a of agents) {
      const record = { dir: a.dir, cli: o.cli, prompted: false };
      try {
        if (!kitInstalled(a.dir)) installKit((kit ??= verifiedKit(bundleRoot)), a.dir);
        const created = herdr(['workspace', 'create', '--cwd', a.dir, '--label', a.name, '--no-focus']);
        if (created.code !== 0) throw new Error(`workspace: ${herdrError(created).message}`);
        const result = json(created.stdout)?.result;
        record.workspace = result?.workspace?.workspace_id;
        record.pane = result?.root_pane?.pane_id;
        if (!record.pane) throw new Error('herdr did not return a pane id');
        state.agents[a.name] = record;

        const started = herdr(['agent', 'start', a.name, '--kind', o.cli, '--pane', record.pane, '--timeout', '120000']);
        if (started.code !== 0) {
          const e = herdrError(started);
          rows.push([a.name, record.pane, e.code === 'agent_not_ready'
            ? 'waiting for you (for example a folder trust question); then --send-prompt'
            : `CLI did not start: ${e.message}`]);
          if (e.code !== 'agent_not_ready') failed++;
          continue;
        }
        const sent = sendPrompt(herdr, a.name, o.prompt);
        if (!sent.sent) {
          if (sent.failed) failed++;
          rows.push([a.name, record.pane, sent.note]);
          continue;
        }
        record.prompted = true;
        rows.push([a.name, record.pane, 'onboarding started']);
      } catch (e) {
        failed++;
        rows.push([a.name, record.pane ?? '-', `failed: ${e.message}`]);
      } finally {
        saveState(o.listFile, state);
      }
    }
    table(log, rows);
    log('');
    log('Attach with "herdr" to follow every onboarding. A blocked session is waiting for your answer.');
    log('Check progress any time with --status.');
    return failed ? EXIT.partial : EXIT.ok;
  } catch (e) {
    err(e.message);
    return EXIT.usage;
  }
}

// Real paths on both sides, so a symlinked or junctioned launch path still counts as direct.
function launchedDirectly() {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (launchedDirectly()) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
