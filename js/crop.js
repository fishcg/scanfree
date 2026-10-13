/**
 * crop.js —— 透视裁剪（扫描全能王最核心的功能之一）。
 *
 * 手机拍照时纸张几乎不可能是正对着的，直接裁矩形会把内容裁歪。
 * 这里做两件事：
 *   1) detectDocument()：自动找出纸张的四个角（Otsu 阈值 + 最大连通区域）
 *   2) CropEditor / warpPerspective()：用户可拖动四角微调，最后做透视变换把纸"掰正"
 *
 * 透视变换用的是标准 DLT（直接线性变换）求解 8 参数单应矩阵，
 * 再对输出图逐像素做逆映射 + 双线性插值采样，边缘平滑没有锯齿。
 */

import { createCanvas, ctx2d } from './render.js';
import { detectDocument as detectEdges } from './detect.js';

/* ------------------------------------------------------------------ */
/* 自动检测纸张四角                                                    */
/* ------------------------------------------------------------------ */

/** Otsu 阈值：自动找前景/背景的分界亮度 */
function otsu(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * 在小图上找出"最像纸张"的那块亮区。
 *
 * 思路：纸张通常是画面中大面积的亮区 → 用 Otsu 分出亮区 → 取最大连通块。
 * 只做"找块"这件事，具体返回矩形还是四边形由调用方决定。
 *
 * @returns {{w:number,h:number,pts:Int32Array,count:number,minX:number,minY:number,maxX:number,maxY:number}|null}
 *   pts 是这块区域所有像素的下标（下标 p → x = p % w, y = (p / w) | 0）
 */
function findPaperComponent(source) {
  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;
  const S = 220; // 在小图上算，快且抗噪
  const scale = Math.min(1, S / Math.max(sw, sh));
  const w = Math.max(8, Math.round(sw * scale));
  const h = Math.max(8, Math.round(sh * scale));

  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }

  const t = otsu(gray);
  // 亮区掩码
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) mask[i] = gray[i] > t ? 1 : 0;

  // 四连通 + 队列（避免递归爆栈），找最大连通块
  const label = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let best = null;
  let id = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = id;
    const pts = [];
    let count = 0;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      const y = (p / w) | 0;
      count++;
      pts.push(p);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && label[p - 1] < 0) {
        label[p - 1] = id;
        queue[tail++] = p - 1;
      }
      if (x < w - 1 && mask[p + 1] && label[p + 1] < 0) {
        label[p + 1] = id;
        queue[tail++] = p + 1;
      }
      if (y > 0 && mask[p - w] && label[p - w] < 0) {
        label[p - w] = id;
        queue[tail++] = p - w;
      }
      if (y < h - 1 && mask[p + w] && label[p + w] < 0) {
        label[p + w] = id;
        queue[tail++] = p + w;
      }
    }
    if (!best || count > best.count) {
      best = { count, minX, minY, maxX, maxY, pts };
    }
    id++;
  }

  if (!best) return null;

  // 连通块太小（不是纸张）或几乎等于整幅图（说明没有明显边界）→ 不自动裁
  const ratio = best.count / (w * h);
  const bw = best.maxX - best.minX + 1;
  const bh = best.maxY - best.minY + 1;
  if (ratio < 0.35 || bw < w * 0.35 || bh < h * 0.35) return null;
  if (bw > w * 0.99 && bh > h * 0.99) return null;

  return { w, h, ...best, pts: Int32Array.from(best.pts) };
}

/**
 * 自动检测文档边界，返回**正着的**外接矩形。
 *
 * 注意：这是"轴对齐"的结果，适合"纸张本来就没歪"的情况。
 * 手机拍照更常见的是纸张在画面里是**斜的**，用它会把纸张外圈的一圈背景一起框进来，
 * 所以拍照导入默认走 detectDocumentQuad()。
 *
 * @param {ImageBitmap|HTMLCanvasElement} source
 * @returns {{x:number,y:number,w:number,h:number}|null} 归一化矩形（0~1）
 */
