/**
 * 端到端测试：用真浏览器（Playwright + Chromium）把 App 当普通用户那样走一遍。
 *
 * 为什么必须有这一层：单元测试只能证明算法函数算得对，
 * 证明不了"点「导入照片」能不能真的出图、点「导出 PDF」能不能真的下下来一个能打开的文件"。
 * 很多致命问题（模块路径写错、DOM 选择器对不上、Canvas 在真实 API 下报错）只有跑起来才暴露。
 *
 * 跑法：
 *   cd scanfree && node --test tests/e2e.test.mjs
 * 需要本机装了 Playwright 的浏览器（npx playwright install chromium）。
 * 没装的话整个文件会跳过，不会让测试套件变红。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** 找到一个能用的 Playwright（本机全局装的那个也算） */
function loadPlaywright() {
  const candidates = [
    'playwright',
    'playwright-core',
    '/opt/homebrew/lib/node_modules/playwright',
    '/usr/local/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

/**
 * 找一个本机真实存在的 Chromium 可执行文件。
 *
 * 为什么要这么麻烦：Playwright 的 JS 包和它下载的浏览器是**分开安装**的，
 * 两者版本对不上时 launch() 会直接报 "Executable doesn't exist at .../chromium_headless_shell-1217/..."。
 * 这台机器上就是这种情况（包是 1.59、浏览器是 1200）。与其让用户去下 150MB 的新浏览器，
 * 不如把已有的那个找出来直接用——版本差几个小版本，跑这个 App 完全没问题。
 */
function findChromium() {
  const base = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  const alt = path.join(os.homedir(), '.cache', 'ms-playwright'); // Linux
  const roots = [base, alt];
  const patterns = [
    /^chromium_headless_shell-(\d+)$/,
    /^chromium-(\d+)$/,
  ];
  const found = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      for (const re of patterns) {
        const m = name.match(re);
        if (!m) continue;
        const build = Number(m[1]);
        const candidates = [
          path.join(root, name, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
          path.join(root, name, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
          path.join(root, name, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
          path.join(root, name, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
          path.join(root, name, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
          path.join(root, name, 'chrome-linux', 'chrome'),
        ];
        for (const c of candidates) {
          if (fs.existsSync(c)) found.push({ build, path: c });
        }
      }
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => b.build - a.build); // 挑版本最新的
  return found[0].path;
}

const pw = loadPlaywright();
const CHROMIUM = findChromium();
const PORT = 8731 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;

/** 统一的浏览器启动入口：优先用默认的，不行就用找到的那个 */
async function launchBrowser() {
  try {
    return await pw.chromium.launch();
  } catch (err) {
    if (!CHROMIUM) throw err;
    return await pw.chromium.launch({ executablePath: CHROMIUM });
  }
}

let server;
let browser;
let tmpDir;
let photo; // 测试用"文档照片"的 JPEG 缓冲区

/** 起一个只监听本机的静态服务器（就拿 App 自带的启动脚本用的那个 python 服务器） */
function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    p.on('error', reject);
    // 轮询直到真的能连上（比 sleep 固定秒数可靠）
    const deadline = Date.now() + 10_000;
    const tick = async () => {
      try {
        const res = await fetch(`${BASE}/index.html`);
        if (res.ok) return resolve(p);
      } catch {
        /* 还没起来 */
      }
      if (Date.now() > deadline) return reject(new Error('静态服务器起不来'));
      setTimeout(tick, 120);
    };
    tick();
  });
}

/**
 * 造一张"手机拍文档"的照片：带阴影、带文字、稍微倾斜。
 * 用浏览器自己渲染再截图，比在 Node 里画像素真实得多（有真字体、真抗锯齿）。
 */
async function makePhoto(browser) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1300 } });
  await page.setContent(`
    <style>
      html,body{margin:0;height:100%;}
      body{background:#3b3b3b;display:flex;align-items:center;justify-content:center;}
      .paper{
        width:760px;height:1040px;background:#fdfdfb;padding:60px 70px;box-sizing:border-box;
        font-family:"Songti SC",serif;color:#111;transform:rotate(-1.6deg);
        box-shadow:0 30px 80px rgba(0,0,0,.55);
        background-image:linear-gradient(115deg, rgba(0,0,0,.16) 0%, rgba(0,0,0,0) 42%);
      }
      h1{font-size:38px;text-align:center;margin:0 0 8px;letter-spacing:6px;}
      .sub{text-align:center;color:#666;font-size:17px;margin-bottom:34px;}
      p{font-size:20px;line-height:2.05;margin:0 0 14px;text-align:justify;}
      .sign{margin-top:44px;text-align:right;font-size:20px;}
      table{width:100%;border-collapse:collapse;margin:22px 0;font-size:18px;}
      td,th{border:1px solid #333;padding:9px 12px;}
      th{background:#eee;}
    </style>
    <div class="paper">
      <h1>房屋租赁合同</h1>
      <div class="sub">合同编号：2026-ZL-0088</div>
      <p>出租方（甲方）：张明　身份证号：3101**********1234</p>
      <p>承租方（乙方）：李华　身份证号：3101**********5678</p>
      <p>第一条　甲方将位于本市南京西路 1000 号的房屋出租给乙方居住使用，租赁期限自 2026 年 1 月 1 日起至 2026 年 12 月 31 日止。</p>
      <table>
        <tr><th>项目</th><th>金额</th><th>备注</th></tr>
        <tr><td>月租金</td><td>人民币 6500 元</td><td>押一付三</td></tr>
        <tr><td>押金</td><td>人民币 6500 元</td><td>退租时结算</td></tr>
      </table>
      <p>第二条　乙方应按时交纳租金，逾期超过十五日的，甲方有权解除合同。</p>
      <div class="sign">甲方签字：____________　日期：2026 年 1 月 1 日</div>
    </div>
  `);
  const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
  await page.close();
  return buf;
}

