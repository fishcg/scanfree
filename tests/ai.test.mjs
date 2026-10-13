/**
 * ai.test.mjs —— 在线识别（DeepSeek 看图）的单元测试。
 *
 * 这个模块是全 App 唯一会把图片发出去的地方，所以测试的重点有两类：
 *   1. 纯函数：请求体拼得对不对、返回的文字取得对不对、错误提示是不是人话。
 *   2. 网络边界：成功、401、断网、超时——每一条都必须给出**能照着做**的提示，
 *      而不是把 {"error":{"message":...}} 甩给用户。
 * 全程用注入的 fetchImpl，不打真实网络（跑测试不该花钱，也不该依赖外网）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVisionRequest,
  extractText,
  stripFence,
  describeAiError,
  hasKey,
  pickEngine,
  recognizeOnline,
  testKey,
  OCR_PROMPT,
  DEFAULT_MODEL,
} from '../js/ai.js';

const FAKE_IMG = 'data:image/jpeg;base64,AAAA';

/** 造一个假的 fetch 响应 */
function fakeRes(status, body, { text = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    ...(text ? {} : {}),
  };
}

/* ------------------------------ 请求体 ------------------------------ */

test('请求体是标准的 OpenAI 看图格式', () => {
  const req = buildVisionRequest({ imageDataUrl: FAKE_IMG });
  assert.equal(req.model, DEFAULT_MODEL);
  assert.equal(req.stream, false);
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, 'user');
  const [textBlock, imageBlock] = req.messages[0].content;
  assert.equal(textBlock.type, 'text');
  assert.equal(textBlock.text, OCR_PROMPT);
  assert.equal(imageBlock.type, 'image_url');
  assert.equal(imageBlock.image_url.url, FAKE_IMG);
});

test('请求体可以被覆写模型与指令', () => {
  const req = buildVisionRequest({ imageDataUrl: FAKE_IMG, model: 'x-1', prompt: '只认数字', maxTokens: 16 });
  assert.equal(req.model, 'x-1');
  assert.equal(req.max_tokens, 16);
  assert.equal(req.messages[0].content[0].text, '只认数字');
});

test('没有图片就拒绝发请求（防止白花一次额度）', () => {
  assert.throws(() => buildVisionRequest({}), /缺少图片数据/);
  assert.throws(() => buildVisionRequest({ imageDataUrl: 123 }), /缺少图片数据/);
});

test('识别指令明确禁止 Markdown 和客套话（否则 TXT 导出会混进围栏）', () => {
  assert.match(OCR_PROMPT, /不要用代码块包裹/);
  assert.match(OCR_PROMPT, /逐字/);
});

/* ------------------------------ 取结果 ------------------------------ */

test('从响应里取出正文', () => {
  const text = extractText({ choices: [{ message: { content: '  你好\n世界  ' } }] });
  assert.equal(text, '你好\n世界');
});

test('模型裹了代码围栏也会被剥掉', () => {
  assert.equal(extractText({ choices: [{ message: { content: '```\n你好\n```' } }] }), '你好');
  assert.equal(extractText({ choices: [{ message: { content: '```text\n你好\n```' } }] }), '你好');
  assert.equal(stripFence('普通文本'), '普通文本');
});

test('空结果要报错，而不是静默返回空字符串', () => {
  assert.throws(() => extractText({ choices: [{ message: { content: '' } }] }), /没有返回识别结果/);
  assert.throws(() => extractText({}), /没有返回识别结果/);
});

test('只返回思考过程时给出可重试的提示', () => {
  assert.throws(
    () => extractText({ choices: [{ message: { content: '', reasoning_content: '我在看图…' } }] }),
    /只返回了思考过程/
  );
});

/* ------------------------------ 错误翻译 ------------------------------ */

