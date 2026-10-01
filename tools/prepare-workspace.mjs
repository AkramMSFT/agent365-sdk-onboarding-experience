import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function futureRealPath(location) {
  let ancestor = path.resolve(location);
  const missing = [];
  while (!fs.existsSync(ancestor)) {
    missing.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('Destination has no accessible parent directory.');
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...missing);
}

function components(relative) {
  if (typeof relative !== 'string' || !relative || /[\\:\0]/u.test(relative)) {
    throw new Error('Invalid path in bundle manifest.');
  }
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid path in bundle manifest.');
  }
  return parts;
}

export function loadManifest(bundleRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'BUNDLE-MANIFEST.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.examples) || !Array.isArray(manifest.files)) {
    throw new Error('Unsupported or incomplete bundle manifest.');
  }
  const ids = new Set();
  for (const example of manifest.examples) {
    if (!/^[a-z0-9-]+$/u.test(example.id) || ids.has(example.id) ||
        example.path !== `examples/${example.id}`) throw new Error('Invalid example catalog.');
    ids.add(example.id);
  }
  const names = new Set();
  for (const file of manifest.files) {
    components(file.path);
    if (names.has(file.path.toLowerCase()) || !/^[a-f0-9]{64}$/u.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('Invalid file inventory.');
    names.add(file.path.toLowerCase());
  }
  return manifest;
}

export function readVerifiedFile(root, file) {
  const parts = file.path.split('/');
  let source = root;
  let info;
  for (const part of parts) {
    source = path.join(source, part);
    info = fs.lstatSync(source);
    if (info.isSymbolicLink()) throw new Error('Bundle source must not contain symbolic links.');
  }
  if (!info.isFile()) throw new Error('Bundle inventory contains a non-file.');
  const data = fs.readFileSync(source);
  if (data.length !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256) {
    throw new Error(`Bundle integrity check failed: ${file.path}`);
  }
  return { parts, data, mode: info.mode };
}

export function prepareWorkspace(bundleRoot, { example, destination }) {
  const root = fs.realpathSync(bundleRoot);
  const manifest = loadManifest(root);
  const selected = manifest.examples.find(item => item.id === example);
  if (example !== 'blank' && !selected) throw new Error('Unknown example. Use --list.');
  if (!destination) throw new Error('Provide --destination for a NEW directory outside the bundle.');
  const target = futureRealPath(destination);
  if (contains(root, target) || contains(target, root)) throw new Error('Destination must not overlap the bundle.');
  if (fs.existsSync(target)) throw new Error('Destination already exists; no files were changed. Choose a NEW directory.');

  const prefix = selected ? `${selected.path}/` : null;
  const files = manifest.files.filter(file => file.path.startsWith('kit/') || (prefix && file.path.startsWith(prefix)));
  if (!files.some(file => file.path === 'kit/.a365-kit/KIT-VERSION.json') ||
      (prefix && !files.some(file => file.path.startsWith(prefix)))) {
    throw new Error('Bundle is missing the kit or selected sample.');
  }
  const destinations = new Set();
  const copies = files.map(file => {
    const { parts, data, mode } = readVerifiedFile(root, file);
    const relative = file.path.startsWith('kit/') ? parts.slice(1) : parts.slice(2);
    const key = relative.join('/').toLowerCase();
    if (destinations.has(key)) throw new Error('Sample files conflict with kit files.');
    destinations.add(key);
    return { relative, data, mode };
  });

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(target);
  try {
    for (const { relative, data, mode } of copies) {
      const output = path.join(target, ...relative);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, data, { flag: 'wx', mode });
    }
    if (!destinations.has('.gitignore')) {
      fs.writeFileSync(path.join(target, '.gitignore'),
        '.env\n.env.*\n!.env.example\na365.generated.config.json\n.a365-workspace-detection.local.json\n',
        { flag: 'wx' });
    }
  } catch (error) {
    throw new Error(`Preparation failed; the incomplete NEW directory was left at ${target}. ${error.message}`);
  }
  return { destination: target, example, files: copies.length, bundleVersion: manifest.bundleVersion,
    onboardingSupport: selected?.onboardingSupport };
}

export function main(args = process.argv.slice(2), bundleRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))) {
  if (!args.length || args.includes('--help')) {
    console.log('node tools\\prepare-workspace.mjs --list\nnode tools\\prepare-workspace.mjs --example <id|blank> --destination <NEW directory>\nRun from the extracted bundle, not from kit\\ or an example folder. Never overwrites an existing destination.');
    return;
  }
  if (args.length === 1 && args[0] === '--list') {
    for (const item of loadManifest(bundleRoot).examples) console.log(`${item.id}: ${item.name} (${item.runtime})`);
    console.log('blank: kit only, for starting a new project or manually importing your own source');
    return;
  }
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--example', '--destination'].includes(key) || !args[index + 1] ||
        args[index + 1].startsWith('--') || Object.hasOwn(options, key.slice(2))) {
      throw new Error('Use --example <id|blank> --destination <NEW directory>. See --help.');
    }
    options[key.slice(2)] = args[index + 1];
  }
  const result = prepareWorkspace(bundleRoot, options);
  console.log(`Created ${result.example} workspace: ${result.destination}\nCopied ${result.files} files from bundle v${result.bundleVersion}.\nInstall only this sample's dependencies, then run agent365-kit.ps1 (Windows) or agent365-kit.sh from that directory.\nThe complete instructions remain in the extracted bundle's root README.md. No tenant commands were run.`);
  if (result.onboardingSupport === 'manual')
    console.log('Language boundary: this sample requires deliberate/manual Agent 365 integration. Read its README; unknown-language validator success is not onboarding proof.');
}

// Real paths on both sides, so a symlinked or junctioned launch path still counts as direct.
function launchedDirectly() {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (launchedDirectly()) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