export function detectDocument(source) {
  const found = findPaperComponent(source);
  if (!found) return null;
  const { w, h, minX, minY, maxX, maxY } = found;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;

  // 留一点边距，避免把纸张边缘的阴影切进来
  const padX = bw * 0.012;
  const padY = bh * 0.012;
  const x0 = Math.max(0, minX - padX);
  const y0 = Math.max(0, minY - padY);
  const x1 = Math.min(w, maxX + 1 + padX);
  const y1 = Math.min(h, maxY + 1 + padY);

  return { x: x0 / w, y: y0 / h, w: (x1 - x0) / w, h: (y1 - y0) / h };
}

/* ------------------------------------------------------------------ */
/* 最小面积外接矩形（让歪着拍的纸也能被"掰正"）                        */
/* ------------------------------------------------------------------ */

/** 单调链求凸包（输入像素下标，返回像素坐标点集，逆时针） */
function convexHull(pts, w) {
  const n = pts.length;
  // 先按 x 再按 y 排序。纸张像素可达几万个，但排序后凸包本身只有几十个点。
  const idx = Array.from(pts);
  idx.sort((a, b) => (a % w) - (b % w) || ((a / w) | 0) - ((b / w) | 0));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = idx[i] % w;
    ys[i] = (idx[i] / w) | 0;
  }
  const cross = (o, a, b) => (xs[a] - xs[o]) * (ys[b] - ys[o]) - (ys[a] - ys[o]) * (xs[b] - xs[o]);
  const hull = [];
  for (let i = 0; i < n; i++) {
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], i) <= 0) hull.pop();
    hull.push(i);
  }
  const lower = hull.length + 1;
  for (let i = n - 2; i >= 0; i--) {
    while (hull.length >= lower && cross(hull[hull.length - 2], hull[hull.length - 1], i) <= 0) hull.pop();
    hull.push(i);
  }
  hull.pop();
  return hull.map((i) => ({ x: xs[i], y: ys[i] }));
}

/** 矩形（中心 + 半轴向量）的四个角，顺序：左上、右上、右下、左下 */
function rectCorners(cx, cy, ux, uy, vx, vy) {
  return [
    { x: cx - ux - vx, y: cy - uy - vy },
    { x: cx + ux - vx, y: cy + uy - vy },
    { x: cx + ux + vx, y: cy + uy + vy },
    { x: cx - ux + vx, y: cy - uy + vy },
  ];
}

/**
 * 最小面积外接矩形：把凸包沿一组角度旋转，取轴对齐包围盒面积最小的那个。
 * 角度按 1° 扫一遍（180 次），对凸包这种几十个点的输入来说开销可以忽略。
 */
function minAreaRect(hull) {
  let best = null;
  for (let deg = 0; deg < 180; deg++) {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of hull) {
      const rx = p.x * c + p.y * s;
      const ry = -p.x * s + p.y * c;
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
    }
    const area = (maxX - minX) * (maxY - minY);
    if (!best || area < best.area) best = { area, a, minX, minY, maxX, maxY };
  }
  // 把旋转过的矩形转回原坐标系
  const { a, minX, minY, maxX, maxY } = best;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const toOrig = (rx, ry) => ({ x: rx * c - ry * s, y: rx * s + ry * c });
  const p0 = toOrig(minX, minY);
  const p1 = toOrig(maxX, minY);
  const p2 = toOrig(maxX, maxY);
  const p3 = toOrig(minX, maxY);
  const cx = (p0.x + p2.x) / 2;
  const cy = (p0.y + p2.y) / 2;
  return rectCorners(cx, cy, (p1.x - p0.x) / 2, (p1.y - p0.y) / 2, (p3.x - p0.x) / 2, (p3.y - p0.y) / 2);
}

/** 把四个角点按 左上→右上→右下→左下 排好（warpPerspective 依赖这个顺序） */
function orderQuad(pts) {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  // 屏幕坐标 y 朝下，所以 atan2 从小到大正好是"顺时针"：
  // 右 → 下 → 左 → 上。四个角按角度排序后天然是一圈。
  const ring = pts
    .map((p) => ({ x: p.x, y: p.y, a: Math.atan2(p.y - cy, p.x - cx) }))
    .sort((p, q) => p.a - q.a);
  // 再从"最靠近左上角"的那个点开始，顺时针读一遍
  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (ring[i].x + ring[i].y < ring[start].x + ring[start].y) start = i;
  }
  return [...ring.slice(start), ...ring.slice(0, start)].map((p) => ({ x: p.x, y: p.y }));
}

