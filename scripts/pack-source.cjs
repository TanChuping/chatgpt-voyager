#!/usr/bin/env node
/**
 * Build a source-code zip for AMO (Mozilla addons.mozilla.org) review.
 *
 * AMO requires the original (un-bundled, un-minified) source for any
 * extension that uses a bundler/minifier.  This script produces
 * chatgpt-voyager-<ver>-source.zip containing the full repo MINUS:
 *   - node_modules           (reviewers run `bun install` themselves)
 *   - dist_chrome / dist_*   (build output)
 *   - .git                   (history irrelevant for review)
 *   - .tmp_*                 (local probe artifacts)
 *   - .chrome-*-profile      (Chrome dev profiles, huge + irrelevant)
 *   - .npm-cache             (local cache)
 *   - store_packages         (already-built artefact archive)
 *   - debug-screenshots      (dev screenshots)
 *   - 公式交接.md             (personal handover doc)
 *   - LOCAL_DEVELOPMENT.md   (dev-only notes)
 *
 * Usage:
 *   node scripts/pack-source.cjs
 *
 * Output:
 *   firefox_release/chatgpt-voyager-<version>-source.zip
 */

const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'firefox_release');
const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkgJson.version;

fs.mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, `chatgpt-voyager-${version}-source.zip`);
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

// Top-level entries that should never enter the archive.
const SKIP_TOP = new Set([
  'node_modules',
  'dist_chrome',
  'dist_firefox',
  'dist_edge',
  'dist_safari',
  '.git',
  '.vscode',
  '.idea',
  '.claude',
  '.preview',
  '.npm-cache',
  '.cache',
  '.bun',
  '.parcel-cache',
  '.entire',
  '.chrome-bh-profile',
  '.chrome-debug-profile',
  'coverage',
  '.nyc_output',
  '.DS_Store',
  'store_packages',
  'debug-screenshots',
  'firefox_release',
  '_reference_gemini_voyager',
  'reference',
]);

// Pattern-based skips that apply at any depth.
function shouldSkip(_relPath, name) {
  if (name.startsWith('.tmp_')) return true;
  if (name === '.extension-key.pem' || name.startsWith('.extension-key.')) return true;
  if (name === '公式交接.md') return true;
  if (name === 'LOCAL_DEVELOPMENT.md') return true;
  if (/^chatgpt-voyager-.*\.(zip|xpi|crx)$/.test(name)) return true;
  if (name === '.DS_Store') return true;
  return false;
}

const zip = new JSZip();
let fileCount = 0;

function addDir(absDir, relDir) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const name = entry.name;
    if (relDir === '' && SKIP_TOP.has(name)) continue;
    if (shouldSkip(relDir, name)) continue;
    const abs = path.join(absDir, name);
    const rel = relDir ? `${relDir}/${name}` : name;
    if (entry.isDirectory()) {
      addDir(abs, rel);
    } else if (entry.isFile()) {
      zip.file(rel, fs.readFileSync(abs));
      fileCount += 1;
    }
  }
}

addDir(repoRoot, '');

(async () => {
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  fs.writeFileSync(zipPath, buf);
  const sizeMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(2);
  console.log(
    `[pack-source] ✓ ${path.relative(repoRoot, zipPath)} (${fileCount} files, ${sizeMb} MB)`,
  );
  console.log(`[pack-source] Upload this when AMO asks for source code.`);
})().catch((err) => {
  console.error('[pack-source] zip failed:', err);
  process.exit(1);
});
