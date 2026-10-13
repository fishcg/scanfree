/**
 * Service Worker —— 让这个 App 断网也能用。
 *
 * 为什么这件事对"扫描 App"特别重要：用户拍的是自己的证件、合同、发票，
 * 这类场景经常发生在没有信号的地方（地下室、电梯口、出差路上、飞机上）。
 * 一个"必须先联网才能打开"的扫描工具，在最需要它的时候恰好不能用。
 *
 * 策略（刻意保持简单，因为缓存策略太花哨反而容易出现"更新了却还是旧版"的鬼故事）：
 *  - 应用外壳（HTML/CSS/JS/图标）：**cache-first**。装过一次后秒开，且完全离线可用。
 *  - 页面导航请求：**network-first**，拿不到网络再回缓存里的 index.html。
 *    这样联网时一刷新就能拿到新版，断网时也能打开。
 *  - 其余跨域请求（比如 OCR 的 CDN）：不插手，直接放行。
 *
 * 升级方式：改下面的 CACHE_VERSION，旧的缓存会在 activate 时清掉。
 * 千万不要在没改版本号的情况下改文件内容并指望用户拿到新的——
 * cache-first 会老老实实一直发旧的。
 */

const CACHE_VERSION = 'scanfree-v2';

// 应用外壳：这些文件必须一次性全部缓存成功，否则离线打开会缺胳膊少腿
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/ui.js',
  './js/store.js',
  './js/render.js',
  './js/pipeline.js',
  './js/crop.js',
  './js/detect.js',
  './js/geometry.js',
  './js/pdf.js',
  './js/zip.js',
  './js/ocr.js',
  './js/ai.js',
  './js/camera.js',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-180.png',
  './assets/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // 用 addAll 而不是逐个 add：任何一个 404 都会让整次安装失败，
      // 这是好事——宁可不装，也不要装一个"看起来能离线其实少了文件"的壳。
      await cache.addAll(SHELL);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域（OCR 的 CDN 等）不插手

  // 后端接口一律不碰：/api/health 探的是"本站现在有没有开通免费识别"，
  // 要是被 cache-first 存下来，用户装过一次之后就永远看到旧答案，服务端
  // 改了配置也不会变（而且 /api/ocr 那种带图带字的响应更不该进缓存）。
  if (url.pathname.startsWith('/api/')) return;

  // 页面导航：先网络，失败再回缓存的首页
  if (req.mode === 'navigate') {
    e.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE_VERSION);
          cache.put('./index.html', fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE_VERSION);
          return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
        }
      })()
    );
    return;
  }

  // 静态资源：先缓存，没有再取网络（取到就顺手存下来）
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      } catch (err) {
        return new Response('离线且未缓存：' + url.pathname, {
          status: 504,
          statusText: 'Offline',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })()
  );
});
