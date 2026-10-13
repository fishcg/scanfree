/**
 * 服务端的集成测试：真的把 server/server.js 当子进程启起来，用真的 HTTP 请求打它。
 *
 * 为什么不用单元测试mock：这个服务端最容易出错的地方恰恰是"接起来的部分"——
 * 静态白名单漏了某个文件、路径穿越没挡住、限流没生效、上游报错时返回了什么。
 * 这些都是端到端才看得见的。上游 DeepSeek 用一个本地假服务器顶替
 * （DEEPSEEK_BASE_URL 指向它），所以测试不发外网、不花钱、结果稳定。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_PORT = 8811 + (process.pid % 90);

/* ------------------------- 假的 DeepSeek ------------------------- */

let upstream; // 本地假上游
let upstreamPort;
let upstreamCalls = []; // 记下它收到了什么，用来断言服务端发得对不对

function startUpstream() {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        upstreamCalls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
        const mode = upstream.mode || 'ok';
        if (mode === 'fail') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'Authentication Fails' } }));
        }
        if (mode === 'garbage') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end('这不是 JSON');
        }
        if (mode === 'fenced') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { content: '```text\n房屋租赁合同\n甲方：张明\n```' } }], usage: { total_tokens: 42 } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '房屋租赁合同\n甲方：张明  乙方：李华' } }],
            usage: { prompt_tokens: 900, completion_tokens: 30, total_tokens: 930 },
          })
        );
      });
    });
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = upstream.address().port;
      resolve();
    });
  });
}

/* ------------------------- 真的 scanfree 服务端 ------------------------- */

/** 启一个服务端实例；env 覆盖掉默认配置 */
/**
 * 找一个大方能用的端口。
 *
 * 原先直接用 BASE_PORT + n，结果被本机一个残留的开发服务器占了同一个号，
 * 服务端起不来、请求打到了别的进程上，测试报出来的是一句莫名其妙的
 * "返回了 '□' 而不是中文"——排查花了很久。宁可多探一次。
 */
async function freePort() {
  for (let i = 0; i < 60; i += 1) {
    const port = BASE_PORT + startServer.n++;
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error('找不到空闲端口');
}

async function startServer(env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DEEPSEEK_API_KEY: '',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error('服务端没能在 15 秒内起来：\n' + logs.join(''));
    await new Promise((r) => setTimeout(r, 120));
  }
  return { proc, base, logs, port };
}
startServer.n = 0;

let srv; // 主实例：配了 Key
before(async () => {
  await startUpstream();
  srv = await startServer({ DEEPSEEK_API_KEY: 'sk-server-test' });
});
after(async () => {
  srv?.proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => upstream.close(r));
});

/** 一张真的 JPEG（用 fixtures 里的那张）。服务端要求 ≥512 字节——太短的"图"不是图 */
const SAMPLE_JPEG = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(ROOT, 'tests/fixtures/scan-sample.jpg')).toString('base64');
/** 160 字节的合法 JPEG：用来验证"太短就拒"的那道闸 */
const TOO_SMALL_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

/* ------------------------------ 静态文件 ------------------------------ */

test('首页和关键静态文件都能拿到，MIME 要对', async () => {
  for (const [p, type, mustHave] of [
    ['/', 'text/html', '全民扫描'],
    ['/index.html', 'text/html', null],
    ['/sw.js', 'javascript', 'CACHE_VERSION'],
    ['/manifest.webmanifest', 'manifest+json', '全民扫描'],
    ['/css/app.css', 'text/css', null],
    ['/js/app.js', 'javascript', null],
    ['/assets/icon-192.png', 'image/png', null],
    ['/favicon.ico', 'image/png', null],
  ]) {
    const r = await fetch(srv.base + p);
    assert.equal(r.status, 200, `${p} 应当能访问`);
    assert.match(r.headers.get('content-type') || '', new RegExp(type.replace('+', '\\+')), `${p} 的 Content-Type 不对`);
    if (mustHave) assert.ok((await r.text()).includes(mustHave), `${p} 的内容里应当有 ${mustHave}`);
  }
});

test('源码和配置不许对外：路径穿越、敏感文件、目录列举都要挡住', async () => {
  for (const p of [
    '/server/server.js',
    '/server/config.js',
    '/package.json',
    '/k8s.yaml',
    '/.woodpecker.yml',
    '/Dockerfile',
    '/tests/e2e.test.mjs',
    '/tools/preview.mjs',
    '/../package.json',
    '/js/../server/server.js',
    '/%2e%2e/package.json',
    '/js/',
    '/assets/',
  ]) {
    const r = await fetch(srv.base + p, { redirect: 'manual' });
    assert.ok(r.status === 403 || r.status === 404, `${p} 不该被放出去（实际 ${r.status}）`);
    const body = await r.text();
    assert.ok(!body.includes('DEEPSEEK_API_KEY'), `${p} 的响应里漏了服务端源码`);
  }
});

test('/api/health 会说清楚在线识别开没开', async () => {
  const r = await fetch(`${srv.base}/api/health`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.name, 'scanfree');
  assert.equal(j.ai.enabled, true, '配了 Key 就应当报 enabled');
  assert.equal(j.ai.model, 'deepseek-flash');

  const noKey = await startServer({ DEEPSEEK_API_KEY: '' });
  try {
    const j2 = await (await fetch(`${noKey.base}/api/health`)).json();
    assert.equal(j2.ai.enabled, false, '没配 Key 时必须诚实地说没开通');
  } finally {
    noKey.proc.kill('SIGTERM');
  }
});

/* ------------------------------ 识别接口 ------------------------------ */

