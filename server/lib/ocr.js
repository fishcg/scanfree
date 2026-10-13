/**
 * lib/ocr.js —— 服务端在线识别用到的纯函数。
 *
 * 为什么单独抽出来：这些函数决定「用户发来的东西能不能用」和「上游报错该翻译成
 * 什么话」。写错一个，线上就是白花花的 token 和用户看不懂的报错。它们不碰网络、
 * 不碰文件，所以可以在 Node 里直接单测。
 *
 * 接口事实（2026-10 核对 api-docs.deepseek.com/zh-cn/guides/vision）：
 *   - OpenAI 兼容：POST {base}/chat/completions，Authorization: Bearer <key>
 *   - 图片以 {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,..."}} 传入
 *   - 图片只能放在 user 消息里；system/assistant 里放图片会 400
 *   - 服务端会把图片缩到约 1300×1300，所以传再大也没用，每张最多约 1024 token
 */

export const DEFAULT_MODEL = 'deepseek-flash';
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** 允许的图片类型（data URL 的 mime） */
export const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

/** 识别指令。目标是"可导出的纯文本"，所以明确禁止 Markdown 和客套话。 */
export const OCR_PROMPT = `把这张图片里出现的文字逐字提取出来。

规则：
1. 只输出图片里真实存在的文字，不要解释、不要总结、不要翻译、不要补充看不清的内容。
2. 保持原有的阅读顺序和换行，同一段就是一段，段落之间空一行。
3. 看不清的字用 □ 代替；整行实在无法辨认就跳过这一行。
4. 不要用代码块包裹，不要输出 Markdown 标记，不要写"以下是识别结果"之类的话。
5. 遇到表格按行输出，同一行的单元格之间用 | 分隔。`;

