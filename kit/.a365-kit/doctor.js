#!/usr/bin/env node
// Prerequisite check shared by agent365-kit.ps1 (Windows) and agent365-kit.sh (macOS/Linux).
// Exits 1 only when a required prerequisite is missing.

'use strict';

const { exec } = require('child_process');

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const quiet = args.has('--quiet');

const isWin = process.platform === 'win32';
const PROBE_TIMEOUT_MS = 20000;

// Resolves to { output, timedOut }, where output is the trimmed stdout or null on failure.
// On Windows exec's timeout kills cmd.exe, but a grandchild can keep the pipes open and
// the callback waiting, so a second deadline also gives up on the pipes.
function run(cmd) {
  return new Promise(resolve => {
    let child;
    let settled = false;
    const finish = (output, timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ output, timedOut });
    };
    const deadline = setTimeout(() => {
      if (child) {
        child.kill('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      finish(null, true);
    }, PROBE_TIMEOUT_MS + 250);
    try {
      child = exec(cmd, {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
      }, (error, stdout) => finish(error ? null : stdout.trim(), Boolean(error && error.killed)));
      // A probe that prompts reads end of input instead of waiting for an answer.
      child.stdin.end();
    } catch {
      finish(null, false);
    }
  });
}

const probe = cmd => run(cmd).then(result => result.output);
const onPath = name => probe(isWin ? `where ${name}` : `command -v ${name}`);

// Both az probes share one CLI and its state directory, so they never overlap.
let azVersionRun;
const azVersion = () => (azVersionRun ??= run('az version'));

function firstVersion(text) {
  if (!text) return null;
  const m = text.match(/\d+\.\d+(\.\d+)?/);
  return m ? m[0] : null;
}

function majorOf(version) {
  if (!version) return -1;
  return parseInt(version.split('.')[0], 10);
}

// Required checks block onboarding. Optional ones matter only for some agent
// stacks or later phases.
const CHECKS = [
  {
    key: 'node',
    label: 'Node.js 18+',
    required: true,
    why: 'Runs the skill validators bundled with this kit.',
    probe: () => process.version.replace(/^v/, ''),
    ok: v => majorOf(v) >= 18,
    install: isWin
      ? 'winget install --id OpenJS.NodeJS.LTS -e'
      : 'brew install node   # or https://nodejs.org',
  },
  {
    key: 'ai_cli',
    label: 'An AI coding CLI',
    required: true,
    why: 'Reads the skills and drives the onboarding. Any one of these is enough.',
    probe: async () => {
      const found = await Promise.all([
        probe('claude --version').then(out => out && 'Claude Code'),
        // gh copilot is only the fallback for a missing copilot CLI.
        onPath('copilot').then(out => (out ? 'Copilot CLI'
          : probe('gh copilot --help').then(gh => gh && 'Copilot CLI (via gh)'))),
        onPath('cursor-agent').then(out => out && 'Cursor'),
        onPath('codex').then(out => out && 'Codex'),
        onPath('gemini').then(out => out && 'Gemini CLI'),
      ]);
      const names = found.filter(Boolean);
      return names.length ? names.join(', ') : null;
    },
    ok: v => !!v,
    install: 'pick one -- Copilot: npm install -g @github/copilot   |   '
      + 'Claude Code: npm install -g @anthropic-ai/claude-code   |   '
      + 'Cursor / Codex / Gemini CLI: install per their docs',
  },
  {
    key: 'dotnet',
    label: '.NET SDK 8+',
    required: true,
    why: 'The a365 CLI ships as a .NET global tool. SDK, not just runtime.',
    probe: () => probe('dotnet --version').then(firstVersion),
    ok: v => majorOf(v) >= 8,
    install: isWin
      ? 'winget install --id Microsoft.DotNet.SDK.8 -e'
      : 'brew install --cask dotnet-sdk   # or https://dot.net/download',
  },
  {
    key: 'a365',
    label: 'a365 CLI',
    required: true,
    why: 'Creates the Agent 365 Blueprint and Entra identity for your agent.',
    probe: () => probe('a365 --version').then(firstVersion),
    ok: v => !!v,
    install: 'dotnet tool install -g Microsoft.Agents.A365.DevTools.Cli',
  },
  {
    key: 'az',
    label: 'Azure CLI',
    required: true,
    why: 'Tenant sign-in and Entra app registration.',
    probe: () => azVersion().then(result => firstVersion(result.output)),
    ok: v => !!v,
    install: isWin
      ? 'winget install --id Microsoft.AzureCLI -e'
      : 'brew install azure-cli',
  },
  {
    key: 'azlogin',
    label: 'Azure CLI signed in',
    required: false,
    why: 'Setup needs an authenticated tenant context.',
    // Masked: this often runs on a screen share during a customer demo.
    probe: async () => {
      // An az that did not answer `az version` in time would only use up a second deadline.
      if ((await azVersion()).timedOut) return null;
      const tenant = await probe('az account show --query tenantId -o tsv');
      return tenant ? tenant.slice(0, 8) + '-...' : null;
    },
    ok: v => !!v,
    install: 'az login --allow-no-subscriptions',
  },
  {
    key: 'git',
    label: 'Git',
    required: true,
    why: 'Used to scaffold starter agents from Agent365-Samples.',
    probe: () => probe('git --version').then(firstVersion),
    ok: v => !!v,
    install: isWin ? 'winget install --id Git.Git -e' : 'brew install git',
  },
  {
    key: 'pwsh',
    label: 'PowerShell 7+',
    required: false,
    why: 'Some a365 setup fallbacks emit PowerShell for an admin to run.',
    probe: () => probe('pwsh --version').then(firstVersion),
    ok: v => majorOf(v) >= 7,
    install: isWin
      ? 'winget install --id Microsoft.PowerShell -e'
      : 'brew install --cask powershell',
  },
  {
    key: 'python',
    label: 'Python 3.10+',
    required: false,
    why: 'Only for Python agents (LangChain, OpenAI Agents SDK, Google ADK).',
    probe: () => probe(isWin ? 'python --version' : 'python3 --version').then(firstVersion),
    ok: v => {
      if (!v) return false;
      const parts = v.split('.').map(Number);
      return parts[0] > 3 || (parts[0] === 3 && parts[1] >= 10);
    },
    install: isWin
      ? 'winget install --id Python.Python.3.12 -e'
      : 'brew install python@3.12',
  },
];