/** 四边形面积（鞋带公式） */
function quadArea(q) {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/**
 * 自动检测文档四角，返回**倾斜的四边形**（归一化 0~1）。
 *
 * 两条路一起用，谁靠谱用谁：
 *   1) 边缘检测（detect.js）：Sobel 梯度 → 膨胀 → 连通域 → 凸包收敛到四边形 →
 *      边线最小二乘精修。它能处理**透视**（手机斜着拍，纸是梯形而不只是转了角度），
 *      还会给出置信度。实测对一张旋转 -1.6° 的合成照片，它量出来是 -1.62°，几乎分毫不差。
 *   2) 亮区外接矩形（本文件）：纸张亮、桌面暗这种最常见的场景，稳、快，
 *      边缘检测失败时兜底。
 *
 * 都失败就返回 null，调用方回退到整幅图（用户还能手动拖）。
 *
 * @param {ImageBitmap|HTMLCanvasElement} source
 * @returns {{quad:{x:number,y:number}[], areaRatio:number, angleDeg:number}|null}
 */
export function detectDocumentQuad(source) {
  let found = null;
  let via = '';

  try {
    found = detectByEdges(source);
    if (found) via = 'edges';
  } catch {
    /* 边缘检测出问题就直接走兜底 */
  }
  if (!found?.quad) {
    found = detectByBrightRegion(source);
    via = found ? 'bright' : '';
  }
  if (!found?.quad) return null;

  const grown = insetQuad(found.quad, INSET);

  // 边长得太悬殊（细长条）说明检测跑偏了，不如不裁
  const side = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const s1 = side(grown[0], grown[1]);
  const s2 = side(grown[1], grown[2]);
  const longSide = Math.max(s1, s2);
  const shortSide = Math.min(s1, s2);
  if (longSide < 8 / 500 || shortSide / longSide < 0.15) return null;

  // 两个检测器都返回**归一化**坐标，所以鞋带公式出来的面积就是占画面的比例
  const areaRatio = quadArea(grown);
  // 太小（不是纸张，可能是桌面上一块反光）或几乎占满（说明压根没有边界）都不裁
  if (areaRatio < 0.2 || areaRatio > 0.985) return null;

  const quad = grown.map((p) => ({
    x: Math.min(1, Math.max(0, p.x)),
    y: Math.min(1, Math.max(0, p.y)),
  }));

  const angleDeg = (Math.atan2(quad[1].y - quad[0].y, quad[1].x - quad[0].x) * 180) / Math.PI;
  return { quad, areaRatio, angleDeg, via, confidence: found.confidence ?? null };
}

/**
 * 往里收 1.5%，而不是往外扩。
 *
 * 实测过几个系数（拿一张"斜着拍的合同照片"量裁完之后的黑边宽度）：
 *   1.00  → 上边 2px、左边 3px 黑边
 *   0.995 → 左边还剩 2px
 *   0.985 → 四条边全部干净
 * 根因是最小外接矩形紧贴纸张亮区边界，而纸张边缘本身有半像素的暗过渡；
 * 往外扩（哪怕只 1.5%）会直接把桌面背景圈进来，打印出来四边一圈黑框。
 * 往里收 1.5% 在 A4 上约 3 毫米，正文几乎不可能贴在那么靠边的位置。
 */
const INSET = 0.985;

function imageSize(source) {
  return { w: source.width || source.naturalWidth, h: source.height || source.naturalHeight };
}

/** 把四边形绕着中心缩放（f<1 往里收） */
function insetQuad(quad, f) {
  const cx = quad.reduce((s, p) => s + p.x, 0) / quad.length;
  const cy = quad.reduce((s, p) => s + p.y, 0) / quad.length;
  return quad.map((p) => ({ x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f }));
}

/** 用边缘检测找四角（detect.js 要的是 RGBA 像素，所以先画到小画布上） */
function detectByEdges(source) {
  const { w: sw, h: sh } = imageSize(source);
  const S = 480; // detect.js 建议长边缩到 480 左右
  const scale = Math.min(1, S / Math.max(sw, sh));
  const w = Math.max(24, Math.round(sw * scale));
  const h = Math.max(24, Math.round(sh * scale));

  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const res = detectEdges({ data, width: w, height: h });
  if (!res?.found) return null;
  if ((res.confidence ?? 0) < 0.25) return null; // 置信度太低就别乱裁

  // detect.js 已经按 左上→右上→右下→左下 返回，这里只做归一化
  const quad = res.corners.map(([x, y]) => ({ x: x / w, y: y / h }));
  if (quad.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  return { quad, confidence: res.confidence };
}

/** 兜底：纸张是画面里最大的一块亮区 → 它的最小外接矩形 */
function detectByBrightRegion(source) {
  const found = findPaperComponent(source);
  if (!found) return null;
  const { w, h, pts } = found;

  const hull = convexHull(pts, w);
  if (hull.length < 3) return null;

  const corners = minAreaRect(hull);
  // 归一化后再交出去，和 detectByEdges 保持同一套坐标系
  const quad = orderQuad(corners).map((p) => ({ x: p.x / w, y: p.y / h }));
  if (quad.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  return { quad, confidence: null };
}

/* ------------------------------------------------------------------ */
/* 透视变换                                                            */
/* ------------------------------------------------------------------ */

/** 高斯消元解 n 元线性方程组 */
function solveLinear(A, b, n) {
  for (let i = 0; i < n; i++) {
    // 选主元
    let piv = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    }
    if (Math.abs(A[piv][i]) < 1e-9) return null;
    if (piv !== i) {
      const tmp = A[i];
      A[i] = A[piv];
      A[piv] = tmp;
      const tb = b[i];
      b[i] = b[piv];
      b[piv] = tb;
    }
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      if (!f) continue;
      for (let cIdx = i; cIdx < n; cIdx++) A[r][cIdx] -= f * A[i][cIdx];
      b[r] -= f * b[i];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let cIdx = i + 1; cIdx < n; cIdx++) s -= A[i][cIdx] * x[cIdx];
    x[i] = s / A[i][i];
  }
  return x;
}

/**
 * 求单应矩阵 H（3x3，行优先，h[8]=1），把 from 四点映射到 to 四点。
 * @returns {Float64Array|null}
 */
export function homography(from, to) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear(A, b, 8);
  if (!h) return null;
  const H = new Float64Array(9);
  for (let i = 0; i < 8; i++) H[i] = h[i];
  H[8] = 1;
  return H;
}

