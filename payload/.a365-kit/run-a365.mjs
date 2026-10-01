import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import {
  ADMIN_ACTION_EXIT_CODE, createConsentDetector, observabilityConsentGuidance
} from './lib/observability-consent.mjs';

const help = [
  'Usage: node .a365-kit/run-a365.mjs setup <subcommand> [a365 options]',
  'Forwards setup arguments and output to the installed a365 CLI; stdin is inherited.',
  'The maven-prod OtelWrite admin handoff prints the grant command and the access-package alternative.',
  'A nonzero CLI exit code is preserved. If the CLI exits 0 with that handoff, this runner exits 2 (admin action pending).',
  'No tenant operation is retried and no generated/local files are changed by this runner.',
  'Use --explain-observability-consent to print the recovery steps without running a365.',
  'The runner pipes CLI output for detection; CLI behavior that depends on a TTY may differ.'
].join('\n') + '\n';

export async function runA365(args, { start = spawn, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    stdout.write(help);
    return 0;
  }
  if (args.length === 1 && args[0] === '--explain-observability-consent') {
    stdout.write(observabilityConsentGuidance());
    return 0;
  }
  if (args[0] !== 'setup') {
    stderr.write('This runner only forwards a365 setup commands. Use the installed a365 CLI directly for other operations.\n');
    return 1;
  }
  return new Promise(resolve => {
    const detector = createConsentDetector();
    const child = start(process.platform === 'win32' ? 'a365.exe' : 'a365', args,
      { stdio: ['inherit', 'pipe', 'pipe'], shell: false });
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let launchFailed = false;
    let interrupted = null;
    const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
      interrupted = signal;
      child.kill(signal);
    }]));
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    child.stdout.on('data', chunk => {
      stdout.write(chunk);
      detector.accept(outDecoder.write(chunk));
    });
    child.stderr.on('data', chunk => {
      stderr.write(chunk);
      detector.accept(errDecoder.write(chunk));
    });
    child.once('error', error => {
      launchFailed = true;
      stderr.write(`Could not start the installed a365 CLI (${error.code ?? error.name}). Verify the CLI installation and PATH.\n`);
    });
    child.once('close', (code, signal) => {
      for (const [name, handler] of signalHandlers) process.removeListener(name, handler);
      detector.accept(outDecoder.end() + errDecoder.end());
      if (detector.pending) stderr.write('\n' + observabilityConsentGuidance());
      if (launchFailed) resolve(1);
      else if (interrupted || signal) {
        stderr.write(`a365 setup ended due to ${interrupted ?? signal}; setup is not confirmed complete.\n`);
        resolve((interrupted ?? signal) === 'SIGINT' ? 130 : 143);
      } else if (typeof code !== 'number') {
        stderr.write('a365 setup ended without an exit status; setup is not confirmed complete.\n');
        resolve(1);
      } else resolve(code === 0 && detector.pending ? ADMIN_ACTION_EXIT_CODE : code);
    });
  });
}

// Node resolves the main module through symlinks and junctions but leaves argv[1] as
// typed, so both sides are compared as real paths.
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) &&
      fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await runA365(process.argv.slice(2));
}
