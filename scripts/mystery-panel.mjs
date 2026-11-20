import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const api = 'repos/TanChuping/chatgpt-voyager-support/contents/mystery-panel/panel.json';
const compiled = await build({
  absWorkingDir: root,
  entryPoints: ['src/core/services/mysteryCard.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  logLevel: 'silent',
});
const moduleBytes = Buffer.from(compiled.outputFiles[0].contents);
const { parseMysteryCard } = await import(
  'data:text/javascript;base64,' + moduleBytes.toString('base64')
);

function gh(args, body) {
  return JSON.parse(
    execFileSync('gh', ['api', ...args], {
      encoding: 'utf8',
      input: body && JSON.stringify(body),
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
}
function load() {
  const file = gh([api + '?ref=main']);
  return { sha: file.sha, text: Buffer.from(file.content, 'base64').toString('utf8') };
}
function validate(text) {
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text) > 65536 ||
    !parseMysteryCard(JSON.parse(text))
  )
    throw new Error('配置无效。请检查 enabled、行列、文本和 HTTPS 地址；文件上限 64 KiB。');
}
function publish(text, sha) {
  validate(text);
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('请先读取线上版本，取得编辑基线。');
  const result = gh(['--method', 'PUT', api, '--input', '-'], {
    message: 'Update mystery button panel',
    branch: 'main',
    sha,
    content: Buffer.from(text).toString('base64'),
  });
  return { sha: result.content.sha, url: result.commit.html_url };
}

const [action = 'edit', filename, baseSha] = process.argv.slice(2);
if (action === 'edit') {
  const key = randomBytes(24).toString('hex');
  const page = readFileSync(
    new URL('./mystery-panel-editor.html', import.meta.url),
    'utf8',
  ).replace('__EDITOR_KEY__', key);
  const server = createServer(async (req, res) => {
    const send = (status, type, body) => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
    };
    try {
      if (req.headers.host !== new URL(origin).host) return send(403, 'text/plain', 'Forbidden');
      if (req.method === 'GET' && req.url === '/')
        return send(200, 'text/html; charset=utf-8', page);
      if (req.method === 'GET' && req.url === '/renderer.js')
        return send(200, 'text/javascript', moduleBytes);
      if (req.headers['x-editor-key'] !== key) return send(403, 'text/plain', 'Forbidden');
      if (req.method === 'GET' && req.url === '/current')
        return send(200, 'application/json', JSON.stringify(load()));
      if (req.method === 'POST' && req.url === '/publish' && req.headers.origin === origin) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 256 * 1024) throw new Error('请求过大');
          chunks.push(chunk);
        }
        const { text, sha } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return send(200, 'application/json', JSON.stringify(publish(text, sha)));
      }
      send(404, 'text/plain', 'Not found');
    } catch (err) {
      send(400, 'text/plain; charset=utf-8', err.message);
    }
  });
  let origin;
  server.listen(0, '127.0.0.1', () => {
    origin = 'http://127.0.0.1:' + server.address().port;
    console.log(origin);
    if (process.platform === 'win32' && !process.argv.includes('--no-open'))
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', origin], {
        windowsHide: true,
        stdio: 'ignore',
      }).unref();
  });
} else if (action === 'read') {
  const file = load();
  console.error('Git blob:', file.sha);
  process.stdout.write(file.text);
} else if (action === 'check') {
  validate(readFileSync(filename, 'utf8'));
  console.log('OK');
} else if (action === 'publish') {
  console.log(publish(readFileSync(filename, 'utf8'), baseSha).url);
} else throw new Error('用法：edit | read | check <JSON> | publish <JSON> <原始 blob SHA>');