/** 收集页面上的报错，任何一个都算失败 */
function watchErrors(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/**
 * 等到"完整预览"渲染完成。
 *
 * 预览是两段式的：showPage() 先挂上 240px 的缩略图避免白屏，等 renderPreview 算完
 * 再换成完整图。所以只等 naturalWidth > 0 会**撞上缩略图**（实测 175x240），
 * 断言尺寸的用例就会时灵时不灵——曾因此误判成"裁边把图裁小了"。
 * 这里改用尺寸门槛来区分两个阶段。
 */
async function waitForFullPreview(page) {
  await page.waitForFunction(
    () => {
      const img = document.querySelector('#page-img');
      return img && img.naturalWidth >= 400;
    },
    { timeout: 20000 }
  );
}

before(async () => {
  if (!pw) return;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanfree-e2e-'));
  server = await startServer();
  browser = await launchBrowser();
  photo = await makePhoto(browser);
  fs.writeFileSync(path.join(tmpDir, 'photo.jpg'), photo);
});

after(async () => {
  await browser?.close();
  server?.kill();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const needs = { skip: !pw && '本机没有 Playwright，跳过浏览器端到端测试' };

test('打开首页：能加载、无报错、Service Worker 能注册', needs, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = watchErrors(page);

  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });

  // 首页应该有可见的入口按钮
  await page.waitForSelector('[data-act="import"]', { timeout: 5000 });
  const title = await page.title();
  assert.ok(title.length > 0, '页面应该有标题');

  // Service Worker 注册成功才算 PWA 可用（离线打开靠它）
  const swReady = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    return reg ? 'ready' : 'failed';
  });
  assert.equal(swReady, 'ready', 'Service Worker 应该注册成功');

  assert.deepEqual(errors, [], '首页不该有任何报错');
  await ctx.close();
});

