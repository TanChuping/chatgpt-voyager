#!/usr/bin/env node
/**
 * Build a Firefox-installable .xpi from dist_firefox/.
 *
 * An XPI is just a zip with a particular layout — same content as the
 * Chrome zip, but built with vite.config.firefox.ts (which uses
 * background.scripts instead of service_worker, sets the gecko id, and
 * aliases mermaid to mermaid-legacy@9.2.2 because Firefox's parser
 * chokes on mermaid v11's ESM output).
 *
 * Any `key` field in manifest.json is stripped — Firefox ignores it,
 * but AMO submission rejects it (the field is only meant for local
 * unpacked-extension dev to keep the Chrome ID stable across reloads).
 *
 * Zipping uses JSZip rather than the platform `zip` / Compress-Archive
 * because PowerShell on Windows emits backslash-separated entry names
 * inside the archive, which violates the ZIP spec and is rejected by
 * AMO's validator (error: "Invalid file name in archive").
 *
 * Output: firefox_release/chatgpt-voyager-<ver>-firefox.xpi
 *
 * Usage:
 *   bun run build:firefox            # produces dist_firefox/
 *   node scripts/pack-firefox.cjs    # produces .xpi in firefox_release/
 * or as a single step:
 *   bun run pack:firefox
 */

const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const repoRoot = path.resolve(__dirname, '..');
const dist = path.join(repoRoot, 'dist_firefox');
const stage = path.join(repoRoot, '.tmp_firefox_stage');
const outDir = path.join(repoRoot, 'firefox_release');

if (!fs.existsSync(dist)) {
  console.error(`[pack-firefox] dist_firefox/ missing — run \`bun run build:firefox\` first.`);
  process.exit(1);
}

const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkgJson.version;
console.log(`[pack-firefox] version: ${version}`);

if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}
copyDir(dist, stage);

// Strip `key` if present, rewrite as UTF-8 NO BOM.
const manifestPath = path.join(stage, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const hadKey = 'key' in manifest;
delete manifest.key;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8' });
console.log(`[pack-firefox] manifest 'key' field: ${hadKey ? 'stripped' : 'absent (ok)'}`);

const xpiPath = path.join(outDir, `chatgpt-voyager-${version}-firefox.xpi`);
if (fs.existsSync(xpiPath)) fs.rmSync(xpiPath);

const zip = new JSZip();
function addDir(absDir, relDir) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      addDir(abs, rel);
    } else if (entry.isFile()) {
      zip.file(rel, fs.readFileSync(abs));
    }
  }
}
addDir(stage, '');

(async () => {
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  fs.writeFileSync(xpiPath, buf);

  fs.rmSync(stage, { recursive: true, force: true });

  const sizeKb = Math.round(fs.statSync(xpiPath).size / 1024);
  console.log(`[pack-firefox] ✓ ${path.relative(repoRoot, xpiPath)} (${sizeKb} KB)`);
  console.log(
    `[pack-firefox] Linux install: about:debugging → "This Firefox" → "Load Temporary Add-on" → pick the xpi.`,
  );
})().catch((err) => {
  console.error('[pack-firefox] zip failed:', err);
  process.exit(1);
});
