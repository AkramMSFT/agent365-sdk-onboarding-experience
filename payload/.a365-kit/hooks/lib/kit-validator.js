'use strict';

// Shared plumbing for the kit's own stop-hook validators. A stop hook has 15 seconds,
// so every file is read at most once and the project tree is walked once per depth.

const fs = require('fs');
const path = require('path');
const { scanProject, filterByName } = require('./project-scan');

const cwd = process.cwd();
const texts = new Map();
const scans = new Map();

function read(file) {
  let text = texts.get(file);
  if (text === undefined) {
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
    texts.set(file, text);
  }
  return text;
}

function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}

function scan(maxDepth = 5) {
  if (!scans.has(maxDepth)) scans.set(maxDepth, scanProject(cwd, { maxDepth }));
  return scans.get(maxDepth);
}

// The detection object is returned as well, because the messaging-endpoint validator
// stops early for AI Teammates.
function detect() {
  let detection;
  let language = '';
  try {
    detection = JSON.parse(read(path.join(cwd, '.a365-workspace-detection.local.json')));
    language = String(detection.programmingLanguage || '').toLowerCase();
  } catch { /* no detection cache */ }
  if (!language) {
    if (exists(path.join(cwd, 'pyproject.toml')) || exists(path.join(cwd, 'requirements.txt'))) language = 'python';
    else if (exists(path.join(cwd, 'package.json'))) language = 'nodejs';
    else if (filterByName(scan(), '.csproj').length) language = 'dotnet';
  }
  return { language, detection };
}

function finish(issues, okExtra) {
  if (issues.length) {
    process.stdout.write(JSON.stringify({ ok: false, reason: issues.join('; ') }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ ok: true, ...okExtra }));
  process.exit(0);
}

module.exports = { cwd, read, exists, scan, detect, finish, filterByName };
