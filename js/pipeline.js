/**
 * pipeline.js —— 扫描流水线：原图 → 扫描件。
 *
 * 把"旋转 → 透视裁边 → 滤镜 → 缩放 → 水印 → 编码"串成一条链，
 * 编辑器和导出都只调用这里，保证预览和最终导出用的是同一套算法，所见即所得。
 *
 * 关键设计：文档里只保存**原始照片** + 一组编辑参数（四角、旋转、滤镜）。
 * 每次查看/导出都从原图重新渲染，因此：
 *   · 修改裁剪或滤镜永远不会"越改越糊"（非破坏性编辑）
 *   · 存储占用只有一份原图，不存处理后的副本
 */

import { createCanvas, ctx2d, canvasToBlob, applyFilter, makeThumb, FILTERS } from './render.js';
import { warpPerspective, rectToQuad, quadToRect } from './crop.js';

export { FILTERS };

export function filterName(id) {
  return (FILTERS.find((f) => f.id === id) || FILTERS[0]).name;
}

/** 把源图按角度旋转，返回一张新的 Canvas */
export function rotateSource(source, rotation) {
  const rot = ((rotation % 360) + 360) % 360;
  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;
  if (!rot) {
    const c = createCanvas(sw, sh);
    ctx2d(c).drawImage(source, 0, 0);
    return c;
  }
  const swap = rot === 90 || rot === 270;
  const rw = swap ? sh : sw;
  const rh = swap ? sw : sh;
  const c = createCanvas(rw, rh);
  const ctx = ctx2d(c);
  ctx.translate(rw / 2, rh / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(source, -sw / 2, -sh / 2);
  return c;
}

/**
 * 完整渲染一页。
 *
 * @param {ImageBitmap|HTMLCanvasElement|HTMLImageElement} source 原始照片
 * @param {object} opts
 *   rotation 0/90/180/270
 *   quad     四角（归一化）。缺省表示整幅图
 *   filter   滤镜 id
 *   maxSize  长边像素上限
 *   quality  JPEG 质量
 *   watermark 水印文字
 *   withThumb 是否同时生成缩略图
 * @returns {Promise<{blob:Blob, thumb?:Blob, width:number, height:number, canvas:any}>}
 */
export async function buildScan(source, opts = {}) {
  const {
    rotation = 0,
    quad = null,
    filter = 'magic',
    maxSize = 2400,
    quality = 0.9,
    watermark = '',
    withThumb = true,
  } = opts;

  // 1) 旋转到"用户看到的朝向"
  let base = rotateSource(source, rotation);

  // 2) 透视裁边（四角接近整幅图时跳过，省掉几百万次采样）
  if (quad && quad.length === 4) {
    const r = quadToRect(quad);
    const isFull = r.w > 0.985 && r.h > 0.985 && r.x < 0.008 && r.y < 0.008;
    if (!isFull) {
      const warped = warpPerspective(base, quad, Math.max(maxSize, 1200));
      base = warped.canvas;
    }
  }

  // 3) 缩放到目标尺寸（先缩后处理，滤镜速度快好几倍）
  const bw = base.width;
  const bh = base.height;
  const scale = Math.min(1, maxSize / Math.max(bw, bh));
  const ow = Math.max(1, Math.round(bw * scale));
  const oh = Math.max(1, Math.round(bh * scale));
  const out = createCanvas(ow, oh);
  const octx = ctx2d(out);
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(base, 0, 0, ow, oh);

  // 4) 滤镜（applyFilter 返回新对象，必须接住返回值）
  if (filter && filter !== 'original') {
    const img = octx.getImageData(0, 0, ow, oh);
    octx.putImageData(applyFilter(img, filter), 0, 0);
  }

  // 5) 水印
  if (watermark) drawWatermark(octx, ow, oh, watermark);

  // 6) 编码
  const blob = await canvasToBlob(out, 'image/jpeg', quality);
  const thumb = withThumb ? await makeThumb(out, 240) : undefined;
  return { blob, thumb, width: ow, height: oh, canvas: out };
}

/** 右下角水印：先铺一层浅色底再写字，任何底色上都看得清 */
function drawWatermark(ctx, w, h, text) {
  const size = Math.max(13, Math.round(w / 30));
  ctx.save();
  ctx.font = `${size}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  const pad = Math.round(size * 0.7);
  const tw = ctx.measureText(text).width;
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(w - tw - pad * 2.2, h - size * 2.4, tw + pad * 2.2, size * 2);
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#374151';
  ctx.fillText(text, w - pad, h - pad);
  ctx.restore();
}

/**
 * 生成"滤镜预览图"：一次性渲染出所有滤镜的小图，供滤镜条展示。
 * 在 320px 的小图上算，6 种滤镜总共只要几百毫秒。
 *
 * @param {ImageBitmap|HTMLCanvasElement} source 已经旋转+裁边后的画面
 * @returns {Promise<Record<string, Blob>>} filterId → 小图 Blob
 */
export async function buildFilterPreviews(source, { maxSize = 320, quality = 0.7 } = {}) {
  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;
  const scale = Math.min(1, maxSize / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const base = createCanvas(w, h);
  const bctx = ctx2d(base);
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(source, 0, 0, w, h);
  const srcData = bctx.getImageData(0, 0, w, h);

  const out = {};
  for (const f of FILTERS) {
    const img = new ImageData(new Uint8ClampedArray(srcData.data), w, h);
    // applyFilter 不改传入对象，必须用它返回的那一份，否则所有预览都会长成原图
    const filtered = f.id === 'original' ? img : applyFilter(img, f.id);
    const c = createCanvas(w, h);
    ctx2d(c).putImageData(filtered, 0, 0);
    out[f.id] = await canvasToBlob(c, 'image/jpeg', quality);
  }
  return out;
}

/**
 * 把多页拼成一张长图（类似扫描全能王的"长图导出"，方便发微信）。
 * 每页之间留 12px 白缝，宽度以最宽的一页为准。
 *
 * @param {Array<HTMLCanvasElement>} canvases 已渲染好的页面
 * @returns {Promise<Blob>}
 */
export async function mergeToLongImage(canvases, opts = {}) {
  const gap = opts.gap == null ? 12 : opts.gap;
  const bg = opts.background || '#ffffff';
  if (!canvases.length) throw new Error('没有可导出的页面');
  const width = Math.max(...canvases.map((c) => c.width));
  const height = canvases.reduce((s, c) => s + c.height, 0) + gap * (canvases.length - 1);
  const out = createCanvas(width, height);
  const ctx = ctx2d(out, { alpha: false });
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  let y = 0;
  for (const c of canvases) {
    ctx.drawImage(c, Math.round((width - c.width) / 2), y);
    y += c.height + gap;
  }
  if (opts.watermark) drawWatermark(ctx, width, height, opts.watermark);
  return canvasToBlob(out, 'image/jpeg', opts.quality || 0.88);
}

export { quadToRect, rectToQuad };
