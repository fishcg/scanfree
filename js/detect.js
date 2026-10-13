/**
 * detect.js —— 文档边缘自动检测。
 *
 * 纯计算模块：输入任意 RGBA 像素数据，输出文档四角坐标（[TL,TR,BR,BL]），
 * 不依赖 canvas，可在 Node 中直接测试。
 *
 * 算法流程（完全自研，无 OpenCV 依赖）：
 *   灰度 → 高斯模糊 → Sobel 梯度 → Otsu 自动阈值 → 形态学膨胀
 *   → 连通域标记 → 取面积最大的候选区域 → 凸包 → 逐步删点收敛到四边形
 *   → 候选评分（周长落在真实边缘上的比例 + 面积占比）→ 边线最小二乘精修
 *
 * 若所有候选都不合格（例如照片里根本没有文档），返回整幅图像作为兜底，
 * 由用户手动拖动四角修正 —— 这是 CamScanner 类产品的标准做法。
 */

import { orderCorners, quadArea } from './geometry.js';

/** 5x5 高斯核（归一化后） */
const GAUSS5 = [1, 4, 7, 4, 1, 4, 16, 26, 16, 4, 7, 26, 41, 26, 7, 4, 16, 26, 16, 4, 1, 4, 7, 4, 1];
const GAUSS5_SUM = 273;

/** RGBA → 灰度 Float32Array */
function grayscale(data, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return g;
}

/** 可分离高斯模糊（边界钳制） */
function gaussianBlur(src, w, h) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const k = [1, 4, 7, 4, 1];
  const ksum = 17;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) {
        let xx = x + i;
        if (xx < 0) xx = 0;
        else if (xx >= w) xx = w - 1;
        s += src[y * w + xx] * k[i + 2];
      }
      tmp[y * w + x] = s / ksum;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) {
        let yy = y + i;
        if (yy < 0) yy = 0;
        else if (yy >= h) yy = h - 1;
        s += tmp[yy * w + x] * k[i + 2];
      }
      out[y * w + x] = s / ksum;
    }
  }
  return out;
}

/** Sobel 梯度幅值 */
function sobel(gray, w, h) {
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = gray[i - w - 1], b = gray[i - w], c = gray[i - w + 1];
      const d = gray[i - 1], f = gray[i + 1];
      const g = gray[i + w - 1], hh = gray[i + w], k = gray[i + w + 1];
      const gx = a + 2 * d + g - (c + 2 * f + k);
      const gy = a + 2 * b + c - (g + 2 * hh + k);
      mag[i] = Math.hypot(gx, gy);
    }
  }
  return mag;
}

/** Otsu 自动阈值 */
function otsu(values, maxVal) {
  const bins = 256;
  const hist = new Uint32Array(bins);
  const scale = (bins - 1) / maxVal;
  for (let i = 0; i < values.length; i++) {
    hist[Math.min(bins - 1, (values[i] * scale) | 0)]++;
  }
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < bins; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best / scale;
}

/** 二值掩膜的膨胀（3x3，可选迭代次数） */
function dilate(mask, w, h, iterations = 1) {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) {
          out[i] = 1;
          continue;
        }
        let hit = 0;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (cur[yy * w + xx]) {
              hit = 1;
              break;
            }
          }
        }
        out[i] = hit;
      }
    }
    cur = out;
  }
  return cur;
}

/** 连通域标记：返回按像素数降序排列的 {pixels:[indices], area, bbox} */
function connectedComponents(mask, w, h, limit = 6) {
  const labels = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const comps = [];
  let next = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    const id = next++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    const pixels = [];
    let minX = w, minY = h, maxX = 0, maxY = 0;
    while (sp > 0) {
      const i = stack[--sp];
      pixels.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] && labels[j] === -1) {
            labels[j] = id;
            stack[sp++] = j;
          }
        }
      }
    }
    comps.push({
      pixels,
      area: pixels.length,
      minX,
      minY,
      maxX,
      maxY,
      bboxArea: (maxX - minX + 1) * (maxY - minY + 1),
    });
  }
  comps.sort((a, b) => b.area - a.area);
  return comps.slice(0, limit);
}

/** Andrew monotone chain 凸包，返回逆时针点列 */
function convexHull(points) {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 三角形面积（用于删点代价评估） */
function triArea(a, b, c) {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}

/**
 * 凸包 → 四边形：每次删掉"删了以后损失面积最小"的顶点。
 * 矩形的尖角损失面积最大，因此会被自动保留下来。
 */
function hullToQuad(hull) {
  let ring = hull.slice();
  while (ring.length > 4) {
    let bestIdx = 0;
    let bestLoss = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const prev = ring[(i - 1 + ring.length) % ring.length];
      const next = ring[(i + 1) % ring.length];
      const loss = triArea(prev, ring[i], next);
      if (loss < bestLoss) {
        bestLoss = loss;
        bestIdx = i;
      }
    }
    ring.splice(bestIdx, 1);
  }
  return ring;
}

/** 在边缘掩膜上按半径搜索，判断点附近是否有边缘 */
function hasEdgeNear(mask, w, h, x, y, radius) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  for (let dy = -radius; dy <= radius; dy++) {
    const yy = yi + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = xi + dx;
      if (xx < 0 || xx >= w) continue;
      if (mask[yy * w + xx]) return true;
    }
  }
  return false;
}

