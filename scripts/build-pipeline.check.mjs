import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';

import {
  BUILD_TARGETS, buildTargets, listBuildFiles, parseBuildArguments,
  prepareEdgeBuild, replacePreparedOutputs, validateChromeBuild,
} from './build-common.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const languages = ['en', 'zh', 'ja', 'fr', 'de', 'es', 'ru'];
const manifest = {
  manifest_version: 3, name: 'Build fixture', version: '1.9.4', key: 'fixture-optional-key',
  default_locale: 'en', background: { service_worker: 'assets/worker.js', type: 'module' },
  action: { default_popup: 'popup.html', default_icon: { 32: 'icon.png' } },
  content_scripts: [{ matches: ['https://chatgpt.com/*'], js: ['assets/content.js'], css: ['assets/style.css'] }],
  web_accessible_resources: [{ matches: ['https://chatgpt.com/*'], resources: ['locales/*.json', 'assets/*.png'] }],
};

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voyager build fixture '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.9.4' }));
  return root;
}

function writeChrome(root, value = manifest) {
  const directory = path.join(root, 'dist_chrome');
  for (const sub of ['assets', 'locales', '_locales/en']) fs.mkdirSync(path.join(directory, sub), { recursive: true });
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(value, null, 2) + '\n');
  for (const file of ['assets/worker.js', 'assets/content.js', 'assets/style.css', 'popup.html']) {
    fs.writeFileSync(path.join(directory, file), `fixture ${file}\n`);
  }
  fs.writeFileSync(path.join(directory, 'icon.png'), Buffer.from([0, 1, 128, 255]));
  fs.writeFileSync(path.join(directory, '_locales/en/messages.json'), '{"extName":{"message":"Fixture"}}');
  for (const language of languages) fs.writeFileSync(path.join(directory, `locales/${language}.json`), JSON.stringify({ test: language }));
  return directory;
}

