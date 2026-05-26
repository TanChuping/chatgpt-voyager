#!/usr/bin/env node
/**
 * Build a Chrome Web Store-installable .zip from dist_chrome/.
 *
 * Zip layout requirement (Chrome Web Store): manifest.json must be at
 * the zip ROOT, not nested under `dist_chrome/`. Same JSZip approach
 * as pack-firefox.cjs to guarantee forward-slash entry names regardless
 * of platform (PowerShell's Compress-Archive emits backslashes which
 * confuses some validators).
 *
 * Output: store_packages/chatgpt-voyager-<ver>-chrome.zip
 *
 * Usage:
 *   bun run build:chrome           # produces dist_chrome/
 *   node scripts/pack-chrome.cjs   # produces the store zip
 */

const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const repoRoot = path.resolve(__dirname, '..');
const dist = path.join(repoRoot, 'dist_chrome');
const outDir = path.join(repoRoot, 'store_packages');

if (!fs.existsSync(dist)) {
  console.error(`[pack-chrome] dist_chrome/ missing — run \`bun run build:chrome\` first.`);
  process.exit(1);
}

const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkgJson.version;
console.log(`[pack-chrome] version: ${version}`);

fs.mkdirSync(outDir, { recursive: true });

const zipPath = path.join(outDir, `chatgpt-voyager-${version}-chrome.zip`);
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

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
addDir(dist, '');

(async () => {
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  fs.writeFileSync(zipPath, buf);

  const sizeKb = Math.round(fs.statSync(zipPath).size / 1024);
  console.log(`[pack-chrome] ✓ ${path.relative(repoRoot, zipPath)} (${sizeKb} KB)`);
})().catch((err) => {
  console.error('[pack-chrome] zip failed:', err);
  process.exit(1);
});
