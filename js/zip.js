/**
 * zip.js —— 零依赖的 ZIP 打包器（仅存储模式，不压缩）。
 *
 * 用途：把多页扫描结果一次性导出成 zip，浏览器和手机都能直接解压。
 * JPEG 本身已经是压缩格式，再走 deflate 收益极小，所以直接用 store 模式，
 * 既省 CPU 又省内存。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** 计算 CRC32 */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 当前 DOS 时间（ZIP 头使用） */
function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  u8(arr) {
    this.chunks.push(arr);
    this.length += arr.length;
  }
  u16(v) {
    this.u8(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]));
  }
  u32(v) {
    this.u8(new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]));
  }
  blob(type) {
    return new Blob(this.chunks, { type });
  }
}

/**
 * 生成 ZIP。
 * @param {Array<{name: string, data: Uint8Array|ArrayBuffer|Blob}>} files
 * @returns {Promise<Uint8Array>} zip 字节（浏览器里也可以直接 new Blob([bytes])）
 */
export async function buildZip(files) {
  const w = new Writer();
  const { time, date } = dosDateTime();
  const entries = [];

  for (const f of files) {
    let bytes;
    if (f.data instanceof Uint8Array) bytes = f.data;
    else if (f.data instanceof ArrayBuffer) bytes = new Uint8Array(f.data);
    else bytes = new Uint8Array(await f.data.arrayBuffer());

    const nameBytes = new TextEncoder().encode(f.name);
    const crc = crc32(bytes);
    const offset = w.length;

    // Local file header
    w.u32(0x04034b50);
    w.u16(20); // version needed
    w.u16(0x0800); // 通用标志位：文件名使用 UTF-8
    w.u16(0); // 存储模式
    w.u16(time);
    w.u16(date);
    w.u32(crc);
    w.u32(bytes.length);
    w.u32(bytes.length);
    w.u16(nameBytes.length);
    w.u16(0);
    w.u8(nameBytes);
    w.u8(bytes);

    entries.push({ nameBytes, crc, size: bytes.length, offset });
  }

  const cdStart = w.length;
  for (const e of entries) {
    w.u32(0x02014b50);
    w.u16(20); // version made by
    w.u16(20); // version needed
    w.u16(0x0800);
    w.u16(0);
    w.u16(time);
    w.u16(date);
    w.u32(e.crc);
    w.u32(e.size);
    w.u32(e.size);
    w.u16(e.nameBytes.length);
    w.u16(0); // extra
    w.u16(0); // comment
    w.u16(0); // disk
    w.u16(0); // internal attrs
    w.u32(0); // external attrs
    w.u32(e.offset);
    w.u8(e.nameBytes);
  }
  const cdSize = w.length - cdStart;

  // End of central directory
  w.u32(0x06054b50);
  w.u16(0);
  w.u16(0);
  w.u16(entries.length);
  w.u16(entries.length);
  w.u32(cdSize);
  w.u32(cdStart);
  w.u16(0);

  const out = new Uint8Array(w.length);
  let o = 0;
  for (const c of w.chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
