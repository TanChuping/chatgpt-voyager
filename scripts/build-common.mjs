import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';

export const BUILD_TARGETS = Object.freeze(['chrome', 'edge', 'firefox', 'safari']);

export function parseBuildArguments(argv, { edgeOnly = false } = {}) {
  let targets = edgeOnly ? ['edge'] : [...BUILD_TARGETS];
  let fromChrome = false;
  let help = false;
  const viteArgs = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') {
      viteArgs.push(...argv.slice(index + 1));
      break;
    }
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--from-chrome') {
      if (!edgeOnly) throw new Error('--from-chrome is only available with build:edge.');
      fromChrome = true;
    } else if (arg === '--platforms' || arg.startsWith('--platforms=')) {
      if (edgeOnly) throw new Error('Use build:all -- --platforms to select multiple targets.');
      const value = arg === '--platforms' ? argv[++index] : arg.slice('--platforms='.length);
      if (!value) throw new Error('--platforms requires a comma-separated target list.');
      const requested = value.split(',').map((target) => target.trim());
      if (requested.some((target) => !BUILD_TARGETS.includes(target))) {
        throw new Error(`Unknown platform in ${value}; use ${BUILD_TARGETS.join(',')}.`);
      }
      targets = BUILD_TARGETS.filter((target) => requested.includes(target));
    } else {
      viteArgs.push(arg);
    }
  }
  if (fromChrome && viteArgs.length) {
    throw new Error('--from-chrome does not compile; remove Vite build arguments.');
  }
  // These options would invalidate the known output directories or never finish.
  for (const arg of viteArgs) {
    if (/^(?:--config|--outDir|--out-dir|--watch)(?:=|$)/.test(arg) || arg === '-c' || arg === '-w') {
      throw new Error(`${arg} is not supported by the multi-target builder; use the platform's Vite command directly.`);
    }
  }
  return { targets, fromChrome, help, viteArgs };
}

