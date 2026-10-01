#!/usr/bin/env node
// The dev channel bypasses authentication, so most checks here are about keeping it
// off the public path. Static file checks only, with no network access and no build.

'use strict';

const path = require('path');
const { cwd, read, exists, scan, finish } = require('../lib/kit-validator');
const { readEnvValue } = require('../lib/env-config');

const issues = [];

// Maven and Gradle put sources deeper than scanProject's default maxDepth of 5.
const sourceTexts = scan(12).filter(f => /\.(py|ts|js|cs|java)$/.test(f)).map(read);
const anySource = (...patterns) => sourceTexts.some(c => patterns.every(p => c.includes(p)));

// Comment lines are dropped before any check that looks for a literal, because the
// reference module explains its own choice with "127.0.0.1, never 0.0.0.0" and a
// naive substring match would fail every correct project.
const codeOnly = text => text
  .split(/\r?\n/)
  .filter(line => !/^\s*(#|\/\/|\*|\/\*)/.test(line))
  .join('\n');

if (!anySource('A365_DEV_CHANNEL')) {
  finish([], { note: 'No dev channel found -- test-local-channel not applied to this project' });
}

if (!anySource('127.0.0.1')) {
  issues.push('The dev channel does not bind 127.0.0.1 explicitly -- an unauthenticated ' +
    'endpoint must never listen on the wildcard address');
}
const bindsWildcard = sourceTexts.some(c =>
  c.includes('A365_DEV_CHANNEL') && /["']0\.0\.0\.0["']/.test(codeOnly(c)));
if (bindsWildcard) {
  issues.push('The file wiring the dev channel binds 0.0.0.0 -- an unauthenticated ' +
    'endpoint must listen on 127.0.0.1 only');
}

// The forwarding-header refusal is the check that actually protects the endpoint.
// A loopback test alone passes tunnelled traffic, because `devtunnel host` runs on
// the developer's own machine and forwards from 127.0.0.1.
if (!anySource('x-forwarded-for') && !anySource('X-Forwarded-For')) {
  issues.push('The dev channel does not refuse requests carrying forwarding headers -- ' +
    'without this a tunnelled request reaches it looking local, because devtunnel ' +
    'forwards from 127.0.0.1. This is the check that protects the endpoint');
}

// This is the one env value in the kit that must not be true.
const envFiles = ['.env', '.env.example'].map(f => path.join(cwd, f)).filter(exists);
if (envFiles.some(f => readEnvValue(f, 'A365_DEV_CHANNEL')?.toLowerCase() === 'true')) {
  issues.push('A365_DEV_CHANNEL is set to true in .env -- the dev channel bypasses ' +
    'authentication and must be off by default, enabled per session instead');
}

if (anySource('/api/messages')) {
  const validatesInbound =
    anySource('Authorization') || anySource('authorization') ||
    anySource('jwt') || anySource('JWT') ||
    anySource('login.botframework.com');
  if (!validatesInbound) {
    issues.push('/api/messages no longer shows any inbound token validation -- the dev ' +
      'channel must be a separate listener, never a bypass on the production endpoint');
  }
}

if (!anySource('DEV CHANNEL ENABLED')) {
  issues.push('No startup warning found -- the dev channel should log loudly while it is ' +
    'enabled so it is not left on unnoticed');
}

finish(issues);
