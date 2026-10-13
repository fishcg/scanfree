/**
 * ai.js —— 在线文字识别（DeepSeek 的图像理解接口）。
 *
 * ⚠️ 这是整个 App 里**唯一会把你的图片发到网上**的功能。它有两条路，都不默认开：
 *
 *   A. 本站服务端（推荐，部署在 scan.acgay.cn 时才有）
 *      Key 放在服务器上，用户什么都不用填，点一下就能用——这才叫"免费给人民用"。
 *      页面启动时会探一次 /api/health，探到才显示"本站免费"。
 *
 *   B. 自己的 Key（BYOK）
 *      用你自己在 platform.deepseek.com 申请的 Key，只存在你本机 localStorage，
 *      不经过我们的服务器，花的是你自己的额度。自己下载一份离线用的人走这条。
 *
 *   C. 本地离线（默认兜底）
 *      不填 Key、服务端也没开，就永远走 Tesseract.js，一个字节都不外传。
 *
 * 为什么值得提供在线识别：本地引擎认印刷体够用，但遇到手写、印章、表格、竖排、
 * 复杂版式时，多模态大模型的准确率明显更高——代价就是要联网、要花钱。
 *
 * 接口事实（2026-10 核对 api-docs.deepseek.com/zh-cn/guides/vision）：
 *   - OpenAI 兼容：POST {base}/chat/completions，Authorization: Bearer <key>
 *   - 图片以 {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,..."}} 传入
 *   - 只支持放在 user 消息里；system/assistant 里放图片会 400
 *   - 服务端会把图片缩到约 1300×1300，所以传再大也没用，每张最多 1024 token
 *   - 浏览器直连的 CORS 已实测可用（预检回 Access-Control-Allow-Origin）
 */

import { createCanvas, ctx2d, canvasToBlob, loadImage } from './render.js';

const API_BASE = 'https://api.deepseek.com';

/** 可选模型。deepseek-flash 支持图片输入；旧名 deepseek-v4-flash-vision-exp 已下线（仍会被转发到同一模型） */
export const AI_MODELS = [
  { id: 'deepseek-flash', name: 'deepseek-flash' },
  // 旧名仍可调用，官方把它们转发到同一个模型；留着是为了照顾别人已有的配置
  { id: 'deepseek-v4-flash-vision-exp', name: 'vision-exp（旧名）' },
];

export const DEFAULT_MODEL = 'deepseek-flash';

/**
 * 送给模型的长边上限。
 * 服务端反正会缩到约 1300×1300，传更大的图纯属浪费流量和你的流量费；
 * 1568 留了一点余量，让细小的字（票据、身份证号）在缩放前仍有足够像素。
 */
const MAX_EDGE = 1568;
const JPEG_QUALITY = 0.86;
const TIMEOUT_MS = 120000;

/** 识别指令：目标是"可导出的纯文本"，所以明确禁止 Markdown 和客套话 */
export const OCR_PROMPT = `把这张图片里出现的文字逐字提取出来。

规则：
1. 只输出图片里真实存在的文字，不要解释、不要总结、不要翻译、不要补充看不清的内容。
2. 保持原有的阅读顺序和换行，同一段就是一段，段落之间空一行。
3. 看不清的字用 □ 代替；整行实在无法辨认就跳过这一行。
4. 不要用代码块包裹，不要输出 Markdown 标记，不要写"以下是识别结果"之类的话。
5. 遇到表格按行输出，同一行的单元格之间用 | 分隔。`;

/* --------------------------- 纯函数（可单测） --------------------------- */

/**
 * 拼一个 OpenAI 兼容的看图请求体。抽成纯函数是为了能在 Node 里直接断言。
 * @param {{imageDataUrl: string, model?: string, prompt?: string, maxTokens?: number}} o
 */
export function buildVisionRequest({ imageDataUrl, model = DEFAULT_MODEL, prompt = OCR_PROMPT, maxTokens = 4096 }) {
  if (!imageDataUrl || typeof imageDataUrl !== 'string') throw new Error('缺少图片数据');
  return {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    max_tokens: maxTokens,
    stream: false,
  };
}

/**
 * 从响应里取出正文。
 * 模型偶尔会把结果裹在 ``` 里（尽管我们明确禁过），这里顺手剥掉——
 * 与其让用户自己删围栏，不如我们擦干净。
 */
export function extractText(json) {
  const msg = json?.choices?.[0]?.message;
  const raw = typeof msg?.content === 'string' ? msg.content : '';
  if (!raw) {
    if (msg?.reasoning_content) throw new Error('模型只返回了思考过程，没有给出结果，请重试');
    throw new Error('接口没有返回识别结果');
  }
  return stripFence(raw).trim();
}