/**
 * 透视变换：把源图画面上由 quad（归一化四点）围出的区域，掰正成 outW×outH 的矩形。
 * quad 顺序：左上、右上、右下、左下。
 *
 * @param {ImageBitmap|HTMLCanvasElement} source
 * @param {Array<{x:number,y:number}>} quad 归一化坐标
 * @param {number} maxSize 输出长边上限
 * @returns {{canvas:any, width:number, height:number}}
 */
export function warpPerspective(source, quad, maxSize = 2400) {
  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;
  const pts = quad.map((p) => ({ x: p.x * sw, y: p.y * sh }));

  // 按对边长度估算输出尺寸，保证长宽比与真实纸张一致
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const wTop = dist(pts[0], pts[1]);
  const wBottom = dist(pts[3], pts[2]);
  const hLeft = dist(pts[0], pts[3]);
  const hRight = dist(pts[1], pts[2]);
  let outW = Math.max(wTop, wBottom);
  let outH = Math.max(hLeft, hRight);
  const scale = Math.min(1, maxSize / Math.max(outW, outH));
  outW = Math.max(8, Math.round(outW * scale));
  outH = Math.max(8, Math.round(outH * scale));

  // 先把源图画到 Canvas 上取像素（原图可能是 ImageBitmap，不能直接 getImageData）
  const src = createCanvas(sw, sh);
  ctx2d(src).drawImage(source, 0, 0);

  const srcData = ctx2d(src).getImageData(0, 0, sw, sh).data;

  // 求 输出 → 源图 的逆映射矩阵
  const dst = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];
  const H = homography(dst, pts);
  if (!H) {
    // 退化情况（四点共线等）直接返回原图
    const c = createCanvas(sw, sh);
    ctx2d(c).drawImage(source, 0, 0);
    return { canvas: c, width: sw, height: sh };
  }

  const out = createCanvas(outW, outH);
  const octx = ctx2d(out);
  const outImg = octx.createImageData(outW, outH);
  const od = outImg.data;
  const sw1 = sw - 1;
  const sh1 = sh - 1;

  for (let v = 0; v < outH; v++) {
    const vv = v + 0.5;
    for (let u = 0; u < outW; u++) {
      const uu = u + 0.5;
      const den = H[6] * uu + H[7] * vv + H[8];
      const sx = (H[0] * uu + H[1] * vv + H[2]) / den;
      const sy = (H[3] * uu + H[4] * vv + H[5]) / den;
      const o = (v * outW + u) * 4;
      if (sx < 0 || sy < 0 || sx > sw1 || sy > sh1) {
        od[o] = od[o + 1] = od[o + 2] = 255;
        od[o + 3] = 255;
        continue;
      }
      // 双线性插值
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = x0 + 1 > sw1 ? sw1 : x0 + 1;
      const y1 = y0 + 1 > sh1 ? sh1 : y0 + 1;
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      od[o] = srcData[i00] * w00 + srcData[i10] * w10 + srcData[i01] * w01 + srcData[i11] * w11;
      od[o + 1] = srcData[i00 + 1] * w00 + srcData[i10 + 1] * w10 + srcData[i01 + 1] * w01 + srcData[i11 + 1] * w11;
      od[o + 2] = srcData[i00 + 2] * w00 + srcData[i10 + 2] * w10 + srcData[i01 + 2] * w01 + srcData[i11 + 2] * w11;
      od[o + 3] = 255;
    }
  }

  octx.putImageData(outImg, 0, 0);
  return { canvas: out, width: outW, height: outH };
}