test('导入一张照片：能切成文档、出缩略图、显示在编辑页', needs, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });

  await page.setInputFiles('#file-input', {
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    buffer: photo,
  });

  // 导入后应自动进入编辑页，出现这一页的预览图和缩略图
  await page.waitForSelector('#page-img', { timeout: 20000 });
  await waitForFullPreview(page);

  const info = await page.evaluate(() => {
    const img = document.querySelector('#page-img');
    return {
      naturalW: img.naturalWidth,
      naturalH: img.naturalHeight,
      thumbs: document.querySelectorAll('.pagethumb[data-page]').length,
      counter: document.querySelector('.editor__counter')?.textContent?.trim(),
    };
  });

  assert.equal(info.thumbs, 1, '应该有 1 个页面缩略图');
  assert.match(info.counter, /1\s*\/\s*1/, '页码应显示 1 / 1');
  // 去掉了照片的深色背景和倾斜 → 结果应该是"竖着的一张纸"
  assert.ok(info.naturalW > 400 && info.naturalH > 500, `裁剪结果尺寸异常：${info.naturalW}x${info.naturalH}`);
  assert.ok(info.naturalH > info.naturalW, 'A4 纸的结果应该是竖版');
  assert.deepEqual(errors, [], '导入过程不该报错');
  await ctx.close();
});

test('切换滤镜：预览真的会变，不是只有按钮高亮', needs, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file-input', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo });
  await waitForFullPreview(page);

  // 打开滤镜条
  await page.click('[data-act="filter"]');
  await page.waitForSelector('.filterchip', { timeout: 10000 });
  const chips = await page.$$eval('.filterchip', (els) => els.map((e) => e.dataset.filter));
  assert.ok(chips.length >= 4, `滤镜应该有好几个，实际只有 ${chips.join(',')}`);

  // 记下当前像素，切到"黑白"后再比一次——必须真的不一样
  const before = await page.evaluate(() => document.querySelector('#page-img').src);

  // 黑白滤镜：文字稿件应该变成接近纯黑白（深色像素占比明显升高）
  const bw = chips.includes('bw') ? 'bw' : chips[chips.length - 1];
  await page.click(`.filterchip[data-filter="${bw}"]`);
  await page.waitForFunction(
    (prev) => {
      const img = document.querySelector('#page-img');
      return img && img.complete && img.naturalWidth > 0 && img.src !== prev;
    },
    before,
    { timeout: 20000 }
  );
  // src 变了只说明缩略图换上了，深色占比要在完整预览上量才有意义
  await waitForFullPreview(page);

  const darkRatio = await page.evaluate(async () => {
    const img = document.querySelector('#page-img');
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, c.width, c.height);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 128) dark++;
    }
    return dark / (data.length / 4);
  });

  assert.ok(darkRatio > 0.01, `黑白滤镜后几乎全是白的（深色占比 ${(darkRatio * 100).toFixed(2)}%），文字可能被抹掉了`);
  assert.ok(darkRatio < 0.6, `黑白滤镜后大片纯黑（深色占比 ${(darkRatio * 100).toFixed(2)}%）`);
  assert.deepEqual(errors, [], '切滤镜不该报错');
  await ctx.close();
});

test('导出 PDF：下载到的文件是合法 PDF，且 Ghostscript 能解析', needs, async () => {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file-input', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo });
  await waitForFullPreview(page);

  await page.click('[data-act="share"]');
  await page.waitForSelector('.sheet__item[data-value="pdf"]', { timeout: 10000 });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('.sheet__item[data-value="pdf"]'),
  ]);

  const out = path.join(tmpDir, 'export.pdf');
  await download.saveAs(out);
  const bytes = fs.readFileSync(out);

  assert.ok(bytes.length > 5000, `PDF 太小了（${bytes.length} 字节），很可能是空的`);
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'PDF 头不对');
  assert.ok(bytes.includes(Buffer.from('%%EOF')), 'PDF 缺少 %%EOF 结尾');
  assert.ok(/\.pdf$/i.test(download.suggestedFilename()), `文件名应该是 .pdf：${download.suggestedFilename()}`);

  // 让 Ghostscript 真的解析一遍——这是"能不能打印、别人能不能打开"的硬证据。
  // 自己写的 PDF 生成器最怕的就是结构自洽但不符合规范。
  const gs = await new Promise((resolve) => {
    const p = spawn('gs', ['-dNOPAUSE', '-dBATCH', '-dQUIET', '-sDEVICE=nullpage', out], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => resolve({ ok: false, err: 'gs 没装' }));
    p.on('close', (code) => resolve({ ok: code === 0, err }));
  });
  if (gs.err === 'gs 没装') {
    console.log('（本机没装 Ghostscript，跳过 PDF 结构校验）');
  } else {
    assert.ok(gs.ok, `Ghostscript 解析 PDF 失败：${gs.err}`);
  }

  assert.deepEqual(errors, [], '导出不该报错');
  await ctx.close();
});

