/**
 * render.js —— 图像处理核心（扫描件"变好看"的全部算法都在这里）。
 *
 * 复刻扫描全能王最有价值的那部分能力：把手机随手拍的照片，
 * 处理成一张白底黑字、边缘干净、体积很小的"扫描件"。
 *
 * 纯 Canvas + TypedArray 实现，没有任何 WASM / 第三方库，秒级完成，离线可用。
 * 每个滤镜都做了降采样加速（阴影估计、局部二值化都在 1/2~1/4 分辨率上算），
 * 因此中低端手机也能流畅处理 1200 万像素的照片。
 */

/** 可选滤镜列表（会直接渲染成底部工具条） */
export const FILTERS = [
  { id: 'original', name: '原图', hint: '不做任何处理，保留原始色彩' },
  { id: 'magic', name: '增强', hint: '自动去阴影、白底增强，彩色文档首选' },
  { id: 'grayClean', name: '灰度', hint: '去阴影并转为灰度，适合打印' },
  { id: 'bw', name: '黑白', hint: '纯黑白两色，文字最锐利，适合 OCR；照片会变成实心黑块' },
  { id: 'lighten', name: '增亮', hint: '整体提亮，适合偏暗的照片' },
  { id: 'gray', name: '去色', hint: '单纯转为灰度，不做增强' },
];

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

export function createCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function ctx2d(canvas, opts) {
  return canvas.getContext('2d', opts || { willReadFrequently: true });
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.9) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('导出图片失败'))), type, quality);
  });
}

/** 把任意图片源画成 ImageBitmap / 可绘制对象 */
export async function loadImage(source) {
  if (source instanceof Blob) {
    try {
      return await createImageBitmap(source, { imageOrientation: 'from-image' });
    } catch {
      return await createImageBitmap(source);
    }
  }
  return source;
}

/** 读取文件为图片并限制长边尺寸（超大图先缩一次，避免后续内存爆掉） */
export async function decodeToBitmap(file, maxEdge = 4000) {
  const bitmap = await loadImage(file);
  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  if (scale >= 1) return bitmap;
  const c = createCanvas(Math.round(w * scale), Math.round(h * scale));
  ctx2d(c).drawImage(bitmap, 0, 0, c.width, c.height);
  if (bitmap.close) bitmap.close();
  return c;
}

/* ------------------------------------------------------------------ */
/* 像素级算法                                                          */
/* ------------------------------------------------------------------ */

/** 计算亮度数组（Rec.601 加权，符合人眼感受） */
function luma(data, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }
  return g;
}

/**
 * 阴影/光照背景估计：分块取局部最大值 → 向四周扩散 → 平滑 → 双线性插值。
 * 纸张本身是白的，局部最亮的像素就近似"该处的白场"，用它做除法即可去掉阴影。
 *
 * radius（以格为单位）那一步"取邻域最大值"不是可有可无的优化，是必需的：
 * 一块比格子还大的深色区域（粗体标题、表格里的实心色块、印章、照片），
 * 它自己的格子取最大值得到的还是深色——于是白场被估成了深色，
 * 除以它相当于把这块深色"提亮成白纸"，粗体字被掏成空心、照片变成一片白。
 * 这个 bug 在缩略图上完全看不出来，只有拿真实分辨率（1600px 宽）跑测试才会暴露：
 * 240px 的合成图里文字条比 32px 的格子还小，反而一直是好的。
 * 邻域最大值会把周围的纸白"漫"进深色区域内部，白场因此回到真实值，深色保持深色。
 *
 * radius=3 即约 224px 的窗口，能覆盖近 200px 厚的大色块。
 * 代价：一处高光（反光、闪光灯）会把附近的白色估计得偏高，那一小圈会被压得偏灰，
 * 属于可接受的取舍——文档扫描里"字被洗白"比"反光处略微发灰"严重得多。
 */
function backgroundMap(gray, w, h, cell = 32, radius = 3) {
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const raw = new Float32Array(gw * gh);

  for (let by = 0; by < gh; by++) {
    for (let bx = 0; bx < gw; bx++) {
      const x0 = bx * cell;
      const y0 = by * cell;
      const x1 = Math.min(w, x0 + cell);
      const y1 = Math.min(h, y0 + cell);
      let m = 0;
      // 采样步长 2，速度提升约 4 倍，肉眼无差别
      for (let y = y0; y < y1; y += 2) {
        const row = y * w;
        for (let x = x0; x < x1; x += 2) {
          const v = gray[row + x];
          if (v > m) m = v;
        }
      }
      raw[by * gw + bx] = m || 1;
    }
  }

  // 邻域最大值扩散：把纸白漫进比格子更大的深色块内部
  // （分开写是为了不覆盖 raw，后面平滑还要用）
  const spread = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let m = 0;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(gh - 1, y + radius);
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(gw - 1, x + radius);
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * gw;
        for (let xx = x0; xx <= x1; xx++) {
          const v = raw[row + xx];
          if (v > m) m = v;
        }
      }
      spread[y * gw + x] = m || 1;
    }
  }

  // 3x3 均值平滑，避免分块边界出现台阶
  const map = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= gh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= gw) continue;
          sum += spread[yy * gw + xx];
          n++;
        }
      }
      map[y * gw + x] = sum / n;
    }
  }

  return { map, gw, gh, cell };
}

