/**
 * detect.js 的测试——文档边缘自动检测。
 *
 * 为什么这个文件值得单独测：它是"歪着拍的纸能不能被掰正"的第一道关，
 * 一旦它给错四角，后面裁出来的图就是歪的或者带着一圈桌面。
 * 而它本身是纯像素运算（输入 RGBA、输出四角坐标，不碰 canvas），
 * 所以完全可以在 Node 里造几张"已知答案"的假照片来验它。
 *
 * 造图方式：暗背景上画一块亮的四边形（用射线法逐像素判断点是否在多边形内），
 * 再叠一点固定种子的噪点，尽量像真照片而不是理想图形。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDocument } from '../js/detect.js';
import { quadArea, orderCorners } from '../js/geometry.js';

/* ------------------------------------------------------------------ */
/* 造图工具                                                            */
/* ------------------------------------------------------------------ */

/** 固定种子的伪随机（保证测试可重复，不用 Math.random） */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 画一张"照片"：暗背景 + 一块亮的四边形纸张。
 * @param {number} w
 * @param {number} h
 * @param {{x:number,y:number}[]} quad 纸张四角（像素坐标），顺序随意
 * @param {{bg?:number, paper?:number, noise?:number, shadow?:number}} opts
 */
function makePhoto(w, h, quad, opts = {}) {
  const { bg = 62, paper = 238, noise = 6, shadow = 0.22 } = opts;
  const r = rng(20261013);
  const data = new Uint8ClampedArray(w * h * 4);

  // 四边形的包围盒，缩小逐点判断的范围
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const minX = Math.max(0, Math.floor(Math.min(...xs)) - 2);
  const maxX = Math.min(w - 1, Math.ceil(Math.max(...xs)) + 2);
  const minY = Math.max(0, Math.floor(Math.min(...ys)) - 2);
  const maxY = Math.min(h - 1, Math.ceil(Math.max(...ys)) + 2);

  const inside = (x, y) => {
    let hit = false;
    for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
      const a = quad[i];
      const b = quad[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let v;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY && inside(x, y)) {
        // 纸张：左上角稍暗一点，模拟拍照时的光照不均
        const edge = (x - minX) / Math.max(1, maxX - minX) * 0.5 + (y - minY) / Math.max(1, maxY - minY) * 0.5;
        v = paper - shadow * 90 * (1 - edge);
      } else {
        v = bg;
      }
      v += (r() - 0.5) * noise * 2;
      data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, v));
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** 两个四边形对应角的平均距离（都按 左上→右上→右下→左下 先排好） */
function cornerError(found, truth) {
  const a = orderCorners(found);
  const b = orderCorners(truth);
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]);
  return sum / 4;
}

const W = 480;
const H = 360;

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

test('正对着拍的纸：四角误差小于 2%', () => {
  const truth = [
    [70, 45],
    [410, 45],
    [410, 315],
    [70, 315],
  ];
  const img = makePhoto(W, H, truth.map(([x, y]) => ({ x, y })));
  const res = detectDocument(img);

  assert.equal(res.found, true, '应该找到文档');
  assert.ok(res.confidence > 0.5, `置信度太低：${res.confidence}`);
  const err = cornerError(res.corners, truth);
  assert.ok(err < 0.02 * Math.hypot(W, H), `四角平均偏差 ${err.toFixed(1)}px 太大`);
  // 面积也要对得上
  assert.ok(Math.abs(quadArea(res.corners) - quadArea(truth)) / quadArea(truth) < 0.08, '面积偏差过大');
});

test('旋转 12° 的纸：依然能找到，且四角跟着转', () => {
  const cx = W / 2;
  const cy = H / 2;
  const a = (12 * Math.PI) / 180;
  const hw = 170;
  const hh = 135;
  const truth = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => [cx + x * Math.cos(a) - y * Math.sin(a), cy + x * Math.sin(a) + y * Math.cos(a)]);

  const img = makePhoto(W, H, truth.map(([x, y]) => ({ x, y })));
  const res = detectDocument(img);

  assert.equal(res.found, true, '旋转的纸也应该找到');
  const err = cornerError(res.corners, truth);
  assert.ok(err < 0.025 * Math.hypot(W, H), `旋转情形四角平均偏差 ${err.toFixed(1)}px 太大`);

  // 检测出来的上边应该也是斜的（说明确实是四边形，不是轴对齐的框）
  const ordered = orderCorners(res.corners);
  const tilt = Math.atan2(ordered[1][1] - ordered[0][1], ordered[1][0] - ordered[0][0]) * (180 / Math.PI);
  assert.ok(Math.abs(Math.abs(tilt) - 12) < 3, `上边倾角应为 12° 左右，实际 ${tilt.toFixed(1)}°`);
});