test('导出文字 / 长图 / ZIP 都能出文件', needs, async () => {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file-input', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo });
  await waitForFullPreview(page);

  for (const [kind, ext] of [
    ['long', /\.jpg$/i],
    ['zip', /\.zip$/i],
  ]) {
    await page.click('[data-act="share"]');
    await page.waitForSelector(`.sheet__item[data-value="${kind}"]`, { timeout: 10000 });
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.click(`.sheet__item[data-value="${kind}"]`),
    ]);
    const out = path.join(tmpDir, `export-${kind}`);
    await dl.saveAs(out);
    const bytes = fs.readFileSync(out);
    assert.ok(bytes.length > 1000, `${kind} 导出太小：${bytes.length} 字节`);
    assert.match(dl.suggestedFilename(), ext, `${kind} 文件名不对：${dl.suggestedFilename()}`);
    if (kind === 'zip') {
      assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK', 'zip 头不对');
    }
    if (kind === 'long') {
      assert.equal(bytes[0], 0xff, 'jpeg 头不对');
      assert.equal(bytes[1], 0xd8, 'jpeg 头不对');
    }
  }
  assert.deepEqual(errors, [], '导出不该报错');
  await ctx.close();
});

test('关掉页面再打开：文档还在（数据存在本机）', needs, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file-input', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo });
  await waitForFullPreview(page);

  // 回到首页再刷新（模拟"关掉 App 明天再打开"）
  await page.click('[data-act="back"]');
  await page.waitForSelector('.doccard', { timeout: 10000 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.doccard', { timeout: 10000 });

  const cards = await page.$$eval('.doccard', (els) => els.map((e) => e.textContent.trim()));
  assert.equal(cards.length, 1, `首页应该有 1 个文档，实际 ${cards.length}`);
  assert.match(cards[0], /1\s*页/, `文档卡片应显示 1 页：${cards[0]}`);

  // 点进去要能重新渲染出来
  await page.click('.doccard');
  await waitForFullPreview(page);
  assert.deepEqual(errors, [], '重新打开不该报错');
  await ctx.close();
});

test('断网也能打开（Service Worker 离线缓存）', needs, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });

  // 等 SW 把外壳装好
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(
    async () => {
      const keys = await caches.keys();
      if (!keys.length) return false;
      const c = await caches.open(keys[0]);
      const reqs = await c.keys();
      return reqs.length >= 8;
    },
    { timeout: 20000 }
  );

  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });

  // 断网后首页仍然要能出来
  await page.waitForSelector('[data-act="import"]', { timeout: 15000 });
  await ctx.setOffline(false);
  assert.deepEqual(errors, [], '离线打开不该报错');
  await ctx.close();
});

/**
 * 在线识别（DeepSeek）——用**假接口**跑，不花用户一分钱、不依赖外网。
 *
 * 要验证的是一条完整的链路，而不是某个函数：
 *   设置里存 Key → 单选按钮切引擎 → 点"开始识别" → 真的发出符合 OpenAI 格式的请求
 *   → 把返回的文字填进文本框 → 失败时给出人话提示。
 * 这里用 route 拦截 api.deepseek.com 来扮演服务端。
 */