/** 双线性采样背景图 */
function sampleBg(bg, x, y, w, h) {
  const { map, gw, gh, cell } = bg;
  const fx = Math.min(gw - 1.001, Math.max(0, x / cell - 0.5));
  const fy = Math.min(gh - 1.001, Math.max(0, y / cell - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(gw - 1, x0 + 1);
  const y1 = Math.min(gh - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = map[y0 * gw + x0] * (1 - tx) + map[y0 * gw + x1] * tx;
  const b = map[y1 * gw + x0] * (1 - tx) + map[y1 * gw + x1] * tx;
  return a * (1 - ty) + b * ty;
}

/** 对比度拉伸：按 0.5% / 99.5% 分位裁剪，把灰蒙蒙的照片拉成干净的白底 */
function contrastLUT(gray, lowPct = 0.005, highPct = 0.995) {
  const hist = new Uint32Array(256);
  const step = gray.length > 400000 ? 3 : 1; // 大图跳点统计，足够准确
  let total = 0;
  for (let i = 0; i < gray.length; i += step) {
    hist[gray[i]]++;
    total++;
  }
  let acc = 0;
  let lo = 0;
  let hi = 255;
  const loTarget = total * lowPct;
  const hiTarget = total * highPct;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= loTarget) {
      lo = i;
      break;
    }
  }
  acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= hiTarget) {
      hi = i;
      break;
    }
  }
  if (hi - lo < 24) {
    lo = Math.max(0, lo - 12);
    hi = Math.min(255, hi + 12);
  }
  const lut = new Uint8ClampedArray(256);
  const scale = 255 / Math.max(1, hi - lo);
  for (let i = 0; i < 256; i++) lut[i] = Math.max(0, Math.min(255, (i - lo) * scale));
  return lut;
}

/** 简易 USM 锐化（3x3），让文字边缘更清楚，对 OCR 有明显帮助 */
function unsharp(gray, w, h, amount = 0.6) {
  const out = new Uint8ClampedArray(gray.length);
  const k = amount;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up = y > 0 ? row - w : row;
    const dn = y < h - 1 ? row + w : row;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? x - 1 : x;
      const r = x < w - 1 ? x + 1 : x;
      const blur = (gray[up + l] + gray[up + x] + gray[up + r] + gray[row + l] + gray[row + x] + gray[row + r] + gray[dn + l] + gray[dn + x] + gray[dn + r]) / 9;
      out[row + x] = gray[row + x] + k * (gray[row + x] - blur);
    }
  }
  return out;
}

/**
 * 求灰度的低/高分位值，用来判断"这张图到底有没有内容"。
 */
function percentileRange(gray, lowPct = 0.005, highPct = 0.995) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let acc = 0;
  let lo = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= total * lowPct) {
      lo = i;
      break;
    }
  }
  acc = 0;
  let hi = 255;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= total * highPct) {
      hi = i;
      break;
    }
  }
  return [lo, hi];
}

/**
 * Otsu 全局阈值：让前景/背景两类之间的类间方差最大，等价于"自动找到最合理的分界灰度"。
 */
function otsu(gray) {
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) {
    hist[gray[i]]++;
    sum += gray[i];
  }
  const total = gray.length;
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

/**
 * 二值化：先按背景场归一化去掉光照不均，再取 Otsu 全局阈值。
 *
 * 为什么不用 Bradley 这类"局部均值"自适应阈值——试过，会被自己的窗口坑：
 * 局部窗口一小，笔画粗的字、表格粗线、印章、照片这类"比窗口还大的深色块"，
 * 内部像素的局部均值本身就接近深色，于是判不出黑，字被掏成空心甚至整片消失。
 * 而归一化之后光照已经拉平，全局阈值反而最稳：深色块保持实心，白纸保持干净。
 * 代价是照片区域会变成实心黑块——这正是"黑白"模式该有的取舍，需要照片请用"增强"。
 *
 * 另外加了一道兜底：如果整张图几乎没有明暗差（对着白纸拍了一张），直接全白，
 * 否则 Otsu 硬要在噪声里找分界，会把干净的纸拍出一层麻点。
 */
