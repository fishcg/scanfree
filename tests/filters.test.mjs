/**
 * 图像增强算法测试。
 *
 * 这是整个 App 最核心也最容易悄悄坏掉的部分——滤镜错一点点，
 * 人眼在缩略图上根本看不出来，导出的 PDF 却是一片灰。
 * 所以这里用**合成图**做可断言的测试：造一张"有阴影的纸 + 黑字 + 红章"的假照片，
 * 检查每个滤镜是不是真的做到了它承诺的事。
 *
 * 两个关键的比例尺说明（决定了"到底该断言什么"）：
 *  1. 去阴影靠的是"局部取最亮当白场再相除"，窗口是 32px 的格子。
 *     所以残留的明暗差正比于**一个格子内部的亮度变化**。
 *     同样 150 级的阴影，铺在 240px 宽的图上，一个格子内就有 20 级；
 *     铺在 1600px 的真实照片上，一个格子内只有 3 级——残留小了近 7 倍。
 *     所以测试用真实分辨率（1600×1200）验证"承诺"，另外单独用低分辨率
 *     记录已知限制，而不是反过来为了迁就合成图去放松标准。
 *  2. 不能用 assert.deepEqual 比 20 万个元素的数组：不相等时断言库会去构造
 *     完整差异，实测直接把进程撑到被系统 kill。用 assertSamePixels 逐字节比。
 *
 * applyFilter 是纯函数（只吃 {data,width,height}，返回新对象），不碰 DOM，
 * 所以能直接在 Node 里跑。
 *
 * 运行：node --test tests/filters.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilter, FILTERS } from '../js/render.js';

/* --------------------------- 合成测试图 --------------------------- */

const LIGHT_RAMP = 150; // 从左到右的光照落差（模拟单侧阴影）

/**
 * 造一张模拟"手机拍的纸"（几何量都用比例表示，方便换分辨率）：
 *  - 左暗右亮的渐变光照
 *  - 中间一条深色"文字"横条（值 35）
 *  - 右下角一块红色"印章"（200,40,40）
 */
