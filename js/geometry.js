/**
 * geometry.js —— 纯数学模块，不依赖 DOM，可在 Node 中直接测试。
 *
 * 核心内容：
 *   1. 四角点排序 / 四边形度量
 *   2. 由 4 组对应点求解单应矩阵（Homography）
 *   3. 透视校正（把任意四边形"拉平"成矩形），双线性重采样
 */

/** 两点距离 */
export function dist(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.hypot(dx, dy);
}

/** 四边形面积（鞋带公式，取绝对值） */
export function quadArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/**
 * 把任意顺序的四个点整理成 [左上, 右上, 右下, 左下]。
 *
 * 做法：绕重心按极角升序排成一环，再把"最靠上的那个角"转到第一位。
 * 屏幕坐标 y 轴朝下，极角升序恰好是**顺时针**，所以从最上面的角顺着走
 * 就是 左上 → 右上 → 右下 → 左下。
 *
 * 这个顺序是 warpPerspective 的输入契约：它把四角依次映射到输出矩形的
 * 左上/右上/右下/左下。顺序只要错一位，裁出来的就是镜像或者拧成蝴蝶结的图，
 * 所以这里必须严格确定，不能靠"碰巧对"。
 *
 * （旧实现先按极角排序、又用叉积判断方向去"修正"，两道判断互相打架，
 * 实测对同一个矩形返回的是 左上→左下→右下→右上 的逆时针环，
 * 而且对几乎一样的输入会给出不同结果——已删除。）
 */
export function orderCorners(pts) {
  const p = pts.map((q) => [q[0], q[1]]);
  if (p.length !== 4) throw new Error('orderCorners 需要 4 个点');

  const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4;
  const cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
  const ring = p
    .slice()
    .sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));

  // 起点选"最靠左上"的那个角：得分 = 往上多少 + 往左多少。
  //
  // 这里千万不能用"y 最小的角"当起点。拍照时纸的上边几乎水平，左上和右上
  // 谁高一点完全取决于几个像素的噪声：实测一张合成照片里右上角只比左上角
  // 高 0.05 像素，起点就跳到了右上角，整张纸被当成转了 90°——裁出来是躺着的。
  // 而"往左上多少"这个得分在正常角度下相差极大（正放的纸：左上 305 分，
  // 右上 -35 分），噪声根本撼动不了。
  let start = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < 4; i++) {
    const score = cy - ring[i][1] + (cx - ring[i][0]);
    if (score > bestScore) {
      bestScore = score;
      start = i;
    }
  }
  return ring.slice(start).concat(ring.slice(0, start));
}

/**
 * 求解 8x8 线性方程组 Ax = b（高斯消元 + 部分主元）。
 * A 为 8x8 的普通数组（行优先），b 长度 8。返回未知数数组，奇异时返回 null。
 */
function solveLinear8(A, b) {
  const n = 8;
  const m = A.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < n; col++) {
    // 选主元
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    }
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    if (piv !== col) {
      const t = m[piv];
      m[piv] = m[col];
      m[col] = t;
    }
    const d = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n]);
}

/**
 * 求解单应矩阵 H，使得 H * src[i] = dst[i]（齐次坐标，h22 固定为 1）。
 * 返回行优先的 9 元素数组 [h00..h22]，无解返回 null。
 */
export function solveHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  const h = solveLinear8(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** 用单应矩阵变换一个点 */
export function applyH(h, x, y) {
  const d = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
}

/**
 * 根据四角估算"拉平"后的目标像素尺寸。
 * 取对边长度的最大值，保证细节不被压缩。
 */
export function quadSize(corners) {
  const [tl, tr, br, bl] = corners;
  const w = Math.max(dist(tl, tr), dist(bl, br));
  const h = Math.max(dist(tl, bl), dist(tr, br));
  return { w, h };
}

/**
 * 透视校正 + 双线性重采样。
 *
 * @param {Uint8ClampedArray|Uint8Array} srcRGBA 源图 RGBA 数据
 * @param {number} sw 源宽
 * @param {number} sh 源高
 * @param {number} dw 目标宽
 * @param {number} dh 目标高
 * @param {number[][]} corners 文档四角，顺序 [TL, TR, BR, BL]，源图坐标
 * @returns {Uint8ClampedArray} 目标 RGBA 数据
 *
 * 说明：H 由"目标矩形 -> 源四边形"求得，因此是反向映射逐像素采样，
 * 不会出现正向映射的孔洞问题。
 */
export function warpPerspective(srcRGBA, sw, sh, dw, dh, corners) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const rect = [
    [0, 0],
    [dw, 0],
    [dw, dh],
    [0, dh],
  ];
  const H = solveHomography(rect, corners);
  if (!H) {
    // 退化情形：直接返回空图（调用方会跳过该页）
    return out;
  }
  const h0 = H[0], h1 = H[1], h2 = H[2];
  const h3 = H[3], h4 = H[4], h5 = H[5];
  const h6 = H[6], h7 = H[7], h8 = H[8];
  const maxX = sw - 1.001;
  const maxY = sh - 1.001;

  let o = 0;
  for (let y = 0; y < dh; y++) {
    const py = y + 0.5;
    for (let x = 0; x < dw; x++, o += 4) {
      const px = x + 0.5;
      const d = h6 * px + h7 * py + h8;
      if (d === 0) continue;
      let u = (h0 * px + h1 * py + h2) / d;
      let v = (h3 * px + h4 * py + h5) / d;
      if (u < 0 || v < 0 || u > maxX || v > maxY) continue; // 出界留白

      // 双线性插值
      const x0 = u | 0;
      const y0 = v | 0;
      const x1 = x0 + 1 > maxX ? x0 : x0 + 1;
      const y1 = y0 + 1 > maxY ? y0 : y0 + 1;
      const fx = u - x0;
      const fy = v - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      out[o] = srcRGBA[i00] * w00 + srcRGBA[i10] * w10 + srcRGBA[i01] * w01 + srcRGBA[i11] * w11;
      out[o + 1] = srcRGBA[i00 + 1] * w00 + srcRGBA[i10 + 1] * w10 + srcRGBA[i01 + 1] * w01 + srcRGBA[i11 + 1] * w11;
      out[o + 2] = srcRGBA[i00 + 2] * w00 + srcRGBA[i10 + 2] * w10 + srcRGBA[i01 + 2] * w01 + srcRGBA[i11 + 2] * w11;
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * 把四边形往中心收缩一点，避免把文档边缘的背景像素、阴影一起框进来。
 * @param {number[][]} corners
 * @param {number} ratio 每边向内收缩的比例（相对该边长度）
 */
export function shrinkQuad(corners, ratio = 0.006) {
  const [tl, tr, br, bl] = corners;
  const cx = (tl[0] + tr[0] + br[0] + bl[0]) / 4;
  const cy = (tl[1] + tr[1] + br[1] + bl[1]) / 4;
  return corners.map((p) => {
    const dx = cx - p[0];
    const dy = cy - p[1];
    const len = Math.hypot(dx, dy) || 1;
    const move = Math.min(len * ratio * 4, len * 0.5);
    return [p[0] + (dx / len) * move, p[1] + (dy / len) * move];
  });
}

/** 限制四角坐标在图像范围内 */
export function clampQuad(corners, w, h) {
  return corners.map((p) => [
    Math.min(Math.max(p[0], 0), w - 1),
    Math.min(Math.max(p[1], 0), h - 1),
  ]);
}
