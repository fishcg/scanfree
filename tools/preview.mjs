/**
 * 开发用：把 App 的真实界面截成图，顺便验证"照片 → 扫描件"的效果。
 *
 *   node tools/preview.mjs [输出目录]
 *
 * 产物：
 *   home.png      首页
 *   01-imported.png  导入后（自动裁边 + 默认增强）
 *   02-crop.png      裁边界面
 *   03-bw.png        黑白滤镜
 *   04-list.png      文档列表
 *   pdf-page-1.png   导出的 PDF 第一页（用 Ghostscript 渲染，验证 PDF 真的能打开）
 *
 * 为什么值得存在：单元测试能证明算法算得对，证明不了界面是不是一团糟。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'preview'));
const require = createRequire(import.meta.url);
const PORT = 8799;

function loadPlaywright() {
  for (const c of ['playwright', '/opt/homebrew/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright']) {
    try {
      return require(c);
    } catch {}
  }
  throw new Error('没找到 playwright，先 npm i -g playwright 并 npx playwright install chromium');
}

function findChromium() {
  const roots = [
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
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
      const m = name.match(/^(?:chromium_headless_shell|chromium)-(\d+)$/);
      if (!m) continue;
      for (const c of [
        path.join(root, name, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
        path.join(root, name, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
        path.join(root, name, 'chrome-linux', 'chrome'),
      ]) {
        if (fs.existsSync(c)) found.push({ build: Number(m[1]), path: c });
      }
    }
  }
  found.sort((a, b) => b.build - a.build);
  return found[0]?.path || null;
}

const pw = loadPlaywright();
fs.mkdirSync(OUT, { recursive: true });

// 起静态服务器
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${BASE}/index.html`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 120));
}

const exe = findChromium();
const browser = await pw.chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await browser.newContext({ viewport: { width: 414, height: 860 }, deviceScaleFactor: 2, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

// —— 造一张"手机拍的合同照片" ——
const shot = await ctx.newPage();
await shot.setViewportSize({ width: 1000, height: 1300 });
await shot.setContent(`
  <style>
    html,body{margin:0;height:100%}
    body{background:#3b3b3b;display:flex;align-items:center;justify-content:center}
    .paper{width:760px;height:1040px;background:#fdfdfb;padding:60px 70px;box-sizing:border-box;
      font-family:"Songti SC",serif;color:#111;transform:rotate(-1.6deg);box-shadow:0 30px 80px rgba(0,0,0,.55);
      background-image:linear-gradient(115deg, rgba(0,0,0,.16) 0%, rgba(0,0,0,0) 42%)}
    h1{font-size:38px;text-align:center;margin:0 0 8px;letter-spacing:6px}
    .sub{text-align:center;color:#666;font-size:17px;margin-bottom:34px}
    p{font-size:20px;line-height:2.05;margin:0 0 14px;text-align:justify}
    .sign{margin-top:44px;text-align:right;font-size:20px}
    table{width:100%;border-collapse:collapse;margin:22px 0;font-size:18px}
    td,th{border:1px solid #333;padding:9px 12px}th{background:#eee}
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
  </div>`);
const photoPath = path.join(OUT, 'fake-photo.jpg');
fs.writeFileSync(photoPath, await shot.screenshot({ type: 'jpeg', quality: 92 }));
await shot.close();

// —— 走一遍真实流程 ——
await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
await page.screenshot({ path: path.join(OUT, 'home.png') });

await page.setInputFiles('#file-input', photoPath);
await page.waitForFunction(() => document.querySelector('#page-img')?.naturalWidth > 0, { timeout: 20000 });
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, '01-imported.png') });

// 裁边界面
await page.click('[data-act="crop"]');
await page.waitForSelector('#crop-canvas', { timeout: 10000 });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, '02-crop.png') });
await page.click('[data-act="ok"]'); // 裁边是整页视图，点「完成」回到编辑页
await page.waitForTimeout(500);

// 黑白滤镜
await page.click('[data-act="filter"]');
await page.waitForSelector('.filterchip[data-filter="bw"]', { timeout: 10000 });
await page.click('.filterchip[data-filter="bw"]');
await page.waitForTimeout(700);
await page.screenshot({ path: path.join(OUT, '03-bw.png') });
await page.click('[data-act="filter"]'); // 收起滤镜条
await page.waitForTimeout(300);

// 导出 PDF 并用 Ghostscript 渲染成图片
await page.click('[data-act="share"]');
await page.waitForSelector('.sheet__item[data-value="pdf"]', { timeout: 10000 });
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.sheet__item[data-value="pdf"]')]);
const pdfPath = path.join(OUT, 'export.pdf');
await dl.saveAs(pdfPath);
await new Promise((resolve) => {
  const p = spawn('gs', ['-dNOPAUSE', '-dBATCH', '-dQUIET', '-sDEVICE=png16m', '-r90', `-sOutputFile=${path.join(OUT, 'pdf-page-%d.png')}`, pdfPath], { stdio: 'ignore' });
  p.on('close', resolve);
  p.on('error', resolve);
});

// 首页文档列表
await page.click('[data-act="back"]');
await page.waitForSelector('.doccard', { timeout: 10000 });
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, '04-list.png') });

console.log('截图输出到：' + OUT);
console.log(errors.length ? '⚠️ 页面报错：\n' + errors.join('\n') : '✅ 全程无页面报错');
console.log('文件：' + fs.readdirSync(OUT).sort().join('  '));

await browser.close();
server.kill();