test('在线 AI 识别：填了 Key 就能把返回的文字填进来（接口被打桩）', needs, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = watchErrors(page);

  // 扮演 DeepSeek：校验请求，返回一段"识别结果"
  let seen = null;
  await page.route('https://api.deepseek.com/**', async (route) => {
    const req = route.request();
    seen = { url: req.url(), method: req.method(), auth: req.headers()['authorization'], body: JSON.parse(req.postData() || '{}') };
    const wantsImage = seen.body?.messages?.[0]?.content?.some?.((c) => c.type === 'image_url');
    if (!wantsImage) {
      // 这是"测试 Key"那一发，回一句极短的
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { content: '房屋租赁合同\n\n第一条 甲方将房屋出租给乙方使用。' } }],
        usage: { total_tokens: 1234 },
      }),
    });
  });

  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file-input', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo });
  await waitForFullPreview(page);

  // 1) 设置里填 Key —— 存得住才有后面的一切
  await page.click('[data-act="back"]');
  await page.waitForSelector('.doccard', { timeout: 10000 });
  await page.click('[data-act="settings"]');
  await page.waitForSelector('input[data-set="aiKey"]', { timeout: 10000 });
  await page.fill('input[data-set="aiKey"]', 'sk-test-1234567890abcdef');
  await page.dispatchEvent('input[data-set="aiKey"]', 'change');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('scanfree.settings') || '{}').aiKey?.startsWith('sk-test'), {
    timeout: 10000,
  });

  // 2) "测试 Key"能识别出接口成功
  await page.click('[data-act="test-key"]');
  await page.waitForSelector('.toast', { timeout: 15000 });

  // 3) 进文档 → 文字识别 → 应该已经是"在线 AI"（有 Key 时 auto 就是在线）
  await page.click('[data-act="back"]');
  await page.waitForSelector('.doccard', { timeout: 10000 });
  await page.click('.doccard');
  await waitForFullPreview(page);
  await page.click('[data-act="ocr"]');
  await page.waitForSelector('#ocr-text', { timeout: 10000 });

  const onlineChecked = await page.$eval('input[name="engine"][value="online"]', (el) => el.checked);
  assert.ok(onlineChecked, '填了 Key 之后应当默认选中"在线 AI"');
  const note = await page.$eval('.ocr__note', (el) => el.textContent);
  assert.match(note, /会上传|上传到 DeepSeek/, '必须在界面上说清楚图片会被上传');

  // 4) 点开始识别，等结果落进文本框
  await page.click('[data-act="run"]');
  await page.waitForFunction(() => document.querySelector('#ocr-text')?.value?.includes('房屋租赁合同'), { timeout: 30000 });

  assert.ok(seen, '应该真的发出了请求');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(seen.auth, 'Bearer sk-test-1234567890abcdef');
  assert.ok(seen.body.messages[0].content[1].image_url.url.startsWith('data:image/jpeg;base64,'), '图片应当以 base64 data URL 传');
  assert.equal(seen.body.model, 'deepseek-flash');

  assert.deepEqual(errors, [], '在线识别流程不该报错');
  await ctx.close();
});

test('在线识别失败时：提示是人话，而且不丢掉已经识别出来的文字', needs, async () => {  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route('https://api.deepseek.com/**', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Authentication Fails' } }) })
  );
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('scanfree.settings', JSON.stringify({ ocrEngine: 'online', aiKey: 'sk-bad-1234567890abcdef' }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.setInputFiles('#file-input', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo });
  await waitForFullPreview(page);

  await page.click('[data-act="ocr"]');
  await page.waitForSelector('#ocr-text', { timeout: 10000 });
  // 先塞一段用户自己敲的字，失败后不能被清空
  await page.fill('#ocr-text', '我手打的内容');
  await page.click('[data-act="run"]');

  await page.waitForSelector('.toast--error', { timeout: 30000 });
  const msg = await page.$eval('.toast--error', (el) => el.textContent);
  assert.match(msg, /API Key 不对/, `错误提示应当是能照着做的中文：${msg}`);
  assert.equal(await page.$eval('#ocr-text', (el) => el.value), '我手打的内容', '识别失败不能把已有内容弄丢');
  await ctx.close();
});

/**
 * 隐私红线：进"文字识别"页时**不许**自动上传。
 *
 * 本地识别进页面就自动开跑是好事（省一次点击），但换成在线引擎，
 * "自动开跑"就等于用户只是点了个"文字"按钮，图片就被传出去、额度就被扣了。
 * 所以在线模式下必须停在原地等用户点"开始识别"。这条用"请求次数为 0"来锁死。
 */
test('隐私：在线模式下进识别页不会自动上传，必须手动点', needs, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let calls = 0;
  await page.route('https://api.deepseek.com/**', (route) => {
    calls++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) });
  });

  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('scanfree.settings', JSON.stringify({ ocrEngine: 'auto', aiKey: 'sk-demo-1234567890abcdef' }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.setInputFiles('#file-input', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo });
  await waitForFullPreview(page);

  await page.click('[data-act="ocr"]');
  await page.waitForSelector('#ocr-text', { timeout: 10000 });
  // 多等一会儿，确保不是"慢半拍才发"
  await page.waitForTimeout(1500);

  assert.equal(calls, 0, '还没点"开始识别"就把图片传出去了');
  const runBtn = await page.$eval('[data-act="run"]', (el) => el.className);
  assert.match(runBtn, /btn--pulse/, '应当提示用户手动点一下');

  // 点了才发
  await page.click('[data-act="run"]');
  await page.waitForFunction(() => true);
  await page.waitForTimeout(800);
  assert.equal(calls, 1, '点了之后应该正好发一次请求');
  await ctx.close();
});

