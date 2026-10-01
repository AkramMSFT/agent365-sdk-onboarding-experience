// Fails when an example's dependency files point anywhere but the public registries,
// so a clone installs on any machine and no private feed name is published.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
// The files the bundle ships: tracked or new, never ignored, so local installs such as deps/ are skipped.
const files = execFileSync('git', ['-C', repo, '-c', 'core.quotepath=off', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'examples'], { encoding: 'utf8' })
  .split('\0').filter(Boolean).filter(rel => fs.existsSync(path.join(repo, rel)));

for (const rel of files) {
  const name = path.posix.basename(rel).toLowerCase();
  const text = fs.readFileSync(path.join(repo, rel), 'utf8');

  if (name === 'package-lock.json') {
    for (const [key, pkg] of Object.entries(JSON.parse(text).packages ?? {})) {
      if (pkg.resolved && !pkg.resolved.startsWith('https://registry.npmjs.org/')) problems.push(`${rel}: ${key} resolves from ${new URL(pkg.resolved).host}`);
      if (pkg.integrity && !pkg.integrity.startsWith('sha512-')) problems.push(`${rel}: ${key} has a weak integrity hash`);
    }
  } else if (name === 'cargo.lock') {
    for (const m of text.matchAll(/^source = "([^"]+)"/gm)) {
      if (m[1] !== 'registry+https://github.com/rust-lang/crates.io-index') problems.push(`${rel}: source ${m[1]}`);
    }
  } else if (/^requirements.*\.txt$/.test(name) || name === 'pyproject.toml' || name === 'pip.conf' || name === 'pip.ini') {
    for (const m of text.matchAll(/(--(?:extra-)?index-url|--trusted-host|index-url\s*=)\s*\S*/g)) problems.push(`${rel}: ${m[0]}`);
  } else if (name === 'nuget.config') {
    for (const m of text.matchAll(/<add\s+[^>]*value="(https?:[^"]+)"/g)) {
      if (!m[1].startsWith('https://api.nuget.org/')) problems.push(`${rel}: NuGet source ${m[1]}`);
    }
  } else if (name === 'pom.xml') {
    for (const m of text.matchAll(/<url>(https?:[^<]+)<\/url>/g)) {
      if (/\/(repository|maven|artifactory|nexus|_packaging)\b/i.test(m[1]) && !m[1].startsWith('https://repo.maven.apache.org/')) problems.push(`${rel}: repository ${m[1]}`);
    }
  } else if (name === '.npmrc' || name === '.yarnrc' || name === '.yarnrc.yml') {
    problems.push(`${rel}: registry configuration file in an example`);
  }

  if (/\.(json|txt|toml|xml|lock|config|mod|sum)$/i.test(rel) && /pkgs\.(dev\.azure|visualstudio)\.com|packagefeedproxy|\/_packaging\//i.test(text)) {
    problems.push(`${rel}: private package feed URL`);
  }
}

if (problems.length) {
  console.error(`${problems.length} example dependency problem(s):\n  ${[...new Set(problems)].join('\n  ')}`);
  process.exit(1);
}
console.log('example dependencies resolve from public registries only');
