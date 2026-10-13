/**
 * server/server.js —— 全民扫描的服务端。
 *
 * 它只做两件事，都是零依赖（只用 Node 内置模块，没有 npm 依赖）：
 *
 *   1. 把静态文件发出去（就是那个纯前端 App 本身）；
 *   2. POST /api/ocr —— 拿**服务端自己的** DeepSeek Key 替用户做在线识别。
 *
 * 为什么要有个服务端：纯前端的在线识别必须让用户自己填 Key，这对"免费给人民用"
 * 是说不通的。Key 放在服务端，用户点一下就能用；代价是这里的 Key 是站里掏钱的，
 * 所以必须有每 IP 限流 + 全局每日上限 + 图片大小上限（见 lib/ocr.js 的 RateLimiter）。
 *
 * 注意：不做任何用户系统，不存任何用户数据。图片只在一次请求的内存里过一遍，
 * 不落盘、不记日志（日志里只有方法/路径/状态码/耗时）。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config.js';
import {
  HttpError,
  RateLimiter,
  buildVisionRequest,
  clientIp,
  describeUpstreamError,
  extractText,
  parseImageDataUrl,
} from './lib/ocr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VERSION = readVersion();

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/* ----------------------------- 静态文件 ----------------------------- */

// 只放行 App 真正需要的东西。仓库里的 server/、tests/、tools/、preview/、
// Dockerfile、k8s.yaml 一概不对外——部署到公网的东西不该顺手把源码仓库也送出去。
const ALLOWED_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/sw.js', 'sw.js'],
  ['/manifest.webmanifest', 'manifest.webmanifest'],
  ['/favicon.ico', 'assets/icon-192.png'],
  ['/robots.txt', null], // 动态生成
]);
const ALLOWED_DIRS = ['/css/', '/js/', '/assets/'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** 把 URL 路径映射到磁盘文件；不在白名单里就返回 null（一律 404，不区分"不存在"和"不给看"） */
function resolveStatic(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (p.includes('\0') || p.includes('..')) return null;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

  if (ALLOWED_FILES.has(p)) {
    const rel = ALLOWED_FILES.get(p);
    return rel === null ? { special: 'robots' } : { file: path.join(ROOT, rel), noStore: true };
  }
  if (ALLOWED_DIRS.some((d) => p.startsWith(d))) {
    const file = path.join(ROOT, p);
    // 双保险：拼出来的路径必须还在 ROOT 里面
    if (!file.startsWith(ROOT + path.sep)) return null;
    return { file, noStore: false };
  }
  return null;
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

async function serveStatic(req, res, urlPath) {
  const hit = resolveStatic(urlPath);
  if (!hit) return sendJson(res, 404, { error: '没有这个文件' });
  if (hit.special === 'robots') {
    return send(res, 200, 'User-agent: *\nAllow: /\n', { 'Content-Type': MIME['.txt'], 'Cache-Control': 'no-store' });
  }

  let stat;
  try {
    stat = await fsp.stat(hit.file);
  } catch {
    return sendJson(res, 404, { error: '没有这个文件' });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: '没有这个文件' });

  const ext = path.extname(hit.file).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Last-Modified': stat.mtime.toUTCString(),
    // index.html / sw.js / manifest 绝不能缓存：否则改了版本用户还在跑旧壳
    'Cache-Control': hit.noStore ? 'no-store, must-revalidate' : 'public, max-age=600',
  };
  if (req.method === 'HEAD') return send(res, 200, '', headers);
  const data = await fsp.readFile(hit.file);

  // 给 index.html 塞一个"本站有后端"的标记。
  //
  // 为什么需要它：前端启动时要探一次 /api/health，才知道该说"不上传"还是
  // "免登录"、以及要不要把"本站免费识别"露出来。可是没有后端的静态托管
  // （GitHub Pages、start.sh 里那个 python 服务器）上，这个探测会稳定地打出一条
  // 404 —— 用户看不见，但控制台脏了，而且我们自己的 e2e 用例"首页不许有任何报错"
  // 会因此变红（真红过一次）。所以改成：后端自己在页面里盖章，前端看到章才去探。
  if (ext === '.html') {
    const html = data.toString('utf8').replace('</head>', '<script>window.__SCANFREE_SERVER__={api:true}</script></head>');
    return send(res, 200, html, headers);
  }
  return send(res, 200, data, headers);
}