function binarize(gray, w, h) {
  const out = new Uint8ClampedArray(gray.length);
  const [lo, hi] = percentileRange(gray);
  if (hi - lo < 28) {
    out.fill(255); // 空白纸：全白，不要凭空造出噪点
    return out;
  }
  const thr = otsu(gray);
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] <= thr ? 0 : 255;
  return out;
}

/* ------------------------------------------------------------------ */
/* 滤镜总入口                                                          */
/* ------------------------------------------------------------------ */

/**
 * 对 ImageData 应用滤镜。
 *
 * 重要约定：**不修改传入的 imgData**，永远返回一份新的 ImageData。
 * 这条约定是被测试逼出来的：滤镜曾经原地改写像素，于是
 *   - 用户在"增强 → 灰度 → 增强"之间来回点时，每一轮都在上一次的结果上再处理一遍，
 *     画面越点越糊；
 *   - 一旦应用过"增强"，再切回"原图"也回不去了，原始像素已经被覆盖。
 * 复制一份缓冲的代价（一张 1200 万像素的图约 48MB，瞬时）远小于把原始数据弄丢。
 *
 * @param {ImageData} imgData
 * @param {string} filterId
 * @returns {ImageData} 新的 ImageData（filterId 为 original 时返回输入本身）
 */
export function applyFilter(imgData, filterId) {
  if (!isKnownFilter(filterId) || filterId === 'original') return imgData;
  const { data, width, height } = imgData;
  // 浏览器里必须是真正的 ImageData（ctx.putImageData 只认它）；
  // Node 里（跑单元测试）没有这个构造器，退回同样形状的普通对象。
  const copy =
    typeof ImageData === 'function'
      ? new ImageData(new Uint8ClampedArray(data), width, height)
      : { data: new Uint8ClampedArray(data), width, height };
  applyFilterInPlace(copy, filterId);
  return copy;
}

/**
 * 未知的滤镜 id 一律当成"原图"。
 * 稳赚不赔的选择：宁可什么都不做，也不要偷偷套一个用户没选的滤镜上去
 * （比如拼错的 id 掉进"增强"分支，用户会以为 App 在乱改他的照片）。
 */
function isKnownFilter(id) {
  return FILTERS.some((f) => f.id === id);
}

/**
 * 光照归一化的增益上限。见 applyFilterInPlace 里的说明：
 * 真实拍摄中一张纸上的照明差异最多 2~3 倍，超过这个倍数就不是阴影而是内容了。
 */
const MAX_GAIN = 3;

/**
 * 原地版本：给"自己就持有这块缓冲"的渲染流水线用（renderPage 每次都会新建 canvas）。
 * 外部调用请一律用 applyFilter。
 */
function applyFilterInPlace(imgData, filterId) {
  if (filterId === 'original') return imgData;
  const { data, width: w, height: h } = imgData;
  const g = luma(data, w, h);

  if (filterId === 'gray') {
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      data[p] = data[p + 1] = data[p + 2] = g[i];
    }
    return imgData;
  }

  if (filterId === 'lighten') {
    // Gamma 提亮，同时把过曝部分压回来，避免白成一片
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = 255 * Math.pow(i / 255, 0.75);
    for (let p = 0; p < data.length; p += 4) {
      data[p] = lut[data[p]];
      data[p + 1] = lut[data[p + 1]];
      data[p + 2] = lut[data[p + 2]];
    }
    return imgData;
  }

  // magic / grayClean / bw 都需要先做光照归一化
  const bg = backgroundMap(g, w, h, 32);
  const target = filterId === 'bw' ? 255 : 245; // bw 要更硬的白场，后面才好切
  const norm = new Uint8ClampedArray(g.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const b = Math.max(1, sampleBg(bg, x, y, w, h));
      // 增益上限 MAX_GAIN 是一道兜底，防"把内容当成光照"：
      // 归一化的本意是修正**照明不匀**，而真实拍摄里一张纸上明暗差最多也就 2~3 倍；
      // 某一处比周围纸白暗了 3 倍以上，那多半不是阴影，而是**内容**（墨、深色块、照片）。
      // 一旦把内容当阴影，除以它自己的暗值就等于把这一块"提亮成白纸"——
      // 粗体字被掏成空心、照片变成一片白，正是最难发现也最难看的一类错。
      // 白场扩散（radius=3）已经能挡住绝大多数情况，但再大的色块（比如整版照片）
      // 总会超出任何固定窗口，所以再加这条与窗口大小无关的硬上限：
      // 最坏情况只是"很深的阴影没能完全拉白"，而不会"把深色内容洗成白的"。
      const gain = Math.min(MAX_GAIN, target / b);
      norm[i] = Math.min(255, g[i] * gain);
    }
  }

  if (filterId === 'bw') {
    const bin = binarize(norm, w, h);
    for (let i = 0, p = 0; i < bin.length; i++, p += 4) {
      data[p] = data[p + 1] = data[p + 2] = bin[i];
    }
    return imgData;
  }

  const sharp = filterId === 'magic' ? unsharp(norm, w, h, 0.45) : norm;
  const lut = contrastLUT(sharp);

  if (filterId === 'grayClean') {
    for (let i = 0, p = 0; i < sharp.length; i++, p += 4) {
      data[p] = data[p + 1] = data[p + 2] = lut[sharp[i]];
    }
    return imgData;
  }

  // 彩色增强：亮度走 LUT，色度保持原比例，颜色不会失真
  for (let i = 0, p = 0; i < sharp.length; i++, p += 4) {
    const l0 = g[i] || 1;
    const l1 = lut[sharp[i]];
    const k = l1 / l0;
    data[p] = data[p] * k;
    data[p + 1] = data[p + 1] * k;
    data[p + 2] = data[p + 2] * k;
  }
  return imgData;
}

