#!/usr/bin/env node
// Static checks that the lab-tools module exists, is appended to the agent's tools
// rather than replacing them and, when the web group is present, that fetch_url keeps
// its guards.

'use strict';

const { read, scan, detect, finish, filterByName } = require('../lib/kit-validator');

const issues = [];
const { language } = detect();
const all = scan();
const modulePattern = { python: /lab_tools\.py$/, nodejs: /lab[_-]?[Tt]ools\.(ts|js|mjs)$/, dotnet: /LabTools\.cs$/ }[language];
const moduleFiles = modulePattern ? all.filter(f => modulePattern.test(f)) : [];

if (!moduleFiles.length) {
  issues.push('no lab-tools module found (expected lab_tools.py / labTools.ts / LabTools.cs) -- add-lab-tools did not create it');
} else {
  const modText = moduleFiles.map(read).join('\n');
  const known = ['fetch_url', 'fetchUrl', 'FetchUrl', 'encode_text', 'encodeText', 'EncodeText',
                 'hash_text', 'hashText', 'HashText', 'transform_text', 'transformText', 'TransformText'];
  if (!known.some(n => modText.includes(n))) {
    issues.push('lab-tools module exists but defines none of the expected tools');
  }
  const hasWeb = /fetch_url|fetchUrl|FetchUrl/.test(modText);
  if (hasWeb) {
    const guarded = /timeout|Timeout|TIMEOUT/.test(modText)
      && /https?:\/\/|startswith\(.http|StartsWith\("http|\^https\?/.test(modText)
      && /MAX_FETCH|MaxFetch|slice\(|\[:_?MAX|\[\.\.MaxFetch/.test(modText);
    if (!guarded) {
      issues.push('fetch_url is present but missing one of its guards (http/https-only, timeout, size cap) -- see the reference');
    }
  }
}

function agentFiles() {
  switch (language) {
    case 'python': return filterByName(all, '.py').filter(f => /tools\s*=\s*\[/.test(read(f)));
    case 'nodejs': return all.filter(f => /\.(ts|js|mjs)$/.test(f) && /tools\s*:\s*\[/.test(read(f)));
    case 'dotnet': return filterByName(all, '.cs').filter(f => /AIFunctionFactory|Tools\s*=|AddAgent/.test(read(f)));
    default: return [];
  }
}

const agentText = agentFiles().map(read).join('\n');
if (!/LAB_TOOLS|labTools|LabTools/.test(agentText)) {
  issues.push('the lab tools are not imported into the agent -- append them to the agent tools list (do not replace the existing tools)');
} else if (language === 'python' && /tools\s*=\s*\[[^\]]*\]/.test(agentText)) {
  // Guard against a wholesale replacement: the built-in tools should still be listed.
  const m = agentText.match(/tools\s*=\s*\[([^\]]*)\]/);
  if (m && /LAB_TOOLS/.test(m[1]) && !/get_policy|look_up|_report/.test(m[1]) && !/\*/.test(m[1])) {
    console.warn('[validate-add-lab-tools] Warning: the tools list references LAB_TOOLS but not the original tools -- confirm they were appended, not replaced');
  }
}

finish(issues);