/** 四边形周长落在真实边缘上的比例 */
function edgeSupport(quad, mask, w, h, radius = 2) {
  let hit = 0;
  let total = 0;
  for (let e = 0; e < 4; e++) {
    const a = quad[e];
    const b = quad[(e + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(12, Math.min(160, Math.round(len / 2)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      total++;
      if (hasEdgeNear(mask, w, h, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, radius)) hit++;
    }
  }
  return total ? hit / total : 0;
}

/** 最小二乘拟合直线（总体最小二乘/PCA），返回 {a,b,c} 表示 ax+by+c=0 */
function fitLine(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p[0];
    my += p[1];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p[0] - mx;
    const dy = p[1] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // 主方向向量
  const vx = Math.cos(theta);
  const vy = Math.sin(theta);
  // 法向量 (a,b) = (-vy, vx)
  const a = -vy;
  const b = vx;
  return { a, b, c: -(a * mx + b * my) };
}

/** 两条直线求交 */
function intersect(l1, l2) {
  const det = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(det) < 1e-9) return null;
  return [
    (l1.b * l2.c - l2.b * l1.c) / det,
    (l2.a * l1.c - l1.a * l2.c) / det,
  ];
}

/**
 * 边线精修：沿当前四边形的每条边做垂线搜索，收集真实边缘点，
 * 用最小二乘重新拟合 4 条边，再求交点得到更准的角点。
 */
function refineQuad(quad, mag, w, h, threshold) {
  const lines = [];
  for (let e = 0; e < 4; e++) {
    const a = quad[e];
    const b = quad[(e + 1) % 4];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey) || 1;
    const nx = -ey / len;
    const ny = ex / len;
    const pts = [];
    const steps = Math.max(16, Math.min(200, Math.round(len / 3)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = a[0] + ex * t;
      const py = a[1] + ey * t;
      // 在 ±6 像素范围内找梯度最强的位置作为该处的真实边缘
      let bestScore = threshold;
      let bestX = 0;
      let bestY = 0;
      let found = false;
      for (let d = -6; d <= 6; d += 0.5) {
        const x = Math.round(px + nx * d);
        const y = Math.round(py + ny * d);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        const v = mag[y * w + x];
        if (v > bestScore) {
          bestScore = v;
          bestX = x;
          bestY = y;
          found = true;
        }
      }
      if (found) pts.push([bestX, bestY]);
    }
    const line = pts.length >= Math.max(4, steps * 0.2) ? fitLine(pts) : null;
    lines.push(line);
  }
  if (lines.some((l) => !l)) return quad;
  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p || !isFinite(p[0]) || !isFinite(p[1])) return quad;
    out.push(p);
  }
  return out;
}

/**
 * 主入口：检测文档四角。
 * @param {{data:Uint8ClampedArray,width:number,height:number}} img 建议先把长边缩放到 480 左右再传入
 * @returns {{corners:number[][], confidence:number, found:boolean}}
 */
export function detectDocument(img) {
  const { data, width: w, height: h } = img;
  const imgArea = w * h;
  const fallback = () => ({
    corners: [
      [w * 0.02, h * 0.02],
      [w * 0.98, h * 0.02],
      [w * 0.98, h * 0.98],
      [w * 0.02, h * 0.98],
    ],
    confidence: 0,
    found: false,
  });
  if (w < 24 || h < 24) return fallback();

  let gray = grayscale(data, w, h);
  gray = gaussianBlur(gray, w, h);
  const mag = sobel(gray, w, h);

  let maxMag = 0;
  for (let i = 0; i < mag.length; i++) if (mag[i] > maxMag) maxMag = mag[i];
  if (maxMag < 12) return fallback();

  const t = otsu(mag, maxMag);
  const threshold = Math.max(14, t);

  const raw = new Uint8Array(w * h);
  for (let i = 0; i < mag.length; i++) raw[i] = mag[i] > threshold ? 1 : 0;
  const mask = dilate(raw, w, h, 2);

  const comps = connectedComponents(mask, w, h, 6);
  const candidates = [];

  for (const c of comps) {
    if (c.area < imgArea * 0.002) continue;
    if (c.bboxArea < imgArea * 0.06) continue;
    // 抽稀后求凸包（边界环的凸包即文档外轮廓）
    const step = Math.max(1, Math.floor(c.pixels.length / 8000));
    const pts = [];
    for (let i = 0; i < c.pixels.length; i += step) {
      const idx = c.pixels[i];
      pts.push([idx % w, (idx / w) | 0]);
    }
    const hull = convexHull(pts);
    if (hull.length < 4) continue;
    let quad = hullToQuad(hull);
    if (quad.length !== 4) continue;

    const support = edgeSupport(quad, raw, w, h, 2);
    const areaFrac = quadArea(quad) / imgArea;
    if (areaFrac < 0.06 || areaFrac > 0.995) continue;
    const score = support * (0.55 + 0.45 * Math.sqrt(Math.min(1, areaFrac)));
    candidates.push({ quad, support, areaFrac, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.support < 0.55) return fallback();

  let quad = orderCorners(best.quad);
  const refined = refineQuad(quad, mag, w, h, threshold);
  const refinedArea = quadArea(refined);

  // 精修结果必须仍然合理（面积不能突变、必须凸、必须在图内）
  const okRefine =
    refinedArea > imgArea * 0.05 &&
    refinedArea < imgArea * 1.02 &&
    Math.abs(refinedArea - quadArea(quad)) / quadArea(quad) < 0.25 &&
    refined.every((p) => p[0] > -w * 0.12 && p[0] < w * 1.12 && p[1] > -h * 0.12 && p[1] < h * 1.12);
  if (okRefine) quad = orderCorners(refined);

  return {
    corners: quad,
    confidence: best.support,
    found: true,
  };
}