/* ------------------------------------------------------------------ */
/* 四角拖拽编辑器                                                      */
/* ------------------------------------------------------------------ */

const HANDLE_R = 13; // 手柄半径（CSS 像素）

/**
 * 裁剪编辑器：把图片铺满画布，用户拖动四个角，实时显示放大镜。
 *
 * 用法：
 *   const editor = new CropEditor(canvasEl, bitmap, quadOrNull);
 *   editor.getQuad();   // 归一化四角
 *   editor.reset();
 *   editor.destroy();
 */
export class CropEditor {
  constructor(canvas, source, initialQuad = null) {
    this.canvas = canvas;
    this.source = source;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dragging = -1;
    this.loupe = null;

    const full = [
      { x: 0.02, y: 0.02 },
      { x: 0.98, y: 0.02 },
      { x: 0.98, y: 0.98 },
      { x: 0.02, y: 0.98 },
    ];
    const rect = initialQuad && initialQuad.w ? rectToQuad(initialQuad) : null;
    this.quad = (rect || initialQuad || full).map((p) => ({ ...p }));
    this.full = full;

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);

    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onUp);

    this.resize();
  }

  /** 画布尺寸变化时调用（窗口旋转、布局变化） */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(80, Math.round(rect.width * this.dpr));
    const h = Math.max(80, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const sw = this.source.width || this.source.naturalWidth;
    const sh = this.source.height || this.source.naturalHeight;
    const scale = Math.min(w / sw, h / sh);
    this.view = {
      scale,
      ox: (w - sw * scale) / 2,
      oy: (h - sh * scale) / 2,
      sw,
      sh,
    };
    this.draw();
  }

  /** 归一化坐标 → 画布像素 */
  toCanvas(p) {
    const v = this.view;
    return { x: v.ox + p.x * v.sw * v.scale, y: v.oy + p.y * v.sh * v.scale };
  }

  /** 画布像素 → 归一化坐标 */
  toNorm(x, y) {
    const v = this.view;
    return {
      x: Math.max(0, Math.min(1, (x - v.ox) / (v.sw * v.scale))),
      y: Math.max(0, Math.min(1, (y - v.oy) / (v.sh * v.scale))),
    };
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * this.dpr, y: (e.clientY - r.top) * this.dpr };
  }

  _onDown(e) {
    const { x, y } = this._pos(e);
    let hit = -1;
    let bestD = HANDLE_R * this.dpr * 2.4;
    this.quad.forEach((p, i) => {
      const c = this.toCanvas(p);
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestD) {
        bestD = d;
        hit = i;
      }
    });
    if (hit >= 0) {
      this.dragging = hit;
      this.canvas.setPointerCapture?.(e.pointerId);
      this.draw();
      e.preventDefault();
    }
  }

  _onMove(e) {
    const { x, y } = this._pos(e);
    if (this.dragging < 0) {
      // 悬停到角上时给个放大镜预览，方便对准
      const hover = this.quad.findIndex((p) => {
        const c = this.toCanvas(p);
        return Math.hypot(c.x - x, c.y - y) < HANDLE_R * this.dpr * 1.6;
      });
      this.loupe = hover >= 0 ? { x, y, at: this.quad[hover] } : null;
      this.canvas.style.cursor = hover >= 0 ? 'grab' : 'crosshair';
      this.draw();
      return;
    }
    const n = this.toNorm(x, y);
    this.quad[this.dragging] = n;
    this.loupe = { x, y, at: n };
    this.draw();
    e.preventDefault();
  }

  _onUp(e) {
    if (this.dragging >= 0) {
      this.dragging = -1;
      this.canvas.releasePointerCapture?.(e.pointerId);
      this.loupe = null;
      this.draw();
      this.canvas.dispatchEvent(new CustomEvent('cropchange', { detail: this.getQuad() }));
    }
  }

  getQuad() {
    return this.quad.map((p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) }));
  }

  setQuad(quad) {
    this.quad = quad.map((p) => ({ ...p }));
    this.draw();
  }

  resetFull() {
    this.setQuad(this.full);
  }

  destroy() {
    this.canvas.removeEventListener('pointerdown', this._onDown);
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerup', this._onUp);
    this.canvas.removeEventListener('pointercancel', this._onUp);
  }

  draw() {
    const ctx = ctx2d(this.canvas, { alpha: false });
    const { width: W, height: H } = this.canvas;
    ctx.save();
    ctx.fillStyle = '#101014';
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.source, this.view.ox, this.view.oy, this.view.sw * this.view.scale, this.view.sh * this.view.scale);

    const pts = this.quad.map((p) => this.toCanvas(p));

    // 遮罩：把选区外压暗，视觉上一眼看清裁到哪里
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = pts.length - 1; i >= 1; i--) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(8,10,14,0.62)';
    ctx.fill('evenodd');
    ctx.restore();

    // 选区边框
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.lineWidth = 2 * this.dpr;
    ctx.strokeStyle = '#34d399';
    ctx.stroke();

    // 四角手柄
    const r = HANDLE_R * this.dpr * (this.dragging >= 0 ? 0.72 : 1);
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = i === this.dragging ? '#34d399' : 'rgba(255,255,255,0.94)';
      ctx.fill();
      ctx.lineWidth = 2.5 * this.dpr;
      ctx.strokeStyle = '#059669';
      ctx.stroke();
    });

    if (this.loupe) this._drawLoupe(ctx, this.loupe);
    ctx.restore();
  }

  /** 放大镜：拖动角点时在手指旁边显示 2.5 倍局部放大，避免"盲拖" */
  _drawLoupe(ctx, { x, y, at }) {
    const R = 46 * this.dpr;
    const zoom = 2.6;
    const cx = Math.min(this.canvas.width - R - 4, Math.max(R + 4, x));
    const cy = Math.min(this.canvas.height - R - 4, Math.max(R + 4, y - R * 1.5));
    const v = this.view;
    const sx = at.x * v.sw;
    const sy = at.y * v.sh;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    const half = R / (v.scale * zoom);
    ctx.drawImage(this.source, sx - half, sy - half, half * 2, half * 2, cx - R, cy - R, R * 2, R * 2);
    // 十字准星
    ctx.strokeStyle = 'rgba(52,211,153,0.9)';
    ctx.lineWidth = 1.5 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(cx - R * 0.5, cy);
    ctx.lineTo(cx + R * 0.5, cy);
    ctx.moveTo(cx, cy - R * 0.5);
    ctx.lineTo(cx, cy + R * 0.5);
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.lineWidth = 2 * this.dpr;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
  }
}

/** 归一化矩形 → 四角点（左上、右上、右下、左下） */
export function rectToQuad(r) {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

/** 四角点 → 归一化外接矩形 */
export function quadToRect(quad) {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