test('POST /api/ocr：能拿到文字，而且发给上游的请求是对的', async () => {
  upstreamCalls = [];
  const r = await fetch(`${srv.base}/api/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: srv.base },
    body: JSON.stringify({ image: SAMPLE_JPEG }),
  });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.match(j.text, /房屋租赁合同/);
  assert.equal(j.model, 'deepseek-flash');
  assert.equal(j.engine, 'server');
  assert.equal(j.usage.total_tokens, 930);

  assert.equal(upstreamCalls.length, 1, '应当只调一次上游');
  const up = upstreamCalls[0];
  assert.equal(up.url, '/chat/completions');
  assert.equal(up.auth, 'Bearer sk-server-test', 'Key 必须放在 Authorization 头里（不能出现在 body / URL）');
  assert.equal(up.body.model, 'deepseek-flash');
  const parts = up.body.messages[0].content;
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].type, 'image_url');
  assert.ok(parts[1].image_url.url.startsWith('data:image/jpeg;base64,'), '图片要以 data URL 传');
  assert.ok(!JSON.stringify(up.body).includes('sk-server-test'), 'Key 绝不能混进请求体');
});

test('上游返回带 ``` 围栏时要把围栏剥掉', async () => {
  upstream.mode = 'fenced';
  const r = await fetch(`${srv.base}/api/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: SAMPLE_JPEG }),
  });
  const j = await r.json();
  upstream.mode = 'ok';
  assert.equal(r.status, 200);
  assert.equal(j.text, '房屋租赁合同\n甲方：张明', '不该把 ```text 一起交给用户');
});

test('上游报错时：把原因翻成人话，不泄露 Key', async () => {
  upstream.mode = 'fail';
  const r = await fetch(`${srv.base}/api/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: SAMPLE_JPEG }),
  });
  const j = await r.json();
  upstream.mode = 'ok';
  assert.equal(r.status, 401);
  assert.ok(j.error && j.error.length > 4, '要有可读的错误信息');
  assert.ok(!JSON.stringify(j).includes('sk-server-test'), '错误信息里不能带 Key');
});

test('上游返回垃圾内容时给 502，而不是把 undefined 当文字返回', async () => {
  upstream.mode = 'garbage';
  const r = await fetch(`${srv.base}/api/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: SAMPLE_JPEG }),
  });
  const j = await r.json();
  upstream.mode = 'ok';
  assert.equal(r.status, 502);
  assert.match(j.error, /看不懂|重试/);
});

test('没配 Key 的实例：明确说"本站没开通"，让前端能退回本地识别', async () => {
  const s2 = await startServer({ DEEPSEEK_API_KEY: '' });
  try {
    const r = await fetch(`${s2.base}/api/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: SAMPLE_JPEG }),
    });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /没有开通|没配 Key/);
  } finally {
    s2.proc.kill('SIGTERM');
  }
});

test('入参不合法时给出准确的 4xx（而不是 500）', async () => {
  const post = (body, headers = { 'Content-Type': 'application/json' }) =>
    fetch(`${srv.base}/api/ocr`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

  let r = await post({ image: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' });
  assert.equal(r.status, 400, 'gif 不在允许的格式里');
  assert.match((await r.json()).error, /jpg|png|webp|支持/);

  r = await post({ image: 'https://example.com/a.jpg' });
  assert.equal(r.status, 400, '只接受 data URL，不接受外链（防止被当成图片代理）');

  r = await post({});
  assert.equal(r.status, 400, '没给图片');

  r = await post({ image: TOO_SMALL_JPEG });
  assert.equal(r.status, 400, '160 字节的"图"不该被当成照片送上去（太少字节说明数据不完整）');
  assert.match((await r.json()).error, /不完整/);

  r = await post('{坏 JSON');
  assert.equal(r.status, 400);

  r = await fetch(`${srv.base}/api/ocr`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hi' });
  assert.equal(r.status, 415);

  r = await fetch(`${srv.base}/api/ocr`);
  assert.equal(r.status, 405);

  r = await fetch(`${srv.base}/api/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ image: SAMPLE_JPEG }),
  });
  assert.equal(r.status, 403, '跨站页面不该能拿我们的 Key 去识别');
});

test('图片太大直接拒绝（别把 8MB 的图送进上游烧钱）', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(Math.ceil((9 * 1024 * 1024) / 3) * 4);
  const r = await fetch(`${srv.base}/api/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: big }),
  });
  assert.equal(r.status, 413, `应当明确回 413，实际 ${r.status}`);
  // 关键：客户端要收到那句可读的话，而不是"连接被重置"
  assert.match((await r.json()).error, /太大|压小/, '超限时要给一句人能照着做的提示');
});

test('限流真的会拦（Key 是站里掏钱的）', async () => {
  const s3 = await startServer({ DEEPSEEK_API_KEY: 'sk-server-test', OCR_PER_HOUR: '2', OCR_PER_DAY: '3' });
  try {
    const call = () =>
      fetch(`${s3.base}/api/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: SAMPLE_JPEG }),
      });
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 200);
    const third = await call();
    assert.equal(third.status, 429, '第 3 次应当被拦');
    assert.ok(Number(third.headers.get('retry-after')) > 0, '要告诉客户端多久后重试');
    assert.match((await third.json()).error, /休息|稍|次数|太多了/);
  } finally {
    s3.proc.kill('SIGTERM');
  }
});

test('日志里不许出现图片内容、文字结果和 Key', async () => {
  // 这一条是"隐私承诺"的守门人：服务端说好不记用户内容，就得真的不记
  const all = srv.logs.join('');
  assert.ok(!all.includes('sk-server-test'), '日志里出现了 Key');
  assert.ok(!all.includes('data:image/jpeg;base64'), '日志里出现了图片数据');
  assert.ok(!all.includes('房屋租赁合同'), '日志里出现了识别出来的文字');
});