async function runCheck(check) {
  let value = null;
  try { value = await check.probe(); } catch { value = null; }
  return {
    key: check.key,
    label: check.label,
    required: check.required,
    why: check.why,
    value,
    passed: check.ok(value),
    install: check.install,
  };
}

function report(results) {
  const missingRequired = results.filter(r => r.required && !r.passed);
  const missingOptional = results.filter(r => !r.required && !r.passed);

  if (asJson) {
    process.stdout.write(JSON.stringify({
      ok: missingRequired.length === 0,
      platform: process.platform,
      results,
    }, null, 2) + '\n');
    process.exit(missingRequired.length === 0 ? 0 : 1);
  }

  const ESC = String.fromCharCode(27);
  const GREEN = ESC + '[32m';
  const RED = ESC + '[31m';
  const YELLOW = ESC + '[33m';
  const DIM = ESC + '[2m';
  const BOLD = ESC + '[1m';
  const RESET = ESC + '[0m';

  const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const paint = (code, text) => (useColor ? code + text + RESET : text);

  console.log('');
  console.log(paint(BOLD, 'Agent 365 Onboarding Kit -- prerequisite check'));
  console.log('');

  const width = results.reduce((max, r) => Math.max(max, r.label.length), 0);

  for (const r of results) {
    if (quiet && r.passed) continue;
    let mark;
    if (r.passed) mark = paint(GREEN, ' ok ');
    else if (r.required) mark = paint(RED, 'MISS');
    else mark = paint(YELLOW, 'opt ');
    const detail = paint(DIM, r.passed ? (r.value || '') : r.why);
    console.log('  [' + mark + '] ' + r.label.padEnd(width) + '  ' + detail);
  }

  if (missingRequired.length || missingOptional.length) {
    console.log('');
    console.log(paint(BOLD, 'To install what is missing:'));
    console.log('');
    for (const r of missingRequired.concat(missingOptional)) {
      const tag = r.required ? paint(RED, 'required') : paint(YELLOW, 'optional');
      console.log('  ' + r.label + ' (' + tag + ')');
      console.log(paint(DIM, '      ' + r.install));
    }
  }

  console.log('');
  if (missingRequired.length === 0) {
    console.log(paint(GREEN, '  All required prerequisites are present.'));
    console.log('');
    process.exit(0);
  }

  const n = missingRequired.length;
  console.log(paint(RED, '  ' + n + ' required prerequisite' + (n === 1 ? '' : 's') +
    ' missing -- install, then re-run.'));
  console.log('');
  process.exit(1);
}

// Probes run in parallel; Promise.all keeps the results in CHECKS order.
Promise.all(CHECKS.map(runCheck)).then(report);