test('斜着拍的纸（梯形透视）：这才是手机最常见的场景', () => {
  // 下边比上边宽、右边比左边高 → 典型的手持俯拍
  const truth = [
    [110, 40],
    [370, 70],
    [420, 320],
    [60, 300],
  ];
  const img = makePhoto(W, H, truth.map(([x, y]) => ({ x, y })));
  const res = detectDocument(img);

  assert.equal(res.found, true, '透视情形也应该找到');
  const err = cornerError(res.corners, truth);
  assert.ok(err < 0.03 * Math.hypot(W, H), `透视情形四角平均偏差 ${err.toFixed(1)}px 太大`);

  // 关键：轴对齐的框不可能同时贴合这四个角——上边明显比下边窄
  const ordered = orderCorners(res.corners);
  const topW = Math.hypot(ordered[1][0] - ordered[0][0], ordered[1][1] - ordered[0][1]);
  const bottomW = Math.hypot(ordered[2][0] - ordered[3][0], ordered[2][1] - ordered[3][1]);
  assert.ok(bottomW > topW * 1.1, `应识别出"下宽上窄"的透视（上 ${topW.toFixed(0)} / 下 ${bottomW.toFixed(0)}）`);
});

test('画面里没有纸：不能凭空裁出一小块', () => {
  // 纯噪声，没有任何文档结构
  const r = rng(7);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    const v = 90 + r() * 60;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  const res = detectDocument({ data, width: W, height: H });

  // 断言的是"不会造成伤害"，而不是"它必须说没找到"：
  // 噪声里确实可能连出一圈闭合边缘，硬要求它 found===false 是过度约束。
  // 真正要守住的是——它绝不能凭空框出一小块"文档"，
  // 那样用户会看到照片被莫名其妙裁掉一大半。
  // （即使它返回了接近整幅画面的框，crop.js 里 areaRatio > 0.985 那道闸也会拦掉。）
  const area = res.found ? quadArea(res.corners) / (W * H) : 0;
  assert.ok(!res.found || area > 0.9, `噪声里框出了 ${(area * 100).toFixed(0)}% 的小框，会误裁用户照片`);
});

test('上边几乎水平、右上角只比左上角高 0.05 像素：起点仍必须是左上角', () => {
  // 这是真踩过的坑：起点原来按"y 最小"选，于是右上角凭 0.05 像素的噪声胜出，
  // 整个四边形被当作从右上角开始，warp 出来整页躺倒 90°。
  const quad = [
    [409.132, 44.523],
    [409.505, 314.505],
    [69.542, 314.469],
    [69.513, 44.573],
  ];
  const [tl, tr, br, bl] = orderCorners(quad);
  assert.ok(tl[0] < tr[0], `左上应在右上左边，实际 tl=${tl} tr=${tr}`);
  assert.ok(tl[1] < bl[1], '左上应比左下高');
  assert.ok(tr[1] < br[1], '右上应比右下高');
  // 起点必须是 (69.513,44.573)，不是 (409.132,44.523)
  assert.ok(Math.abs(tl[0] - 69.513) < 0.01, `起点跑到了 x=${tl[0]}，应为左上的 69.513`);
});

test('纸张只占很小一块：不能当成文档（避免把桌上一张名片当整页纸）', () => {
  const truth = [
    [210, 160],
    [270, 160],
    [270, 200],
    [210, 200],
  ];
  const img = makePhoto(W, H, truth.map(([x, y]) => ({ x, y })));
  const res = detectDocument(img);
  assert.ok(!res.found || res.confidence < 0.5, `小目标不该给高置信度：${res.confidence}`);
});

test('输入尺寸太小：走兜底而不是崩', () => {
  const res = detectDocument({ data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 });
  assert.equal(res.found, false);
  assert.equal(res.corners.length, 4);
});

test('四角顺序是 左上→右上→右下→左下（warpPerspective 依赖它）', () => {
  const truth = [
    [80, 50],
    [400, 60],
    [390, 310],
    [70, 300],
  ];
  const img = makePhoto(W, H, truth.map(([x, y]) => ({ x, y })));
  const res = detectDocument(img);
  assert.equal(res.found, true);
  const [tl, tr, br, bl] = orderCorners(res.corners);
  assert.ok(tl[1] < bl[1], '左上应该比左下高');
  assert.ok(tr[1] < br[1], '右上应该比右下高');
  assert.ok(tl[0] < tr[0], '左上应该在右上左边');
  assert.ok(bl[0] < br[0], '左下应该在右下左边');
});