/* ------------------------------- 接口 ------------------------------- */

const limiter = new RateLimiter({
  perHour: config.ocr.perHour,
  perDay: config.ocr.perDay,
  globalPerDay: config.ocr.globalPerDay,
});

function aiStatus() {
  const enabled = !!config.deepseek.apiKey;
  return {
    enabled,
    free: true,
    model: config.deepseek.model,
    reason: enabled ? '' : '本站还没有配置 DeepSeek Key，请用本地离线识别',
    limits: { perHour: config.ocr.perHour, perDay: config.ocr.perDay },
  };
}

/** 只认自己站的 Origin：别的网站即使偷偷 POST 过来，浏览器也读不到响应（CORS 不给头），
 *  再加这道判断，连"白烧我们的 Key"都做不成。 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 同源 fetch 有时不带 Origin；命令行调试也不带
  const host = req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 读请求体，超限就拒。
 *
 * 这里有个容易写错的地方（曾经写过一版就是错的）：一发现超限就 req.destroy()，
 * 看着很干脆，实际结果是客户端收到的是"连接被重置"，而不是我们精心写的
 * 那句"图片太大了"——用户看到的是浏览器自己的 "Failed to fetch"，
 * 完全不知道该怎么办。所以超限后要**继续把剩下的数据读完（丢掉）**，
 * 等请求结束了再老老实实回一个 413，客户端才收得到。
 * 只有离谱到 4 倍上限才真的掐断——那种情况下不值得再陪着读。
 */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    const tooLargeError = () => new HttpError(413, `图片太大了（超过 ${(max / 1048576).toFixed(0)}MB），先压小一点再传`);
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0; // 已经攒的也没用了，先放掉，别白占内存
        }
        if (size > max * 4) {
          reject(tooLargeError());
          req.destroy();
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => (tooLarge ? reject(tooLargeError()) : resolve(Buffer.concat(chunks))));
    req.on('error', (err) => reject(tooLarge ? tooLargeError() : err));
  });
}