/** 去掉整体包裹的 ``` 代码围栏 */
export function stripFence(text) {
  const t = String(text).trim();
  const m = t.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  return m ? m[1] : t;
}

/**
 * 把 HTTP 错误翻译成用户能看懂、且知道该干什么的一句话。
 * 这类提示最忌讳把 {"error":{"code":...}} 原样甩给用户。
 */
export function describeAiError(status, body) {
  const detail = typeof body === 'string' ? body : body?.error?.message || '';
  if (status === 401 || status === 403) return 'API Key 不对或没有权限，请到"设置"里检查（注意别把 Key 贴到聊天窗口里）';
  if (status === 402) return '你的 DeepSeek 账号余额不足，请充值或改用本地识别';
  if (status === 429) return '请求太频繁或超出限额，等一会儿再试';
  if (status === 400) return `请求被拒绝：${detail || '图片可能过大或格式不支持'}`;
  if (status >= 500) return `DeepSeek 服务暂时不可用（${status}），请稍后再试，或先用本地识别`;
  return `识别失败（${status}）${detail ? '：' + detail : ''}`;
}

export function hasKey(settings) {
  return !!(settings?.aiKey && String(settings.aiKey).trim().length > 8);
}

/**
 * 决定这次用哪个引擎。
 * @param {object} settings
 * @param {{serverAi?: boolean}} caps 本站服务端是否开通了在线识别（由 probeServer 探到）
 *
 * auto：能在线就在线（本站服务端优先，其次自己的 Key），否则本地。
 */
export function pickEngine(settings, caps = {}) {
  const mode = settings?.ocrEngine || 'auto';
  if (mode === 'local') return 'local';
  const canOnline = !!caps.serverAi || hasKey(settings);
  return canOnline ? 'online' : 'local';
}

/**
 * 在线识别走哪条路：
 *   'server' —— 本站服务端（不花用户的钱，也不需要 Key）
 *   'byok'   —— 用户自己的 Key 直连 DeepSeek
 *   null     —— 都不行
 * 服务端优先：它免费、也省得用户自己折腾 Key。
 */
export function onlineTarget(settings, caps = {}) {
  if (caps.serverAi) return 'server';
  if (hasKey(settings)) return 'byok';
  return null;
}

/* ------------------------------ 图片准备 ------------------------------ */

/** Blob → data URL。不能用 canvas.toDataURL：render.js 的 createCanvas 优先返回
 *  OffscreenCanvas，它只有 convertToBlob，没有 toDataURL（真浏览器里实测报
 *  "canvas.toDataURL is not a function"）。统一走 canvasToBlob 两种画布都支持。 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('图片编码失败'));
    fr.readAsDataURL(blob);
  });
}

/**
 * 把任意图源转成 base64 data URL，顺便缩到 MAX_EDGE 以内。
 * @param {Blob|HTMLCanvasElement|ImageBitmap} source
 * @returns {Promise<{dataUrl: string, width: number, height: number, bytes: number}>}
 */
export async function prepareImage(source, opts = {}) {
  const maxEdge = opts.maxEdge || MAX_EDGE;
  const quality = opts.quality || JPEG_QUALITY;
  const img = await loadImage(source);
  const sw = img.width || img.naturalWidth;
  const sh = img.height || img.naturalHeight;
  if (!sw || !sh) throw new Error('图片读不出来');

  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const canvas = createCanvas(w, h);
  const ctx = ctx2d(canvas);
  // 白底：PNG 透明区域若直接转 JPEG 会变成黑块
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  const dataUrl = await blobToDataUrl(blob);
  return { dataUrl, width: w, height: h, bytes: blob.size };
}

/* ------------------------------ 主流程 ------------------------------ */

/**
 * 在线识别。
 * @param {Blob|HTMLCanvasElement|ImageBitmap|string} source 图源，或已经是 data URL 的字符串
 * @param {{apiKey: string, model?: string, prompt?: string, baseUrl?: string,
 *          onProgress?: (p:number, s:string)=>void, fetchImpl?: typeof fetch, timeoutMs?: number}} opts
 * @returns {Promise<{text: string, engine: string, model: string, usage: object|null}>}
 */
