/**
 * pdf.js —— 零依赖的 PDF 生成器。
 *
 * 只做一件事：把若干张 JPEG 页面拼成一个多页 PDF。
 * 不需要 jsPDF 之类的几百 KB 依赖，浏览器和 Node 里都能跑（纯 Uint8Array 运算），
 * 因此可以在 Node 里写单元测试，再用任意 PDF 阅读器验证。
 *
 * 图片以 DCTDecode（即原始 JPEG 数据）直接内嵌，不做二次编码，画质无损、体积最小。
 */

const A4 = { w: 595.276, h: 841.89 }; // 单位：pt（1/72 英寸）

/**
 * Helvetica 的字符宽度表（AFM 标准值，单位 1/1000 em，下标 = ASCII - 32）。
 *
 * 为什么要自己带一份：文字版 PDF 要按宽度折行，而折行的准确性完全取决于宽度。
 * 这张表是 Adobe 公开的标准值，抄下来比引一个几百 KB 的字体库划算得多。
 */
const HELVETICA_W = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
];

/** 字符串 → Latin-1 字节 */
function str(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * PDF 文本字符串：ASCII 用字面量，含非 ASCII 时用 UTF-16BE 十六进制串。
 * 这样中文标题在标准阅读器里也能正确显示。
 */
function pdfString(s) {
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 126) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    return '(' + s.replace(/[\\()]/g, (m) => '\\' + m) + ')';
  }
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) {
    hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  }
  return '<' + hex + '>';
}