/** 带 HTTP 状态码的错误：服务端据此回状态码，而不是一律 500 */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** 拼一个 OpenAI 兼容的看图请求体 */
export function buildVisionRequest({ imageDataUrl, model = DEFAULT_MODEL, prompt = OCR_PROMPT, maxTokens = 4096 }) {
  if (!imageDataUrl || typeof imageDataUrl !== 'string') throw new HttpError(400, '缺少图片数据');
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

/** 去掉整体包裹的 ``` 代码围栏（模型偶尔还是会加，尽管我们禁过） */
export function stripFence(text) {
  const t = String(text ?? '').trim();
  const m = t.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  return m ? m[1] : t;
}

/** 从响应里取出正文 */
export function extractText(json) {
  const msg = json?.choices?.[0]?.message;
  const raw = typeof msg?.content === 'string' ? msg.content : '';
  if (!raw.trim()) {
    if (msg?.reasoning_content) throw new HttpError(502, '模型只返回了思考过程，没有给出结果，请重试');
    throw new HttpError(502, '接口没有返回识别结果');
  }
  return stripFence(raw).trim();
}

/**
 * 把上游的错误翻译成用户能看懂、且知道该干什么的一句话。
 * （站在服务端的角度：Key 是服务端的，所以措辞不能说成"你的 Key"）
 */
export function describeUpstreamError(status, body) {
  const detail = typeof body === 'string' ? body : body?.error?.message || '';
  if (status === 401 || status === 403) return '服务端的 DeepSeek Key 无效或没有权限，请联系站长（设置步骤见 README）';
  if (status === 402) return '服务端的 DeepSeek 账号余额不足，请联系站长充值';
  if (status === 429) return '在线识别太忙了（触发上游限流），等一会儿再试，或先用本地离线识别';
  if (status === 400) return `请求被上游拒绝：${detail || '图片可能过大或格式不支持'}`;
  if (status >= 500) return `DeepSeek 服务暂时不可用（${status}），请稍后再试，或先用本地离线识别`;
  return `识别失败（${status}）${detail ? '：' + detail : ''}`;
}

/**
 * 校验并解析 data URL 形式的图片。
 * 这里挡的是"没压缩就直接传 20MB 原图"这类请求——它们既慢又白烧 token。
 * @returns {{mime: string, bytes: number}}
 */
export function parseImageDataUrl(dataUrl, opts = {}) {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const allowMime = opts.allowMime || ALLOWED_IMAGE_MIMES;
  if (typeof dataUrl !== 'string' || !dataUrl) throw new HttpError(400, '缺少图片数据');
  const m = /^data:([a-z0-9/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!m) throw new HttpError(400, '图片格式不对：只接受 base64 编码的 data URL');
  const mime = m[1].toLowerCase();
  if (!allowMime.includes(mime)) throw new HttpError(400, `不支持的图片格式：${mime}`);
  const bytes = Math.floor((m[2].replace(/\s/g, '').length * 3) / 4);
  if (bytes > maxBytes) {
    const mb = (n) => (n / 1048576).toFixed(1);
    throw new HttpError(413, `图片太大了（${mb(bytes)}MB），上限 ${mb(maxBytes)}MB`);
  }
  if (bytes < 512) throw new HttpError(400, '图片数据不完整');
  return { mime, bytes };
}

/**
 * 每个 IP 的滑动窗口限流 + 全局每日上限。
 *
 * 存在的理由很直接：Key 是服务端掏钱的，没有限流就等于把钱包挂在公网上。
 * 全局上限是最后一道闸——万一被刷，最多损失这么多，而不是整个余额。
 */
export class RateLimiter {
  constructor(opts = {}) {
    this.perHour = opts.perHour ?? 30;
    this.perDay = opts.perDay ?? 200;
    this.globalPerDay = opts.globalPerDay ?? 3000;
    this.now = opts.now || Date.now;
    this.hits = new Map(); // ip -> number[]（24 小时内的请求时间戳）
    this.globalCount = 0;
    this.globalDay = this._dayKey(this.now());
  }

  _dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  _prune(list, ts) {
    const cutoff = ts - 86400000;
    let i = 0;
    while (i < list.length && list[i] < cutoff) i++;
    return i ? list.slice(i) : list;
  }

  /** @returns {{ok: true} | {ok: false, reason: string, retryAfter: number}} */
  check(ip) {
    const ts = this.now();
    const today = this._dayKey(ts);
    if (today !== this.globalDay) {
      this.globalDay = today;
      this.globalCount = 0;
    }
    if (this.globalCount >= this.globalPerDay) {
      return { ok: false, reason: '今天全站的免费识别额度已经用完了，明天再来，或改用本地离线识别', retryAfter: 3600 };
    }

    const key = ip || 'unknown';
    let list = this._prune(this.hits.get(key) || [], ts);
    const hourAgo = ts - 3600000;
    const inHour = list.filter((t) => t >= hourAgo).length;
    if (inHour >= this.perHour) {
      const oldest = list.find((t) => t >= hourAgo) ?? ts;
      return {
        ok: false,
        reason: `这一小时已经识别了 ${this.perHour} 次，休息一下再来（也可以切到“本地离线识别”，不限次数）`,
        retryAfter: Math.max(60, Math.ceil((oldest + 3600000 - ts) / 1000)),
      };
    }
    if (list.length >= this.perDay) {
      return { ok: false, reason: `今天已经识别了 ${this.perDay} 次，明天再来（也可以切到“本地离线识别”，不限次数）`, retryAfter: 3600 };
    }

    list.push(ts);
    this.hits.set(key, list);
    this.globalCount++;

    // 顺手清理：Map 不能无限长，否则长时间运行会漏内存
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) {
        const kept = this._prune(v, ts);
        if (!kept.length) this.hits.delete(k);
        else this.hits.set(k, kept);
      }
    }
    return { ok: true };
  }

  get stats() {
    return { ips: this.hits.size, globalToday: this.globalCount, globalPerDay: this.globalPerDay };
  }
}

/** 从请求头里取真实 IP：nginx 在前面，所以要认 X-Real-IP / X-Forwarded-For */
export function clientIp(headers, socket) {
  const xr = headers['x-real-ip'];
  if (xr) return String(xr).split(',')[0].trim();
  const xff = headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return socket?.remoteAddress || '';
}