function makeFakePhotoAt(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const fx = x / w;
      const fy = y / h;
      // 光照：左暗右亮，再叠一点纵向变化
      const light = 255 - LIGHT_RAMP + fx * LIGHT_RAMP + Math.sin(fy) * 6;
      let r = light;
      let g = light;
      let b = light * 1.03; // 手机白平衡常偏蓝一点

      // 文字横条
      if (fx >= 1 / 6 && fx < 5 / 6 && fy >= 0.4 && fy < 0.5) {
        r = g = b = 35;
      }
      // 红色印章
      if (fx >= 0.73 && fx < 0.94 && fy >= 0.7 && fy < 0.95) {
        r = 200;
        g = 40;
        b = 40;
      }

      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** 默认尺寸的合成图（多数测试用这个就够） */
const makeFakePhoto = (w = 240, h = 200) => makeFakePhotoAt(w, h);

/** 按比例取样：p = [fx, fy]，返回 [r,g,b] */
const at = (img, fx, fy) => {
  const x = Math.min(img.width - 1, Math.round(fx * img.width));
  const y = Math.min(img.height - 1, Math.round(fy * img.height));
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

// 取样点（避开文字与印章）
const BG_DARK = [0.04, 0.08]; // 阴影最重的一角
const BG_MID = [0.5, 0.1];
const BG_LIGHT = [0.96, 0.12]; // 光照最好的一侧
const TEXT = [0.5, 0.45];
const SEAL = [0.83, 0.83];

/** 背景三点的亮度——衡量"阴影被拉平了多少" */
const bgSpread = (img) => {
  const v = [BG_DARK, BG_MID, BG_LIGHT].map(([fx, fy]) => lum(at(img, fx, fy)));
  return { dark: v[0], mid: v[1], light: v[2], spread: Math.max(...v) - Math.min(...v) };
};

/**
 * 逐字节比较两个像素缓冲，只报第一个不同的位置（不用 deepEqual，见文件头说明）。
 */
function assertSamePixels(a, b, msg) {
  if (a.length !== b.length) assert.fail(`${msg}：长度不同 ${a.length} vs ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      const px = i >> 2;
      assert.fail(`${msg}：首个差异在第 ${px} 像素的第 ${i % 4} 通道：${a[i]} vs ${b[i]}`);
    }
  }
}

/* ------------------------------ 基础 ------------------------------ */

test('滤镜清单完整且 id 唯一', () => {
  assert.ok(FILTERS.length >= 5);
  const ids = FILTERS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复');
  for (const need of ['original', 'magic', 'grayClean', 'bw', 'lighten', 'gray']) {
    assert.ok(ids.includes(need), `应包含 ${need} 滤镜`);
  }
  for (const f of FILTERS) {
    assert.ok(f.name && f.hint, `${f.id} 应有中文名与说明`);
  }
});

test('original：零拷贝直接返回输入', () => {
  const src = makeFakePhoto();
  assert.equal(applyFilter(src, 'original'), src);
  assertSamePixels(src.data, makeFakePhoto().data, '原图模式必须完全透传');
});

test('applyFilter 不修改传入的 ImageData（这是曾经的真实 bug）', () => {
  // 曾经的实现是原地改写像素，后果：
  // 用户在"增强 → 灰度 → 增强"之间来回点时，每一轮都在上一次的结果上再算一遍，
  // 越点越糊；而且应用过"增强"后再切回"原图"也回不去了。
  for (const f of FILTERS) {
    const src = makeFakePhoto();
    const pristine = makeFakePhoto();
    const out = applyFilter(src, f.id);
    assertSamePixels(src.data, pristine.data, `${f.id} 修改了调用方的缓冲`);
    if (f.id !== 'original') assert.notEqual(out, src, `${f.id} 应返回新对象`);
  }
});

test('滤镜是确定性的，且反复应用不会污染原图', () => {
  // 注意这里不能断言"应用两次 == 应用一次"：那要求滤镜幂等，
  // 而增强本来就不是幂等的（对已经拉白过一遍的图再增强，确实会再变一点），
  // 幂等既不是用户要的，也不是这个滤镜承诺的。
  // 用户真正需要的是：UI 里反复点预览时，每次都从**原图**重新算，
  // 所以这里验证的是"确定性 + 原图不被污染"。
  const src = makeFakePhoto();
  const pristine = makeFakePhoto();
  for (const f of FILTERS) {
    const first = applyFilter(src, f.id).data;
    applyFilter(src, f.id);
    applyFilter(src, f.id);
    const again = applyFilter(src, f.id).data;
    assertSamePixels(first, again, `${f.id} 同一输入两次结果不一致（非确定性）`);
    assertSamePixels(src.data, pristine.data, `${f.id} 反复应用后原图被改坏了`);
  }
});

test('切回原图能拿回最初的像素（用户改主意时的体验）', () => {
  const src = makeFakePhoto();
  const pristine = makeFakePhoto();
  // 模拟用户的真实操作序列：原图 → 增强 → 灰度 → 增强 → 原图
  applyFilter(src, 'magic');
  applyFilter(src, 'grayClean');
  applyFilter(src, 'magic');
  const back = applyFilter(src, 'original');
  assertSamePixels(back.data, pristine.data, '切回"原图"必须原样恢复');
});

test('未知滤镜 id 按原图处理，不抛异常也不乱改', () => {
  const out = applyFilter(makeFakePhoto(), 'no-such-filter');
  assertSamePixels(out.data, makeFakePhoto().data, '未知滤镜不应偷偷套用增强');
});

test('所有滤镜都能处理 1×1 的极端小图而不崩', () => {
  for (const f of FILTERS) {
    const img = { data: new Uint8ClampedArray([128, 128, 128, 255]), width: 1, height: 1 };
    const out = applyFilter(img, f.id);
    assert.equal(out.width, 1, `${f.id} 应保持宽高`);
    assert.equal(out.data.length, 4, `${f.id} 应返回同样长度的数据`);
    assert.equal(out.data[3], 255, `${f.id} 应保持不透明`);
  }
});

test('alpha 通道始终保持 255（不能拍出透明纸）', () => {
  for (const f of FILTERS) {
    const out = applyFilter(makeFakePhoto(), f.id);
    for (let i = 3; i < out.data.length; i += 4) {
      assert.equal(out.data[i], 255, `${f.id} 在像素 ${i >> 2} 处产生了透明`);
    }
  }
});

/* --------------------------- 真实分辨率 --------------------------- */

// 手机随手拍一张 A4，短边通常也有 1500px 以上。这里用 1600×1200 代表真实场景。
const REAL_W = 1600;
const REAL_H = 1200;

test('magic：实拍分辨率下阴影被拉平，整张纸接近纯白', () => {
  const out = applyFilter(makeFakePhoto(REAL_W, REAL_H), 'magic');
  const { dark, mid, light, spread } = bgSpread(out);

  assert.ok(dark > 225, `阴影角也应接近纯白（实测 ${dark.toFixed(0)}）`);
  assert.ok(mid > 225, `中间区应接近纯白（实测 ${mid.toFixed(0)}）`);
  assert.ok(light > 225, `明亮区应接近纯白（实测 ${light.toFixed(0)}）`);
  // 输入的光照落差是 150 级，处理后应压到很小，肉眼看不到"一边灰一边白"
  assert.ok(spread < 25, `背景亮度极差应压到 25 以内（实测 ${spread.toFixed(0)}，处理前 ${LIGHT_RAMP}）`);
});

test('magic：实拍分辨率下文字依然是清晰的黑', () => {
  const out = applyFilter(makeFakePhoto(REAL_W, REAL_H), 'magic');
  const text = lum(at(out, ...TEXT));
  const bg = lum(at(out, ...BG_MID));
  assert.ok(text < 120, `文字应保持深色（实测 ${text.toFixed(0)}）`);
  assert.ok(bg - text > 100, `对比度应大于 100（实测 ${(bg - text).toFixed(0)}）`);
});

test('magic：保留色彩，红章不会变成灰', () => {
  const out = applyFilter(makeFakePhoto(), 'magic');
  const [r, g, b] = at(out, ...SEAL);
  assert.ok(r > g + 40 && r > b + 40, `红章应保持红色（实测 r=${r} g=${g} b=${b}）`);
  assert.ok(r > 150, `红章应仍然鲜亮（实测 r=${r}）`);
});

test('灰度滤镜：实拍分辨率下同样去阴影，且输出是纯灰', () => {
  for (const id of ['grayClean', 'gray']) {
    const out = applyFilter(makeFakePhoto(REAL_W, REAL_H), id);
    for (const [fx, fy] of [BG_DARK, BG_LIGHT, TEXT, SEAL]) {
      const [r, g, b] = at(out, fx, fy);
      assert.ok(Math.abs(r - g) <= 1 && Math.abs(g - b) <= 1, `${id} 在 (${fx},${fy}) 应为灰：${r},${g},${b}`);
    }
    if (id === 'grayClean') {
      const { dark, spread } = bgSpread(out);
      assert.ok(dark > 215, `去阴影后阴影角应变白（实测 ${dark.toFixed(0)}）`);
      assert.ok(spread < 35, `背景极差应压到 35 以内（实测 ${spread.toFixed(0)}）`);
      assert.ok(lum(at(out, ...TEXT)) < 120, '文字应保持深色');
    }
  }
});

/* ---------------- 分辨率耐受性与"深色块不许被洗白" ---------------- */

test('magic：从 150px 缩略图到 2400px 大图，文字始终是深色、背景始终是亮色', () => {
  // 去阴影靠"局部取最亮当白场"，白场窗口约 224px：
  // 图越小，窗口占的比例越大，小到 150px 时窗口已经盖住全图，退化成"整张图一个白场"，
  // 光照就拉不平了（见下一条测试）。但**退化必须是安全的**：
  // 无论多小的图，都不能出现"字被洗白"或"背景变黑"这种真正的坏结果。
  for (const [w, h] of [[150, 120], [240, 200], [480, 360], [800, 600], [1600, 1200], [2400, 1800]]) {
    const out = applyFilter(makeFakePhotoAt(w, h), 'magic');
    const text = lum(at(out, ...TEXT));
    const bgDark = lum(at(out, ...BG_DARK));
    const bgLight = lum(at(out, ...BG_LIGHT));
    assert.ok(text < 60, `${w}px：文字应为深色（实测 ${text.toFixed(0)}）`);
    assert.ok(bgDark > 100, `${w}px：最暗的背景也不能发黑（实测 ${bgDark.toFixed(0)}）`);
    assert.ok(bgLight > 200, `${w}px：明亮背景应接近白（实测 ${bgLight.toFixed(0)}）`);
    assert.ok(bgDark - text > 80, `${w}px：明暗对比应拉开（实测 ${(bgDark - text).toFixed(0)}）`);
  }
});

test('magic：图越大去阴影越彻底（记录分辨率的实际影响）', () => {
  const spreadAt = (w, h) => bgSpread(applyFilter(makeFakePhotoAt(w, h), 'magic')).spread;
  const s150 = spreadAt(150, 120);
  const s240 = spreadAt(240, 200);
  const s1600 = spreadAt(1600, 1200);
  assert.ok(s1600 < s240, `1600px 应比 240px 平（实测 ${s1600.toFixed(0)} vs ${s240.toFixed(0)}）`);
  assert.ok(s240 < s150, `240px 应比 150px 平（实测 ${s240.toFixed(0)} vs ${s150.toFixed(0)}）`);
  assert.ok(s1600 < 25, `实拍分辨率下应基本拉平（实测 ${s1600.toFixed(0)} / 输入落差 ${LIGHT_RAMP}）`);
});

/** 造一张"带一条深色横条"的合成图，条从 40% 高度开始，横向占 20%~80% */
function withBar(w, h, barPx) {
  const img = makeFakePhotoAt(w, h);
  const y0 = Math.round(h * 0.4);
  const y1 = Math.min(h, y0 + barPx);
  for (let y = y0; y < y1; y++) {
    for (let x = Math.round(w * 0.2); x < w * 0.8; x++) {
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 30;
    }
  }
  return { img, midY: Math.min(h - 1, Math.round(y0 + barPx / 2)) };
}

test('magic：比白场窗口小的深色块保持纯黑（粗体标题、表格线、印章这类真实情况）', () => {
  // 这是修过的一个真 bug：白场图按 32px 格子取局部最大值，
  // 一块比格子大的深色区域内部，格子取到的"最亮"就是深色本身
  // → 白场被低估 → 除以它相当于把那块区域"提亮成白纸"，粗体字被掏成空心。
  // 240px 合成图里文字条只有 20px 高、比格子还小，所以完全测不出来；
  // 换成真实分辨率（文字条 120px 高）立刻暴露（当时实测亮度 131，接近白纸）。
  // 现在靠"邻域最大值扩散"（radius=3，约 224px 窗口）把周围的纸白漫进去解决。
  // 下面这些厚度都 ≤ 窗口，覆盖了实际会遇到的绝大多数深色块。
  for (const [w, h, barPx] of [[240, 200, 30], [800, 600, 120], [1600, 1200, 150], [2400, 1800, 220]]) {
    const { img, midY } = withBar(w, h, barPx);
    const out = applyFilter(img, 'magic');
    const inside = lum(at(out, 0.5, midY / h));
    // 纸白取色块正上方（同一片光照里），比取远处的对角更公平：
    // 小图上阴影本来就没被拉平，拿阴影角去比会把两件事混在一起。
    const paper = lum(at(out, 0.5, 0.15));
    assert.ok(inside < 60, `${w}px、${barPx}px 厚色块内部应仍是深色（实测 ${inside.toFixed(0)}）`);
    assert.ok(paper - inside > 120, `${w}px：色块与纸的对比应保住（实测 ${paper.toFixed(0)} vs ${inside.toFixed(0)}）`);
  }
});

test('magic：超厚色块的残差有上限，且不随色块变大而恶化', () => {
  // 厚度超过白场窗口（>224px）的实心色块，窗口够不到外面的纸白，
  // 于是白场仍被低估。这时兜底的是增益上限 MAX_GAIN=3：
  // 它把"最坏情况"从"洗成白纸"（修之前是 131 以上、越厚越白）
  // 压成"留一层固定的灰"——注意下面的数字不随色块变厚而变大，会饱和在一个常数上，
  // 这正是增益上限该有的行为：与窗口大小、与色块尺寸都无关。
  //
  // 为什么干脆不把窗口开大到覆盖一切：窗口一大，白场就会取自 500px 外的明亮区域，
  // 阴影里的纸反而拉不白了——"去阴影"是这个 App 的招牌功能，不能被牺牲。
  // 所以这里选择"极端情况留一点灰"，并且真正的黑白模式（bw）在这类色块上依然是纯黑（见下一条测试）。
  const cases = [[1600, 1200, 300], [2400, 1800, 300], [2400, 1800, 600], [1200, 900, 900]];
  const values = cases.map(([w, h, barPx]) => {
    const { img, midY } = withBar(w, h, barPx);
    const out = applyFilter(img, 'magic');
    const inside = lum(at(out, 0.5, midY / h));
    const paper = lum(at(out, 0.5, 0.15));
    assert.ok(inside <= 90, `${w}px、${barPx}px 厚色块不应被洗白（实测 ${inside.toFixed(0)}，修之前为 131 以上）`);
    assert.ok(paper - inside > 100, `${w}px：仍应明显比纸暗（实测 ${paper.toFixed(0)} vs ${inside.toFixed(0)}）`);
    return inside;
  });
  const spreadAcrossSizes = Math.max(...values) - Math.min(...values);
  assert.ok(
    spreadAcrossSizes <= 20,
    `残差不该随色块变厚而增长，应饱和（实测 ${values.map((v) => v.toFixed(0)).join('/')}）`,
  );
});

test('bw：超大深色块在任何厚度下都是实心黑（黑白模式是最稳的那条路）', () => {
  for (const [w, h, barPx] of [[1600, 1200, 300], [2400, 1800, 600], [1200, 900, 900]]) {
    const { img, midY } = withBar(w, h, barPx);
    const out = applyFilter(img, 'bw');
    const px = (x, y) => out.data[(y * w + x) * 4];
    assert.equal(px(Math.round(w * 0.5), midY), 0, `${w}px、${barPx}px 厚色块内部必须是纯黑`);
    assert.equal(px(100, 100), 255, '空白纸应为白');
    // 避开右下角的红章（合成图 fx 0.73~0.94 / fy 0.7~0.95）：红章在黑白模式下本来就该是黑的
    assert.equal(px(1500, 200), 255, '右上角空白纸应为白');
  }
});

/* ------------------------------ 黑白 ------------------------------ */

test('bw：输出只有 0 和 255，文字为黑、背景为白', () => {
  const out = applyFilter(makeFakePhoto(REAL_W, REAL_H), 'bw');
  for (let i = 0; i < out.data.length; i += 4) {
    assert.equal(out.data[i], out.data[i + 1], '二值化后 R=G=B');
    assert.equal(out.data[i], out.data[i + 2], '二值化后 R=G=B');
    assert.ok(out.data[i] === 0 || out.data[i] === 255, `只能出现 0/255，实测出现 ${out.data[i]}`);
  }
  assert.equal(at(out, ...TEXT)[0], 0, '文字应为纯黑');
  assert.equal(at(out, ...BG_DARK)[0], 255, '阴影区背景应为纯白');
  assert.equal(at(out, ...BG_LIGHT)[0], 255, '明亮区背景应为纯白');
});

test('bw：粗笔画与实心色块不会被掏空（局部阈值的老毛病）', () => {
  // 真实文档里有大量"比任何局部窗口都大"的深色块：粗体标题、表格粗线、印章、照片。
  // 用局部均值做自适应阈值时，这些色块内部会被判成"背景"而掏成空心甚至整片消失。
  // 这里直接造一条 80px 高的粗黑条（远超任何窗口），检查它是否还是实心黑。
  const w = 800;
  const h = 600;
  const img = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const inBar = y > 200 && y < 320 && x > 100 && x < 700;
      const v = inBar ? 20 : 235;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  }
  const out = applyFilter(img, 'bw');
  const px = (x, y) => out.data[(y * w + x) * 4];
  assert.equal(px(400, 260), 0, '粗黑条中心必须是黑，不能被掏空');
  assert.equal(px(110, 260), 0, '粗黑条边缘也应是黑');
  assert.equal(px(690, 260), 0, '粗黑条另一端同样');
  assert.equal(px(50, 50), 255, '空白处应为白');
  assert.equal(px(750, 550), 255, '另一角空白处应为白');
});

test('bw：均匀的灰纸不会被判出一层噪点', () => {
  // 对着白纸拍了一张、几乎没有明暗差时，阈值算法硬要在噪声里找分界，
  // 会把干净的纸拍出一层麻点。这条保证有兜底。
  const w = 400;
  const h = 300;
  const img = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  for (let i = 0; i < w * h; i++) {
    const v = 200 + (i % 7);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  const out = applyFilter(img, 'bw');
  let black = 0;
  for (let i = 0; i < out.data.length; i += 4) if (out.data[i] === 0) black++;
  assert.equal(black, 0, `均匀灰纸应全白，实测有 ${black} 个黑点`);
});

/* ------------------------------ 增亮 ------------------------------ */

test('lighten：整体变亮但不改变相对明暗关系', () => {
  const src = makeFakePhoto();
  const out = applyFilter(src, 'lighten');
  const before = lum(at(src, ...BG_DARK));
  const after = lum(at(out, ...BG_DARK));
  assert.ok(after > before, `暗部应被提亮（${before.toFixed(0)} → ${after.toFixed(0)}）`);
  assert.ok(after <= 255);
  assert.ok(lum(at(out, ...TEXT)) < lum(at(out, ...BG_MID)), '文字仍应比背景暗');
  const [r, g, b] = at(out, ...SEAL);
  assert.ok(r > g + 30 && r > b + 30, '增亮不应破坏色彩');
});