/* ------------------------------------------------------------------ */
/* 完整渲染流水线                                                      */
/* ------------------------------------------------------------------ */

/**
 * 把一个原始图片源渲染成扫描件。
 *
 * @param {ImageBitmap|HTMLCanvasElement|HTMLImageElement} source 原始图像
 * @param {object} opts
 *   filter   滤镜 id
 *   rotation 旋转角度 0/90/180/270
 *   crop     归一化裁剪区域 {x,y,w,h}，0~1
 *   maxSize  长边最大像素
 *   quality  JPEG 质量 0~1
 *   watermark 水印文字（可为空）
 * @returns {Promise<{canvas:any, blob:Blob, thumb:Blob, width:number, height:number}>}
 */
export async function renderPage(source, opts = {}) {
  const {
    filter = 'magic',
    rotation = 0,
    crop = null,
    maxSize = 2400,
    quality = 0.9,
    watermark = '',
  } = opts;

  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;

  // 1) 旋转
  const rot = ((rotation % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const rw = swap ? sh : sw;
  const rh = swap ? sw : sh;
  const rotCanvas = createCanvas(rw, rh);
  const rc = ctx2d(rotCanvas);
  rc.translate(rw / 2, rh / 2);
  rc.rotate((rot * Math.PI) / 180);
  rc.drawImage(source, -sw / 2, -sh / 2);

  // 2) 裁剪
  let base = rotCanvas;
  if (crop && crop.w > 0.01 && crop.h > 0.01) {
    const cx = Math.round(crop.x * rw);
    const cy = Math.round(crop.y * rh);
    const cw = Math.max(16, Math.round(crop.w * rw));
    const ch = Math.max(16, Math.round(crop.h * rh));
    const cc = createCanvas(cw, ch);
    ctx2d(cc).drawImage(rotCanvas, cx, cy, cw, ch, 0, 0, cw, ch);
    base = cc;
  }

  // 3) 缩放到目标尺寸
  const bw = base.width;
  const bh = base.height;
  const scale = Math.min(1, maxSize / Math.max(bw, bh));
  const ow = Math.max(1, Math.round(bw * scale));
  const oh = Math.max(1, Math.round(bh * scale));
  const out = createCanvas(ow, oh);
  const octx = ctx2d(out);
  octx.drawImage(base, 0, 0, ow, oh);

  // 4) 像素处理（这块 canvas 是本函数自己建的，用原地版省一次 48MB 级的内存拷贝）
  if (filter !== 'original') {
    const img = octx.getImageData(0, 0, ow, oh);
    applyFilterInPlace(img, filter);
    octx.putImageData(img, 0, 0);
  }

  // 5) 水印
  if (watermark) drawWatermark(octx, ow, oh, watermark);

  const blob = await canvasToBlob(out, 'image/jpeg', quality);
  const thumb = await makeThumb(out, 240);
  return { canvas: out, blob, thumb, width: ow, height: oh };
}

/** 右下角半透明水印 */
function drawWatermark(ctx, w, h, text) {
  const size = Math.max(14, Math.round(w / 28));
  ctx.save();
  ctx.globalAlpha = 0.32;
  ctx.font = `${size}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  const pad = Math.round(size * 0.8);
  const metrics = ctx.measureText(text);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillRect(w - metrics.width - pad * 2, h - size * 2.1, metrics.width + pad * 2, size * 1.8);
  ctx.fillStyle = 'rgba(60,60,60,0.9)';
  ctx.fillText(text, w - pad, h - pad);
  ctx.restore();
}

/** 生成缩略图（列表页用，控制在小几十 KB，保证滚动流畅） */
export async function makeThumb(source, maxEdge = 240, quality = 0.72) {
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const c = createCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  const ctx = ctx2d(c);
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return canvasToBlob(c, 'image/jpeg', quality);
}
