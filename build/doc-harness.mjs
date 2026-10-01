// Shared by the tests that run code blocks from the kit's shared notes. Not a test file
// itself, so `node --test build/test-*.mjs` does not pick it up.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

export const kit = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kit', '.a365-kit');
export const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Returns a function that finds the one code block of a language containing a marker. */
export function noteBlocks(noteName) {
  const note = fs.readFileSync(path.join(kit, 'shared', noteName), 'utf8').replace(/\r\n/g, '\n');
  return (language, marker) => {
    const found = [...note.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g'))]
      .map(m => m[1]).filter(code => code.includes(marker));
    assert.equal(found.length, 1, `expected one ${language} block containing ${marker}`);
    return found[0];
  };
}

export function workdir(prefix, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

export function run(command, args, cwd, timeout = 60_000) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout });
  assert.equal(r.status, 0, `${command} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