/** PDF 日期格式：D:YYYYMMDDHHmmSS+HH'mm' */
function pdfDate(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const ao = Math.abs(off);
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}${sign}${p(Math.floor(ao / 60))}'${p(ao % 60)}'`;
}

/**
 * 生成 PDF。
 *
 * @param {Array<{jpeg: Uint8Array, width: number, height: number}>} pages
 *        每个页面的 JPEG 字节与像素尺寸（width/height 为像素）
 * @param {{pageSize?: 'a4'|'auto', margin?: number, dpi?: number, title?: string, author?: string}} [opts]
 * @returns {Uint8Array} 完整的 PDF 文件字节
 */
export function buildPDF(pages, opts = {}) {
  const pageSize = opts.pageSize || 'a4';
  const margin = opts.margin == null ? 18 : opts.margin;
  const dpi = opts.dpi || 200;
  const title = opts.title || '扫描文档';
  const author = opts.author || '全民扫描 ScanFree';

  if (!pages.length) throw new Error('PDF 至少需要一页');

  const chunks = [];
  let length = 0;
  const push = (u8) => {
    chunks.push(u8);
    length += u8.length;
  };

  const objCount = 2 + pages.length * 3;
  const offsets = new Array(objCount + 1).fill(0);

  push(str('%PDF-1.4\n'));
  // 二进制标记，提示阅读器这是二进制文件
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const beginObj = (num) => {
    offsets[num] = length;
    push(str(`${num} 0 obj\n`));
  };
  const endObj = () => push(str('endobj\n'));

  // 1: Catalog
  beginObj(1);
  push(str('<< /Type /Catalog /Pages 2 0 R >>\n'));
  endObj();

  // 2: Pages（Kids 稍后填）
  beginObj(2);
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  push(str(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\n`));
  endObj();

  pages.forEach((page, i) => {
    const pageNum = 3 + i * 3;
    const contentNum = pageNum + 1;
    const imageNum = pageNum + 2;
    const imgName = `Im${i}`;

    // 计算页面尺寸与图片摆放位置
    let pw;
    let ph;
    if (pageSize === 'auto') {
      pw = (page.width * 72) / dpi;
      ph = (page.height * 72) / dpi;
    } else {
      pw = A4.w;
      ph = A4.h;
    }
    const availW = Math.max(1, pw - margin * 2);
    const availH = Math.max(1, ph - margin * 2);
    const scale = Math.min(availW / page.width, availH / page.height);
    const dw = page.width * scale;
    const dh = page.height * scale;
    const dx = (pw - dw) / 2;
    const dy = (ph - dh) / 2;

    // Page 对象
    beginObj(pageNum);
    push(
      str(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] ` +
          `/Resources << /XObject << /${imgName} ${imageNum} 0 R >> /ProcSet [/PDF /ImageC] >> ` +
          `/Contents ${contentNum} 0 R >>\n`
      )
    );
    endObj();

    // 内容流
    const content = `q\n${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${dx.toFixed(2)} ${dy.toFixed(2)} cm\n/${imgName} Do\nQ\n`;
    beginObj(contentNum);
    push(str(`<< /Length ${content.length} >>\nstream\n`));
    push(str(content));
    push(str('endstream\n'));
    endObj();

    // 图片 XObject（原始 JPEG 数据直接内嵌）
    beginObj(imageNum);
    push(
      str(
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`
      )
    );
    push(page.jpeg);
    push(str('\nendstream\n'));
    endObj();
  });

  // 文档信息
  const infoNum = objCount + 1;
  beginObj(infoNum);
  push(
    str(
      `<< /Title ${pdfString(title)} /Author ${pdfString(author)} ` +
        `/Producer ${pdfString('ScanFree')} /Creator ${pdfString('ScanFree')} ` +
        `/CreationDate ${pdfString(pdfDate())} /ModDate ${pdfString(pdfDate())} >>\n`
    )
  );
  endObj();

  // 交叉引用表
  const xrefOffset = length;
  const total = infoNum + 1;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  push(str(xref));
  push(str(`trailer\n<< /Size ${total} /Root 1 0 R /Info ${infoNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));

  // 合并
  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/* ============================ 文字版 PDF ============================
 *
 * 把识别出来的文字**做成真正的文字**排成 PDF：能选中、能搜索、能复制，
 * 文件几 KB 而不是几 MB，打印也清楚。这是扫描件的另一种用法——
 * 有时候你要的不是那张照片，而是照片里的字。
 *
 * 中文字体怎么办？这是本文件最需要解释的一个决定：
 * 嵌入一个中文字体要 5~15MB（CJK 字库就是这么胖），而这个 App 的全部代码
 * 加起来才 200KB。所以这里用 PDF 标准里的**非嵌入 CID 字体** STSong-Light +
 * UniGB-UCS2-H 编码：文件里只写"这个字是 U+4E2D"，由阅读器用它自己的宋体渲染。
 * Acrobat、macOS/iOS 预览、WPS、福昕、Firefox 都认这套（它们是 Adobe 的标准字体名）；
 * 代价是个别精简的阅读器可能显示不出来——所以导出菜单里**图片版 PDF 始终保留**，
 * 要 100% 保真就用那一份。
 */

const NO_LINE_START = new Set('，。、；：？！）］｝』」》〉】〕”’…·,.;:?!)]}>％%');
const NO_LINE_END = new Set('（［｛『「《〈【〔“‘([{<');

/** 全角字符（一个汉字宽的）：这些交给宋体，宽度按 1 em 算 */
function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function charWidth(code) {
  if (code >= 32 && code <= 126) return HELVETICA_W[code - 32];
  if (isWide(code)) return 1000;
  if (code < 256) return 556; // WinAnsi 里的西欧重音字母，取个平均值就够排版用了
  return 1000;
}

/** 一个字符串在给定字号下有多宽（pt） */
export function measureText(s, size) {
  let w = 0;
  for (const ch of String(s)) w += (charWidth(ch.codePointAt(0)) * size) / 1000;
  return w;
}

/** 切成排版单元：英文单词（含词尾空格）算一个，汉字一个字算一个 */
function tokenize(para) {
  const tokens = [];
  let buf = '';
  for (const ch of para) {
    if (isWide(ch.codePointAt(0))) {
      if (buf) {
        tokens.push(buf);
        buf = '';
      }
      tokens.push(ch);
    } else if (ch === ' ') {
      buf += ch;
      tokens.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);
  return tokens;
}

/** 折行。规则：英文按词断、汉字任意断、标点不顶行首（宁可让那行稍微出一点头） */
export function wrapParagraph(para, maxWidth, size) {
  const lines = [];
  let line = '';
  let w = 0;
  const flush = () => {
    lines.push(line.replace(/\s+$/, ''));
    line = '';
    w = 0;
  };
  for (const tk of tokenize(para)) {
    const tw = measureText(tk, size);
    if (w > 0 && w + tw > maxWidth) {
      if (tk.length === 1 && NO_LINE_START.has(tk)) {
        line += tk;
        w += tw;
        continue;
      }
      flush();
    }
    if (tw > maxWidth && [...tk].length > 1) {
      // 单个 token 就比一整行还宽（超长英文单词、一长串数字）：硬切
      for (const ch of tk) {
        const cw = measureText(ch, size);
        if (w + cw > maxWidth) flush();
        line += ch;
        w += cw;
      }
      continue;
    }
    line += tk;
    w += tw;
  }
  flush();
  return lines;
}

/** CID 字体的字符串：UTF-16BE 的十六进制。UniGB-UCS2-H 就是按码位直接映射的 */
function cidHex(s) {
  let h = '';
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, '0');
  return `<${h.toUpperCase()}>`;
}

/** Helvetica 的字符串：转义括号和反斜杠 */
function latStr(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + ch;
    else if (c < 256) out += ch;
    else out += '?';
  }
  return `(${out})`;
}

/** 一行文字 → PDF 绘制指令（按字体切成若干段，逐段定位） */
function lineOps(line, x0, y, size) {
  const runs = [];
  let cur = null;
  for (const ch of line) {
    const code = ch.codePointAt(0);
    const font = isWide(code) || code > 255 ? 'F2' : 'F1';
    if (!cur || cur.font !== font) {
      cur = { font, text: '' };
      runs.push(cur);
    }
    cur.text += ch;
  }
  let s = '';
  let x = x0;
  for (const r of runs) {
    const payload = r.font === 'F2' ? cidHex(r.text) : latStr(r.text);
    s += `BT /${r.font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${payload} Tj ET\n`;
    x += measureText(r.text, size);
  }
  return s;
}

/**
 * 生成"文字版"PDF：内容是真文字，不是图片。
 *
 * @param {string} text 识别/编辑后的纯文本；用 \f 强制翻页（多页扫描件一页对一页）
 * @param {{title?: string, size?: number, lineHeight?: number, margin?: number,
 *          pageNumbers?: boolean, author?: string}} [opts]
 * @returns {Uint8Array}
 */
export function buildTextPDF(text, opts = {}) {
  const body = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
  if (!body) throw new Error('还没有可导出的文字');

  const size = opts.size || 10.5;
  const lineHeight = (opts.lineHeight || 1.62) * size;
  const margin = opts.margin == null ? 64 : opts.margin;
  const pw = A4.w;
  const ph = A4.h;
  const maxWidth = pw - margin * 2;
  const withNumbers = opts.pageNumbers !== false;
  const title = opts.title || '识别文字';
  const author = opts.author || '全民扫描 ScanFree';

  const usable = ph - margin * 2 - (withNumbers ? lineHeight : 0);
  const perPage = Math.max(1, Math.floor(usable / lineHeight));

  // 1. 先分段（\f = 强制翻页，导出多页扫描件时用它保持一页对一页），
  //    段内排成行（含空行，空行就是段落间距），再按每页能放多少行切页
  const pageLines = [];
  for (const section of body.split('\f')) {
    const sec = section.replace(/^\n+/, '').replace(/\n+$/, '');
    const lines = [];
    for (const para of sec.split('\n')) {
      if (!para.trim()) {
        lines.push('');
        continue;
      }
      for (const l of wrapParagraph(para, maxWidth, size)) lines.push(l);
    }
    if (!lines.length) lines.push('');
    for (let i = 0; i < lines.length; i += perPage) pageLines.push(lines.slice(i, i + perPage));
  }

  // 2. 写对象
  const chunks = [];
  let length = 0;
  const push = (u8) => {
    chunks.push(u8);
    length += u8.length;
  };

  const pageCount = pageLines.length;
  const firstPageObj = 7;
  const objCount = 6 + pageCount * 2 + 1;
  const offsets = new Array(objCount + 1).fill(0);
  const beginObj = (num) => {
    offsets[num] = length;
    push(str(`${num} 0 obj\n`));
  };
  const endObj = () => push(str('endobj\n'));

  push(str('%PDF-1.4\n'));
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // 1: Catalog
  beginObj(1);
  push(str('<< /Type /Catalog /Pages 2 0 R >>\n'));
  endObj();

  // 2: Pages
  beginObj(2);
  const kids = pageLines.map((_, i) => `${firstPageObj + i * 2} 0 R`).join(' ');
  push(str(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\n`));
  endObj();

  // 3: F1 —— Helvetica（PDF 基础 14 字体之一，不必嵌入，任何阅读器都有）
  beginObj(3);
  push(str('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n'));
  endObj();

  // 4: F2 —— 中文用标准 CID 字体 STSong-Light（不嵌入，见文件头的解释）
  beginObj(4);
  push(str('<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>\n'));
  endObj();

  // 5: CIDFont
  beginObj(5);
  push(
    str(
      '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light ' +
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> ' +
        '/FontDescriptor 6 0 R /DW 1000 >>\n'
    )
  );
  endObj();

  // 6: FontDescriptor
  beginObj(6);
  push(
    str(
      '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 ' +
        '/FontBBox [-25 -254 1000 880] /Ascent 880 /Descent -254 /CapHeight 880 /StemV 93 /ItalicAngle 0 >>\n'
    )
  );
  endObj();

  // 页面
  pageLines.forEach((pl, i) => {
    const pageNum = firstPageObj + i * 2;
    const contentNum = pageNum + 1;

    beginObj(pageNum);
    push(
      str(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /ProcSet [/PDF /Text] >> ` +
          `/Contents ${contentNum} 0 R >>\n`
      )
    );
    endObj();

    let content = '';
    let y = ph - margin;
    for (const line of pl) {
      if (line) content += lineOps(line, margin, y, size);
      y -= lineHeight;
    }
    if (withNumbers) {
      content += `BT /F1 9 Tf 1 0 0 1 ${(pw / 2 - 18).toFixed(2)} ${(margin - 26).toFixed(2)} Tm (${i + 1} / ${pageCount}) Tj ET\n`;
    }

    beginObj(contentNum);
    // 内容里全是 ASCII 指令，字节数 = 字符数
    push(str(`<< /Length ${content.length} >>\nstream\n`));
    push(str(content));
    push(str('endstream\n'));
    endObj();
  });

  // 文档信息
  const infoNum = objCount;
  beginObj(infoNum);
  push(
    str(
      `<< /Title ${pdfString(title)} /Author ${pdfString(author)} ` +
        `/Producer ${pdfString('ScanFree')} /Creator ${pdfString('ScanFree')} ` +
        `/CreationDate ${pdfString(pdfDate())} /ModDate ${pdfString(pdfDate())} >>\n`
    )
  );
  endObj();

  const xrefOffset = length;
  const total = infoNum + 1;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(str(xref));
  push(str(`trailer\n<< /Size ${total} /Root 1 0 R /Info ${infoNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