async function callDeepSeek({ imageDataUrl, prompt }) {
  const body = buildVisionRequest({
    imageDataUrl,
    model: config.deepseek.model,
    prompt: prompt || undefined,
    maxTokens: config.deepseek.maxTokens,
  });
  const payload = JSON.stringify(body);

  // 为什么要重试：线上真出现过"第一次 502、同一条请求紧接着重发就成功"的情况
  // （单次实测 23 秒后失败，随后同类请求 2.8 秒成功）。对用户来说，一次抖动
  // 就是"识别失败"，而重试一次几乎不花额外成本。
  //
  // 为什么只重试一次、且只重试"值得重试的错"：
  //   · 5xx / 网络错 / 超时 = 对面或链路抖了，重发有意义；
  //   · 4xx（Key 不对、参数不对、被限流）= 重发还是同样结果，只会更慢更惹人烦。
  //
  // 为什么要总预算而不是"每次 120 秒、重试一次共 240 秒"：
  // 前端 ai.js 的 TIMEOUT_MS 是 120 秒，服务端要是能跑 240 秒，用户会在 120 秒
  // 看到"超时"，而服务端还在后台白烧一次调用的钱。所以总预算压在 110 秒以内，
  // 并且留给重试的时间不足 5 秒就不重试了。
  const deadline = Math.min(config.deepseek.timeout, 110000);
  const startedAt = Date.now();
  let lastErr = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const left = deadline - (Date.now() - startedAt);
    if (left <= 5000) break;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), left);
    try {
      const res = await fetch(`${config.deepseek.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.deepseek.apiKey}`,
        },
        body: payload,
        signal: ctrl.signal,
      });

      if (!res.ok) {
        let payloadText = '';
        try {
          payloadText = JSON.parse(await res.text());
        } catch {
          /* 保留空 */
        }
        const err = new HttpError(res.status >= 500 ? 502 : res.status, describeUpstreamError(res.status, payloadText));
        // 4xx 是"想清楚了的拒绝"，直接抛，不重试
        if (res.status < 500) throw err;
        lastErr = err;
        console.warn(`[scanfree] DeepSeek 第 ${attempt} 次返回 ${res.status}，${attempt === 1 ? '准备重试' : '不再重试'}`);
        continue;
      }

      let json;
      try {
        json = await res.json();
      } catch {
        lastErr = new HttpError(502, 'DeepSeek 返回了看不懂的内容，请重试');
        continue;
      }
      return { text: extractText(json), model: body.model, usage: json.usage || null };
    } catch (err) {
      if (err instanceof HttpError) throw err; // 上面那个 4xx，别再包一层
      if (err?.name === 'AbortError') {
        lastErr = new HttpError(504, '识别超时了（服务器到 DeepSeek 这一跳太慢），请重试或改用本地离线识别');
      } else {
        lastErr = new HttpError(502, '服务器连不上 DeepSeek，请稍后再试或改用本地离线识别');
      }
      console.warn(`[scanfree] DeepSeek 第 ${attempt} 次请求失败：${err?.name || err?.message}，${attempt === 1 ? '准备重试' : '不再重试'}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr || new HttpError(502, '服务器连不上 DeepSeek，请稍后再试或改用本地离线识别');
}

async function handleOcr(req, res) {
  if (!config.deepseek.apiKey) {
    return sendJson(res, 503, { error: '本站还没有开通在线识别（服务端没配 Key），请用本地离线识别' });
  }
  if (!originAllowed(req)) {
    return sendJson(res, 403, { error: '跨站请求被拒绝' });
  }
  const ctype = String(req.headers['content-type'] || '');
  if (!ctype.includes('application/json')) {
    return sendJson(res, 415, { error: '只接受 application/json' });
  }

  const ip = clientIp(req.headers, req.socket);
  const verdict = limiter.check(ip);
  if (!verdict.ok) {
    return sendJson(res, 429, { error: verdict.reason, retryAfter: verdict.retryAfter }, { 'Retry-After': String(verdict.retryAfter) });
  }

  let payload;
  try {
    const raw = await readBody(req, config.ocr.maxBodyBytes);
    payload = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    return sendJson(res, 400, { error: '请求体不是合法的 JSON' });
  }

  try {
    parseImageDataUrl(payload?.image, { maxBytes: config.ocr.maxImageBytes });
    const result = await callDeepSeek({
      imageDataUrl: payload.image,
      prompt: typeof payload.prompt === 'string' && payload.prompt.trim() ? payload.prompt.slice(0, 2000) : '',
    });
    return sendJson(res, 200, { text: result.text, model: result.model, usage: result.usage, engine: 'server' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : '服务器内部出错了，请稍后再试';
    if (!(err instanceof HttpError)) console.error('[scanfree] /api/ocr 未预期的错误：', err);
    return sendJson(res, status, { error: message });
  }
}

/* ------------------------------ 服务器 ------------------------------ */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const urlPath = (req.url || '/').split('?')[0];
  res.on('finish', () => {
    // 只记方法/路径/状态码/耗时。不记 IP（免得不小心变成一份用户画像），不记图片和文字。
    if (urlPath.startsWith('/api/')) {
      console.log(`${req.method} ${urlPath} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  try {
    if (urlPath === '/api/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '只支持 GET' });
      return sendJson(res, 200, { ok: true, name: 'scanfree', version: VERSION, ai: aiStatus() });
    }
    if (urlPath === '/api/ocr') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      return await handleOcr(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '只支持 GET' });
    return await serveStatic(req, res, urlPath);
  } catch (err) {
    console.error('[scanfree] 请求处理失败：', err);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部出错了' });
    else res.end();
  }
});

server.listen(config.http.port, () => {
  const ai = aiStatus();
  console.log(`[scanfree] v${VERSION} 已启动：http://0.0.0.0:${config.http.port}`);
  console.log(`[scanfree] 静态目录：${ROOT}`);
  console.log(
    `[scanfree] 在线识别：${ai.enabled ? `已开通（${ai.model}，每 IP ${config.ocr.perHour}/小时、${config.ocr.perDay}/天，全站 ${config.ocr.globalPerDay}/天）` : '未开通（没有 DEEPSEEK_API_KEY，前端会自动走本地离线识别）'}`
  );
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[scanfree] 收到 ${sig}，关闭服务`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