test('每一类错误都给能照着做的中文提示', () => {
  assert.match(describeAiError(401, ''), /API Key 不对/);
  assert.match(describeAiError(403, ''), /API Key 不对/);
  assert.match(describeAiError(402, ''), /余额不足/);
  assert.match(describeAiError(429, ''), /太频繁/);
  assert.match(describeAiError(500, ''), /服务暂时不可用/);
  assert.match(describeAiError(503, ''), /本地识别/);
  assert.match(describeAiError(400, { error: { message: 'image too large' } }), /image too large/);
  assert.match(describeAiError(418, ''), /识别失败（418）/);
});

/* ------------------------------ 引擎选择 ------------------------------ */

test('没填 Key 就永远走本地，哪怕设了"只用在线"', () => {
  assert.equal(hasKey({}), false);
  assert.equal(hasKey({ aiKey: '   ' }), false);
  assert.equal(hasKey({ aiKey: 'sk-short' }), false, '短得不像 Key 的应当视为没填');
  assert.equal(hasKey({ aiKey: 'sk-1234567890abcdef' }), true);
  assert.equal(pickEngine({}), 'local');
  assert.equal(pickEngine({ ocrEngine: 'online' }), 'local', '设了在线但没 Key，必须退回本地而不是发一个没钥匙的请求');
  assert.equal(pickEngine({ ocrEngine: 'auto', aiKey: 'sk-1234567890abcdef' }), 'online');
  assert.equal(pickEngine({ ocrEngine: 'local', aiKey: 'sk-1234567890abcdef' }), 'local', '用户明确要本地就必须本地');
});

/* ------------------------------ 网络边界 ------------------------------ */

test('成功路径：请求发对了地方，文字取回来了', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return fakeRes(200, { choices: [{ message: { content: '房屋租赁合同' } }], usage: { total_tokens: 900 } });
  };
  const progress = [];
  const r = await recognizeOnline(FAKE_IMG, {
    apiKey: 'sk-1234567890abcdef',
    fetchImpl,
    onProgress: (p, s) => progress.push(s),
  });

  assert.equal(r.text, '房屋租赁合同');
  assert.equal(r.engine, 'online');
  assert.equal(r.model, DEFAULT_MODEL);
  assert.equal(r.usage.total_tokens, 900);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-1234567890abcdef');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.messages[0].content[1].image_url.url, FAKE_IMG);
  assert.ok(progress.includes('正在上传并识别'), '应当有进度反馈，否则用户以为卡死了');
});

test('Key 不对：提示指向设置页，而不是甩一句 401', async () => {
  const fetchImpl = async () => fakeRes(401, { error: { message: 'Authentication Fails' } });
  await assert.rejects(
    () => recognizeOnline(FAKE_IMG, { apiKey: 'sk-badbadbadbadbad', fetchImpl }),
    /API Key 不对/
  );
});

test('断网/CORS 被拦：提示是"连不上"，不是 TypeError: Failed to fetch', async () => {
  const fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(() => recognizeOnline(FAKE_IMG, { apiKey: 'sk-1234567890abcdef', fetchImpl }), /连不上 DeepSeek/);
});

test('超时被中止：提示可以重试', async () => {
  const fetchImpl = async () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  };
  await assert.rejects(() => recognizeOnline(FAKE_IMG, { apiKey: 'sk-1234567890abcdef', fetchImpl }), /识别超时/);
});

test('没填 Key 就调用：在发出请求之前就拦住', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return fakeRes(200, {});
  };
  await assert.rejects(() => recognizeOnline(FAKE_IMG, { fetchImpl }), /还没有填 API Key/);
  assert.equal(called, false, '绝不能在没 Key 的情况下把图片发出去');
});

test('测试 Key：成功返回 true，失败给出同一套人话提示', async () => {
  assert.equal(await testKey('sk-1234567890abcdef', { fetchImpl: async () => fakeRes(200, { choices: [] }) }), true);
  await assert.rejects(
    () => testKey('sk-1234567890abcdef', { fetchImpl: async () => fakeRes(402, { error: { message: 'Insufficient Balance' } }) }),
    /余额不足/
  );
});