test('导出文字版 PDF：字能选中、能搜索，Ghostscript 解析得了', needs, async () => {
  const ctx = await browser.newContext({ acceptDownloads: true });
  // 先声明成"在线引擎、有 Key"：在线模式绝不会自动开跑，
  // 于是不会弹出 20MB 本地模型的加载遮罩挡住按钮（这是用户的真实选择之一）。
  // 后面全程不点"开始识别"，所以不会有任何图片被真的上传。
  await ctx.addInitScript(() => {
    localStorage.setItem('scanfree.settings', JSON.stringify({ ocrEngine: 'online', aiKey: 'sk-test-local-only' }));
  });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.route('https://api.deepseek.com/**', (route) => route.abort());
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file-input', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo });
  await waitForFullPreview(page);

  // 走真实路径把文字存进这一页：不跑 OCR（那要下载 20MB 模型 / 要 Key），
  // 直接在识别页的文本框里输入后"保存到文档"——这也是用户改错字的正常用法
  const typed = '房屋租赁合同\n出租方：张明  身份证号：3101********1234\n第一条 甲方将位于本市南京西路 1000 号的房屋出租给乙方居住使用。';
  await page.click('[data-act="ocr"]');
  await page.waitForSelector('#ocr-text', { timeout: 10000 });
  await page.fill('#ocr-text', typed);
  await page.click('[data-act="save"]');
  await page.click('[data-act="back"]');
  await page.waitForSelector('#page-img', { timeout: 10000 });

  await page.click('[data-act="share"]');
  await page.waitForSelector('.sheet__item[data-value="textpdf"]', { timeout: 10000 });
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('.sheet__item[data-value="textpdf"]'),
  ]);
  const out = path.join(tmpDir, 'text.pdf');
  await dl.saveAs(out);
  const bytes = fs.readFileSync(out);
  const t = bytes.toString('latin1');

  assert.match(dl.suggestedFilename(), /\.pdf$/i, `文件名不对：${dl.suggestedFilename()}`);
  assert.equal(t.slice(0, 5), '%PDF-', 'PDF 头不对');
  assert.ok(bytes.length < 20 * 1024, `文字版应当只有几 KB，实际 ${bytes.length} 字节`);

  // 字得真的在里面（中文按 UTF-16BE 的十六进制写在内容流里）
  const hex = [...typed.replace(/\s/g, '')].slice(0, 6).map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase();
  assert.ok(t.toUpperCase().includes(hex), '内容流里找不到刚输入的中文');

  // 真解析一遍
  const GS = ['/opt/homebrew/bin/gs', '/usr/local/bin/gs', '/usr/bin/gs'].find((p) => fs.existsSync(p));
  if (GS) {
    const r = spawnSync(GS, ['-dNOPAUSE', '-dBATCH', '-dQUIET', '-sDEVICE=nullpage', '-dPDFSTOPONERROR', out], {
      stdio: 'pipe',
      timeout: 60000,
    });
    assert.equal(r.status, 0, 'Ghostscript 解析失败：' + String(r.stderr));
  }
  assert.deepEqual(errors, [], '导出不该报错');
  await ctx.close();
});