export async function recognizeOnline(source, opts = {}) {
  const apiKey = String(opts.apiKey || '').trim();
  if (!apiKey) throw new Error('还没有填 API Key，请到"设置 → 在线 AI 识别"里填一个');

  const doFetch = opts.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('这个浏览器不支持网络请求');

  opts.onProgress?.(0.1, '正在准备图片');
  const prepared =
    typeof source === 'string' ? { dataUrl: source, bytes: 0, width: 0, height: 0 } : await prepareImage(source, opts);
  opts.onProgress?.(0.3, '正在上传并识别');

  const body = buildVisionRequest({
    imageDataUrl: prepared.dataUrl,
    model: opts.model || DEFAULT_MODEL,
    prompt: opts.prompt || OCR_PROMPT,
    maxTokens: opts.maxTokens,
  });

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs || TIMEOUT_MS) : null;

  let res;
  try {
    res = await doFetch(`${opts.baseUrl || API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('识别超时了，可能是图片太大或网络太慢，请重试');
    throw new Error('连不上 DeepSeek（网络不通，或被浏览器/代理拦住了）');
  } finally {
    if (timer) clearTimeout(timer);
  }

  opts.onProgress?.(0.85, '正在整理文字');

  if (!res.ok) {
    let payload = '';
    try {
      payload = await res.text();
      payload = JSON.parse(payload);
    } catch {
      /* 保持原文 */
    }
    throw new Error(describeAiError(res.status, payload));
  }

  const json = await res.json();
  const text = extractText(json);
  opts.onProgress?.(1, '识别完成');
  return { text, engine: 'online', model: body.model, usage: json.usage || null };
}

/* --------------------------- 本站服务端 --------------------------- */

export const SERVER_HEALTH_PATH = '/api/health';
export const SERVER_OCR_PATH = '/api/ocr';

/** file:// 打开的离线副本没有服务端，先挡掉，省得每次启动白探一次 */
function canUseServer() {
  return typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
}

/**
 * 探一次本站服务端。
 * 探到就返回 ai 信息（模型名、限流额度），探不到返回 null——调用方据此把"本站免费"
 * 显示或藏起来，而不是摆一个点了会报错的按钮。
 */
export async function probeServer(opts = {}) {
  if (!canUseServer()) return null;
  const doFetch = opts.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return null;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs || 4000) : null;
  try {
    const res = await doFetch(opts.path || SERVER_HEALTH_PATH, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res.ok) return null;
    const json = await res.json();
    // 服务端在，但没配 Key —— 对用户来说等于没有，如实返回 null
    return json?.ai?.enabled ? { ...json.ai, version: json.version || '' } : null;
  } catch {
    return null; // 探测失败不是错误，只是没有这个能力，不打扰用户
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 走本站服务端识别：图片 POST 给 /api/ocr，Key 在服务端，用户不用填也不用付钱。
 * 图片同样先压到 MAX_EDGE——服务端还会再挡一道，但没必要先把 20MB 原图传上去。
 */
export async function recognizeViaServer(source, opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('这个浏览器不支持网络请求');

  opts.onProgress?.(0.1, '正在准备图片');
  const prepared = typeof source === 'string' ? { dataUrl: source } : await prepareImage(source, opts);
  opts.onProgress?.(0.3, '正在上传并识别');

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs || TIMEOUT_MS) : null;

  let res;
  try {
    res = await doFetch(opts.path || SERVER_OCR_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: prepared.dataUrl }),
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('识别超时了，可能是图片太大或网络太慢，请重试');
    throw new Error('连不上本站服务器（网络不通？）');
  } finally {
    if (timer) clearTimeout(timer);
  }

  opts.onProgress?.(0.85, '正在整理文字');

  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 下面统一报错 */
  }
  if (!res.ok) throw new Error(json?.error || `本站服务器识别失败（${res.status}）`);
  if (!json?.text) throw new Error('本站服务器没有返回识别结果');

  opts.onProgress?.(1, '识别完成');
  return { text: String(json.text), engine: 'server', model: json.model || DEFAULT_MODEL, usage: json.usage || null };
}

/** 一次极小的连通性/Key 校验（用一句话而不是图片，省额度） */
export async function testKey(apiKey, opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const res = await doFetch(`${opts.baseUrl || API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${String(apiKey).trim()}` },
    body: JSON.stringify({
      model: opts.model || DEFAULT_MODEL,
      messages: [{ role: 'user', content: '回复"ok"两个字母即可' }],
      max_tokens: 8,
      stream: false,
    }),
  });
  if (!res.ok) {
    let payload = '';
    try {
      payload = JSON.parse(await res.text());
    } catch {
      /* 忽略 */
    }
    throw new Error(describeAiError(res.status, payload));
  }
  return true;
}

export { API_BASE as AI_API_BASE, MAX_EDGE as AI_MAX_EDGE };
