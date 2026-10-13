/**
 * sw.js 的预缓存清单必须和磁盘上的文件对得上。
 *
 * 为什么值得专门测：Service Worker 用 cache.addAll(SHELL) 安装外壳，
 * 而 addAll 只要**有一个**请求 404 就整体失败——表现是"离线打开白页"，
 * 控制台里也只有一条不显眼的安装失败，很容易发到用户手上才发现。
 *
 * 这个坑是真实踩到的：删掉一个没人引用的 js/enhance.js 时，
 * 它仍然躺在 SHELL 清单里。所以两个方向都要测：
 *   1) 清单里写的文件必须真的存在；
 *   2) 磁盘上的 js/ 文件（以及图标、样式）必须都被清单收进去，
 *      否则离线时会缺文件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function readShell() {
  const src = await readFile(join(ROOT, 'sw.js'), 'utf8');
  const block = src.match(/const SHELL\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(block, 'sw.js 里找不到 SHELL 数组');
  const entries = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const version = src.match(/const CACHE_VERSION\s*=\s*'([^']+)'/);
  return { entries, version: version?.[1] };
}

test('SHELL 清单里的每个文件都真实存在（少一个就会导致离线安装整体失败）', async () => {
  const { entries } = await readShell();
  assert.ok(entries.length > 10, `预缓存清单只有 ${entries.length} 项，看起来没解析对`);

  const missing = [];
  for (const rel of entries) {
    // './' 表示目录本身，等于 index.html
    const target = rel === './' ? join(ROOT, 'index.html') : join(ROOT, rel);
    try {
      await readFile(target);
    } catch {
      missing.push(rel);
    }
  }
  assert.deepEqual(missing, [], `这些文件在 SHELL 清单里但磁盘上没有：${missing.join(', ')}`);
});

test('js/ 下的每个模块都被收进 SHELL（漏了就会离线缺文件）', async () => {
  const { entries } = await readShell();
  const listed = new Set(entries.map((e) => e.replace(/^\.\//, '')));
  const files = (await readdir(join(ROOT, 'js'))).filter((f) => f.endsWith('.js'));

  const missing = files.filter((f) => !listed.has(`js/${f}`));
  assert.deepEqual(missing, [], `这些模块没写进 SHELL 预缓存：${missing.join(', ')}`);
});

test('图标和样式表都在 SHELL 里，且样式确实存在于磁盘', async () => {
  const { entries } = await readShell();
  const listed = new Set(entries);

  // 图标是"添加到主屏幕"后显示的，缺了会是一个白方块
  for (const icon of ['assets/icon-192.png', 'assets/icon-512.png', 'assets/icon-maskable-512.png']) {
    assert.ok(listed.has(`./${icon}`), `${icon} 没被预缓存，离线加到主屏会没有图标`);
  }
  assert.ok(listed.has('./css/app.css'), '样式表没被预缓存，离线打开会变成裸 HTML');

  // manifest 也必须在，否则离线时拿不到应用信息
  assert.ok(listed.has('./manifest.webmanifest'), 'manifest 没被预缓存');

  const css = await readFile(join(ROOT, 'css/app.css'), 'utf8');
  assert.ok(css.length > 1000, 'app.css 内容少得可疑');
});

test('CACHE_VERSION 存在且长得像个版本号（改名才会触发旧缓存清理）', async () => {
  const { version } = await readShell();
  assert.ok(version, 'sw.js 里找不到 CACHE_VERSION');
  assert.match(version, /^[a-z0-9._-]+$/i, `CACHE_VERSION 里不该有空格或引号：${version}`);
});