function digestDirectory(directory) {
  return Object.fromEntries(listBuildFiles(directory).map((file) => [file, createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex')]));
}

function previousEdge(root) {
  fs.mkdirSync(path.join(root, 'dist_edge'));
  fs.writeFileSync(path.join(root, 'dist_edge/previous.txt'), 'previous directory');
  fs.writeFileSync(path.join(root, 'voyager-edge-v1.9.4.zip'), 'previous archive');
}

function assertPreviousEdge(root) {
  assert.equal(fs.readFileSync(path.join(root, 'dist_edge/previous.txt'), 'utf8'), 'previous directory');
  assert.equal(fs.readFileSync(path.join(root, 'voyager-edge-v1.9.4.zip'), 'utf8'), 'previous archive');
}

function makeCliFixture(t) {
  const root = makeRoot(t);
  for (const sub of ['scripts', 'node_modules/vite/bin']) fs.mkdirSync(path.join(root, sub), { recursive: true });
  for (const file of ['build-all.mjs', 'build-common.mjs', 'build-edge.js']) {
    fs.copyFileSync(path.join(source, 'scripts', file), path.join(root, 'scripts', file));
  }
  fs.symlinkSync(path.join(source, 'node_modules/jszip'), path.join(root, 'node_modules/jszip'), 'dir');
  fs.writeFileSync(path.join(root, 'node_modules/vite/package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'node_modules/vite/bin/vite.js'), `
    import fs from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2);
    const config = args[args.indexOf('--config') + 1];
    const platform = /vite\\.config\\.(\\w+)\\.ts/.exec(config)[1];
    fs.appendFileSync('compilations.jsonl', JSON.stringify({platform,args}) + '\\n');
    if (process.env.GV_BUILD_FIXTURE_FAIL === platform) process.exit(23);
    const dir = 'dist_' + platform;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({manifest_version:3,name:'CLI fixture',version:'1.9.4',key:'fixture-key'}));
    fs.writeFileSync(path.join(dir, 'app.js'), 'fixture');
  `);
  return root;
}

function cli(root, script, args = [], env = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

function compilations(root) {
  const file = path.join(root, 'compilations.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
}

test('default four-target build compiles Chrome once and uses its output for Edge', async () => {
  const calls = [];
  await buildTargets('/fixture', BUILD_TARGETS, {
    compile: async (_root, platform) => calls.push(platform),
    edge: async () => calls.push('edge-copy'),
  });
  assert.deepEqual(calls, ['chrome', 'edge-copy', 'firefox', 'safari']);
});

test('Edge-only remains a fresh single Chrome build; explicit reuse skips only the compiler', async () => {
  for (const fromChrome of [false, true]) {
    const calls = [];
    await buildTargets('/fixture', ['edge'], {
      fromChrome, compile: async (_root, platform) => calls.push(platform), edge: async () => calls.push('edge-copy'),
    });
    assert.deepEqual(calls, fromChrome ? ['edge-copy'] : ['chrome', 'edge-copy']);
  }
});

test('Vite arguments reach every selected compiler as distinct values', async () => {
  const calls = [];
  const viteArgs = ['--mode', 'fixture mode'];
  await buildTargets('/fixture', ['chrome', 'edge', 'firefox'], {
    viteArgs, compile: async (_root, platform, args) => calls.push({ platform, args }), edge: async () => {},
  });
  assert.deepEqual(calls, [{ platform: 'chrome', args: viteArgs }, { platform: 'firefox', args: viteArgs }]);
});

test('target selection deduplicates dependencies and preserves standalone CLI semantics', () => {
  assert.deepEqual(parseBuildArguments([]).targets, BUILD_TARGETS);
  assert.deepEqual(parseBuildArguments([], { edgeOnly: true }).targets, ['edge']);
  assert.deepEqual(parseBuildArguments(['--platforms', 'edge,chrome,edge']).targets, ['chrome', 'edge']);
  assert.deepEqual(parseBuildArguments(['--platforms=firefox', '--mode', 'dev']).viteArgs, ['--mode', 'dev']);
  assert.equal(parseBuildArguments(['--from-chrome'], { edgeOnly: true }).fromChrome, true);
});

for (const args of [['--platforms'], ['--platforms=other'], ['--platforms='], ['--from-chrome'], ['--config=other.ts'], ['--outDir', 'custom'], ['--watch']]) {
  test(`rejects invalid orchestration arguments ${args.join(' ')}`, () => {
    assert.throws(() => parseBuildArguments(args));
  });
}

test('explicit reuse cannot silently discard build flags', () => {
  assert.throws(() => parseBuildArguments(['--from-chrome', '--mode', 'dev'], { edgeOnly: true }), /does not compile/);
});

for (const withKey of [false, true]) {
  test(`Edge copy and ZIP preserve all Chrome data; optional key present=${withKey}`, async (t) => {
    const root = makeRoot(t);
    const input = { ...manifest };
    if (!withKey) delete input.key;
    const chrome = writeChrome(root, input);
    const before = digestDirectory(chrome);
    const result = await prepareEdgeBuild(root);
    assert.deepEqual(digestDirectory(chrome), before);
    const edge = JSON.parse(fs.readFileSync(path.join(result.directory, 'manifest.json'), 'utf8'));
    const expected = { ...input };
    delete expected.key;
    assert.deepEqual(edge, expected);
    const archive = await JSZip.loadAsync(fs.readFileSync(result.zipPath));
    assert.ok(archive.file('manifest.json'));
    for (const file of listBuildFiles(result.directory)) {
      assert.ok(!file.includes('\\'));
      assert.deepEqual(await archive.file(file).async('nodebuffer'), fs.readFileSync(path.join(result.directory, file)));
      if (file !== 'manifest.json') assert.equal(digestDirectory(result.directory)[file], before[file]);
    }
    for (const language of languages) assert.ok(archive.file(`locales/${language}.json`));
    assert.ok(!Object.keys(archive.files).some((file) => file.startsWith('dist_edge/')));
    assert.ok(!fs.readdirSync(root).some((name) => name.startsWith('.edge-build-')));
  });
}

for (const invalid of ['missing manifest', 'malformed manifest', 'version mismatch', 'missing reference', 'missing default locale', 'symlink']) {
  test(`incomplete source (${invalid}) leaves previous Edge outputs untouched`, async (t) => {
    const root = makeRoot(t);
    writeChrome(root);
    previousEdge(root);
    const manifestPath = path.join(root, 'dist_chrome/manifest.json');
    if (invalid === 'missing manifest') fs.rmSync(manifestPath);
    if (invalid === 'malformed manifest') fs.writeFileSync(manifestPath, '{');
    if (invalid === 'version mismatch') fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '1.9.3' }));
    if (invalid === 'missing reference') fs.rmSync(path.join(root, 'dist_chrome/assets/content.js'));
    if (invalid === 'missing default locale') fs.rmSync(path.join(root, 'dist_chrome/_locales/en/messages.json'));
    if (invalid === 'symlink') fs.symlinkSync(path.join(root, 'package.json'), path.join(root, 'dist_chrome/outside.json'));
    const beforeManifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath) : null;
    await assert.rejects(prepareEdgeBuild(root));
    assertPreviousEdge(root);
    if (beforeManifest) assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
  });
}

test('an unmatched declared wildcard is allowed, as in the supplied production manifest', (t) => {
  const root = makeRoot(t);
  writeChrome(root);
  assert.ok(validateChromeBuild(root).files.includes('icon.png'));
});

test('ordinary failure replacing the second output rolls both artifacts back, then retry succeeds', async (t) => {
  const root = makeRoot(t);
  const chrome = writeChrome(root);
  const before = digestDirectory(chrome);
  previousEdge(root);
  let failed = false;
  await assert.rejects(prepareEdgeBuild(root, {
    replace: (pairs) => replacePreparedOutputs(pairs, {
      rename: (from, to) => {
        if (!failed && from.endsWith('.zip') && to.endsWith('voyager-edge-v1.9.4.zip')) {
          failed = true;
          throw new Error('fixture archive replacement denied');
        }
        fs.renameSync(from, to);
      },
    }),
  }), /replacement denied/);
  assert.equal(failed, true);
  assertPreviousEdge(root);
  assert.deepEqual(digestDirectory(chrome), before);
  await prepareEdgeBuild(root);
  assert.ok(fs.existsSync(path.join(root, 'dist_edge/manifest.json')));
  assert.ok(!fs.existsSync(path.join(root, 'dist_edge/previous.txt')));
  assert.ok(!fs.readdirSync(root).some((name) => name.includes('.previous-')));
});

test('actual Node CLI works in a path with spaces, without a Bun or zip subprocess', (t) => {
  const root = makeCliFixture(t);
  const result = cli(root, 'build-all.mjs', ['--platforms', 'chrome,edge', '--mode', 'fixture mode']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(compilations(root).length, 1);
  assert.deepEqual(compilations(root)[0].args.slice(-2), ['--mode', 'fixture mode']);
  assert.ok(fs.existsSync(path.join(root, 'dist_edge/manifest.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'dist_chrome/manifest.json'), 'utf8')).key, 'fixture-key');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(root, 'dist_edge/manifest.json'), 'utf8')), 'key'), false);
});

test('actual CLI default all performs three compiler invocations for four targets', (t) => {
  const root = makeCliFixture(t);
  const result = cli(root, 'build-all.mjs');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(compilations(root).map((entry) => entry.platform), ['chrome', 'firefox', 'safari']);
  for (const target of BUILD_TARGETS) assert.ok(fs.existsSync(path.join(root, `dist_${target}/manifest.json`)));
});

test('actual standalone Edge compiles once, then explicit reuse adds no compilation', (t) => {
  const root = makeCliFixture(t);
  assert.equal(cli(root, 'build-edge.js').status, 0);
  const before = digestDirectory(path.join(root, 'dist_chrome'));
  assert.equal(cli(root, 'build-edge.js', ['--from-chrome']).status, 0);
  assert.equal(compilations(root).length, 1);
  assert.deepEqual(digestDirectory(path.join(root, 'dist_chrome')), before);
});

test('compile failure returns a nonzero exit and keeps previous Edge artifacts', (t) => {
  const root = makeCliFixture(t);
  previousEdge(root);
  const result = cli(root, 'build-edge.js', [], { GV_BUILD_FIXTURE_FAIL: 'chrome' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /chrome compilation failed/);
  assertPreviousEdge(root);
});

test('Safari failure does not claim the four-target build succeeded', (t) => {
  const root = makeCliFixture(t);
  const result = cli(root, 'build-all.mjs', [], { GV_BUILD_FIXTURE_FAIL: 'safari' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /safari compilation failed/);
  assert.deepEqual(compilations(root).map((entry) => entry.platform), ['chrome', 'firefox', 'safari']);
  assert.ok(fs.existsSync(path.join(root, 'dist_chrome/manifest.json')));
  assert.ok(fs.existsSync(path.join(root, 'dist_edge/manifest.json')));
  assert.ok(!fs.existsSync(path.join(root, 'dist_safari')));
});

test('help and invalid CLI options never trigger compilation', (t) => {
  const root = makeCliFixture(t);
  assert.equal(cli(root, 'build-all.mjs', ['--help']).status, 0);
  assert.notEqual(cli(root, 'build-all.mjs', ['--platforms', 'invalid']).status, 0);
  assert.deepEqual(compilations(root), []);
});

test('source packaging excludes the Edge release archive and recovery artifacts', async (t) => {
  const root = makeCliFixture(t);
  assert.equal(cli(root, 'build-edge.js').status, 0);
  fs.copyFileSync(path.join(source, 'scripts/pack-source.cjs'), path.join(root, 'scripts/pack-source.cjs'));
  fs.writeFileSync(path.join(root, 'source-to-review.ts'), 'export const source = true;');
  fs.mkdirSync(path.join(root, '.edge-build-interrupted'));
  fs.writeFileSync(path.join(root, '.edge-build-interrupted/asset.js'), 'interrupted build');
  fs.mkdirSync(path.join(root, 'dist_edge.previous-fixture'));
  fs.writeFileSync(path.join(root, 'dist_edge.previous-fixture/asset.js'), 'recovery build');
  fs.writeFileSync(path.join(root, 'voyager-edge-v1.9.4.zip.previous-123abc'), 'old archive');
  const result = cli(root, 'pack-source.cjs');
  assert.equal(result.status, 0, result.stderr);
  const archive = await JSZip.loadAsync(fs.readFileSync(path.join(root, 'firefox_release/chatgpt-voyager-1.9.4-source.zip')));
  assert.ok(archive.file('source-to-review.ts'));
  assert.ok(archive.file('scripts/build-common.mjs'));
  assert.ok(!Object.keys(archive.files).some((name) => name.startsWith('dist_') || name.startsWith('.edge-build-') || name.startsWith('voyager-edge-v')));
});
