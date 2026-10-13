/**
 * make-icons.mjs —— 生成 PWA 图标（纯 Node，零依赖）。
 *
 * 为什么不直接用 SVG：iOS 的 apple-touch-icon 和部分安卓启动器只认 PNG。
 * 这里用 zlib 手写 PNG 编码器，把图标程序化画出来，
 * 这样图标改了只要重跑一次 `node tools/make-icons.mjs`，
 * 不需要装 sharp / canvas 这类带二进制依赖的包。
 *
 * 用法：node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

/* ----------------------------- PNG 编码 ----------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** RGBA 像素数组 → PNG 文件字节 */
function encodePNG(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ----------------------------- 绘图工具 ----------------------------- */

/** 圆角矩形有符号距离函数（负值在内部） */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 画图标。
 * @param {number} size 边长
 * @param {boolean} maskable 是否给安卓自适应图标留安全边距（内容缩到 78%）
 */
function drawIcon(size, maskable = false) {
  const buf = Buffer.alloc(size * size * 4);
  const S = size;
  const c = S / 2;
  const inset = maskable ? S * 0.11 : 0;
  const scale = maskable ? 0.78 : 1;

  const teal = [15, 118, 110];
  const green = [16, 185, 129];
  const white = [255, 255, 255];
  const ink = [120, 132, 145];
  const accent = [250, 204, 21];

  // 纸张几何（居中，按 scale 缩放）
  const paperW = S * 0.30 * scale;
  const paperH = S * 0.38 * scale;
  const paperX = c + S * 0.005 * scale;
  const paperY = c + S * 0.035 * scale;
  const rad = S * 0.045 * scale;

  const superSample = 3;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < superSample; sy++) {
        for (let sx = 0; sx < superSample; sx++) {
          const px = x + (sx + 0.5) / superSample;
          const py = y + (sy + 0.5) / superSample;

          // 1) 背景：圆角方块 + 对角渐变
          const bgD = sdRoundRect(px, py, c, c, c - inset * 0.0, c - inset * 0.0, S * (maskable ? 0.5 : 0.225));
          const bgA = clamp01(0.5 - bgD);
          let col = mix(teal, green, clamp01((px + py) / (2 * S)));

          // 2) 纸张（白色圆角矩形）
          const pD = sdRoundRect(px, py, paperX, paperY, paperW, paperH, rad);
          const pA = clamp01(0.5 - pD);
          if (pA > 0) col = mix(col, white, pA);

          // 3) 纸张内的文字横线
          for (let i = 0; i < 4; i++) {
            const ly = paperY - paperH * 0.52 + paperH * (0.30 + i * 0.26);
            const lw = i === 3 ? paperW * 0.42 : paperW * 0.62;
            const lD = sdRoundRect(px, py, paperX - paperW * 0.05, ly, lw, paperH * 0.045, paperH * 0.045);
            const lA = clamp01(0.5 - lD) * pA;
            if (lA > 0) col = mix(col, ink, lA * 0.85);
          }

          // 4) 扫描光带（横穿纸张的一条亮线）
          const bandY = paperY - paperH * 0.62;
          const bD = Math.abs(py - bandY) - S * 0.012 * scale;
          const bA = clamp01(0.5 - bD);
          if (bA > 0) {
            const overPaper = clamp01(0.5 - sdRoundRect(px, py, paperX, bandY, paperW + S * 0.035 * scale, S * 0.012 * scale, S * 0.012 * scale));
            col = mix(col, accent, bA * (0.35 + overPaper * 0.65));
          }

          r += col[0] * bgA;
          g += col[1] * bgA;
          b += col[2] * bgA;
          a += 255 * bgA;
        }
      }
      const n = superSample * superSample;
      const o = (y * S + x) * 4;
      const alpha = a / n;
      buf[o] = Math.round(r / n);
      buf[o + 1] = Math.round(g / n);
      buf[o + 2] = Math.round(b / n);
      buf[o + 3] = Math.round(alpha);
    }
  }
  return encodePNG(buf, S, S);
}

/* ----------------------------- 写文件 ----------------------------- */

mkdirSync(OUT, { recursive: true });
const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-180.png', 180, false],
  ['icon-maskable-512.png', 512, true],
];
for (const [name, size, maskable] of targets) {
  const png = drawIcon(size, maskable);
  writeFileSync(join(OUT, name), png);
  console.log(`✓ ${name}  ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