export function runViteBuild(root, platform, viteArgs = []) {
  if (!['chrome', 'firefox', 'safari'].includes(platform)) {
    throw new Error(`No independent Vite build exists for ${platform}.`);
  }
  const vite = path.join(root, 'node_modules/vite/bin/vite.js');
  if (!fs.existsSync(vite)) throw new Error('Vite is not installed. Install the project dependencies first.');
  console.log(`[build] Compiling ${platform}`);
  const result = spawnSync(
    process.execPath,
    [vite, 'build', '--config', `vite.config.${platform}.ts`, ...viteArgs],
    { cwd: root, env: process.env, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${platform} compilation failed (${result.signal ?? result.status ?? 'unknown exit'}).`);
  }
}

export function listBuildFiles(directory, relative = '') {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Build output contains a symbolic link: ${name}`);
    if (entry.isDirectory()) files.push(...listBuildFiles(absolute, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unsupported build output entry: ${name}`);
  }
  return files;
}

function localManifestReferences(manifest) {
  const refs = [];
  const add = (value) => { if (typeof value === 'string') refs.push(value); };
  const addIcons = (icons) => {
    if (typeof icons === 'string') add(icons);
    else if (icons && typeof icons === 'object') Object.values(icons).forEach(add);
  };
  add(manifest.background?.service_worker);
  manifest.background?.scripts?.forEach(add);
  add(manifest.action?.default_popup);
  add(manifest.options_page);
  add(manifest.options_ui?.page);
  add(manifest.devtools_page);
  addIcons(manifest.icons);
  addIcons(manifest.action?.default_icon);
  Object.values(manifest.chrome_url_overrides ?? {}).forEach(add);
  manifest.sandbox?.pages?.forEach(add);
  for (const script of manifest.content_scripts ?? []) {
    script.js?.forEach(add);
    script.css?.forEach(add);
  }
  for (const resource of manifest.web_accessible_resources ?? []) {
    if (typeof resource === 'string') add(resource);
    else resource.resources?.forEach(add);
  }
  if (manifest.default_locale) add(`_locales/${manifest.default_locale}/messages.json`);
  return [...new Set(refs)];
}

export function validateChromeBuild(root) {
  const directory = path.join(root, 'dist_chrome');
  const manifestPath = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('dist_chrome/manifest.json is missing; build Chrome before using --from-chrome.');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (!manifest || manifest.manifest_version !== 3 || typeof manifest.name !== 'string') {
    throw new Error('dist_chrome/manifest.json is not a valid Chrome MV3 build manifest.');
  }
  if (manifest.version !== version || !/^\d+(?:\.\d+){0,3}$/.test(version)) {
    throw new Error('Chrome manifest version does not match package.json; rebuild Chrome first.');
  }
  const files = listBuildFiles(directory);
  for (const reference of localManifestReferences(manifest)) {
    const normalized = reference.replace(/^\/+/, '');
    if (!normalized || normalized.split('/').includes('..') || normalized.includes('\\') || normalized.includes(':')) {
      throw new Error(`Invalid local build reference: ${reference}`);
    }
    // Resource globs declare permitted paths; a valid build may contain no match
    // (the current manifest permits assets/*.png even when Vite emits only SVGs).
    if (normalized.includes('*')) continue;
    if (!files.includes(normalized)) {
      throw new Error(`Chrome build is incomplete; missing manifest resource: ${reference}`);
    }
  }
  return { directory, manifest, version, files };
}

/** Roll back ordinary I/O failures; retained backup paths identify crash recovery artifacts. */
export function replacePreparedOutputs(pairs, { rename = fs.renameSync } = {}) {
  const changes = [];
  try {
    for (const { prepared, destination } of pairs) {
      const change = { prepared, destination, backup: `${destination}.previous-${randomUUID()}`, saved: false, installed: false };
      changes.push(change);
      if (fs.existsSync(destination)) {
        rename(destination, change.backup);
        change.saved = true;
      }
      rename(prepared, destination);
      change.installed = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const change of changes.reverse()) {
      try {
        if (change.installed) fs.rmSync(change.destination, { recursive: true, force: true });
        if (change.saved) rename(change.backup, change.destination);
      } catch (rollbackError) {
        rollbackErrors.push(new Error(`Restore ${change.backup} to ${change.destination}: ${rollbackError.message}`));
      }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'Output replacement failed; preserved backups require recovery.');
    throw error;
  }
  for (const change of changes) {
    if (change.saved) {
      try { fs.rmSync(change.backup, { recursive: true, force: true }); }
      catch { console.warn(`[build] Completed; remove old backup when possible: ${change.backup}`); }
    }
  }
}

export async function prepareEdgeBuild(root, { replace = replacePreparedOutputs } = {}) {
  const { directory, manifest, version } = validateChromeBuild(root);
  const destination = path.join(root, 'dist_edge');
  const zipPath = path.join(root, `voyager-edge-v${version}.zip`);
  const stage = fs.mkdtempSync(path.join(root, '.edge-build-'));
  const stagedZip = `${stage}.zip`;
  try {
    fs.cpSync(directory, stage, { recursive: true });
    const edgeManifest = { ...manifest };
    delete edgeManifest.key;
    fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(edgeManifest, null, 2)}\n`);
    const zip = new JSZip();
    for (const file of listBuildFiles(stage)) {
      const absolute = path.join(stage, file);
      zip.file(file, fs.readFileSync(absolute), { date: fs.statSync(absolute).mtime });
    }
    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    fs.writeFileSync(stagedZip, archive);
    replace([{ prepared: stage, destination }, { prepared: stagedZip, destination: zipPath }]);
    console.log(`[build] Edge ready: ${destination}`);
    console.log(`[build] Edge archive: ${zipPath}`);
    return { directory: destination, zipPath };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(stagedZip, { force: true });
  }
}

/** Edge depends on exactly one fresh Chrome build in this invocation. */
export async function buildTargets(root, targets, {
  viteArgs = [], fromChrome = false, compile = runViteBuild, edge = prepareEdgeBuild,
} = {}) {
  if (!targets.length || targets.some((target) => !BUILD_TARGETS.includes(target))) {
    throw new Error(`Select at least one of ${BUILD_TARGETS.join(',')}.`);
  }
  if (fromChrome && (targets.length !== 1 || targets[0] !== 'edge')) {
    throw new Error('Existing Chrome output may only be reused for the explicit Edge-only operation.');
  }
  const wantsEdge = targets.includes('edge');
  if ((targets.includes('chrome') || wantsEdge) && !fromChrome) {
    await compile(root, 'chrome', viteArgs);
  }
  if (wantsEdge) await edge(root);
  for (const platform of ['firefox', 'safari']) {
    if (targets.includes(platform)) await compile(root, platform, viteArgs);
  }
}
