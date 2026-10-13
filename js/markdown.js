// 模型吐出来的 Markdown → 结构化的"文档块"。
//
// 为什么要多这一层：手机拍一张有格式的合同，光把字认出来是不够的——用户要的是
// "把这份文档复制下来"。字后面藏着的结构（哪行是标题、哪块是表格、哪些字加粗）
// 才是"格式"。所以我们让模型直接吐 Markdown（它最擅长这个），再由这里解析成
// 与渲染器无关的块数组，同一份块既能排成 Word（js/docx.js）也能排成 PDF
// （js/pdf.js 的 buildMarkdownPDF）。
//
// 解析器要**健壮**而不是严格：输入是模型现场生成的，可能少一个竖线、多个空格、
// 表格没有分隔行。宁可降级成普通段落，也不要抛异常——用户手上就这一份识别结果。
//
// 这个模块被浏览器和 Node 同时使用（服务端要用这里的中文提示词），所以
// **不许碰任何 DOM 或浏览器专属 API**。

/**
 * 让模型按排版结构输出的指令。
 * 服务端与前端共用同一份，避免两边的口径漂移。
 */
export const LAYOUT_PROMPT = `你是一个文档数字化引擎。把这张文档照片转成 Markdown，尽量保留原排版结构：
- 标题层级用 # / ## / ###（按字号和位置判断，整页最大的那行通常是 #）
- 加粗用 **文字**，斜体用 *文字*
- 无序列表用 - ，有序列表用 1. 2.
- 表格用 Markdown 表格（| 列 | 列 |），第二行必须是 | --- | --- | 分隔行
- 段落之间空一行
- 只输出 Markdown 本身。不要解释、不要代码围栏、不要"以下是"之类的话。`;

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;

/** 中日韩文字：用于决定软换行拼接时要不要加空格（中文之间加空格是错的） */
function isWide(ch) {
  if (!ch) return false;
  const c = ch.codePointAt(0);
  return (
    (c >= 0x3040 && c <= 0x30ff) || // 假名
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) || // 汉字
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xff00 && c <= 0xffef) || // 全角
    (c >= 0x20000 && c <= 0x3ffff)
  );
}

/**
 * 拼接同一段落里的多行。
 *
 * 这里**故意保留换行**，与标准 Markdown 的"软换行合并成一段"不同：
 * 我们处理的是扫描件，原文档里的一行往往就是一条独立信息——
 *   「出租方（甲方）：张明  身份证号：3101***********1234」
 *   「承租方（乙方）：李华  身份证号：3101***********5678」
 * 一旦合并成一段，导出的 Word/PDF 会把两个人名挤成一串读不通的长句，
 * 用户看到的就不再是"他拍的那份文件"。所以行是行，段是段。
 * 渲染端（pdf.js 的 wrapRuns、docx.js）把 \n 当成硬换行处理。
 */
function joinSoft(lines) {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * 解析行内格式。
 * @param {string} text
 * @returns {Array<{type:'text'|'bold'|'italic'|'bolditalic'|'code'|'link', text:string, href?:string}>}
 */
export function parseInline(text) {
  const src = String(text ?? '');
  const out = [];
  if (!src) return out;

  const push = (type, t, href) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev && prev.type === type && !href && !prev.href) prev.text += t; // 同类型合并，少几个 run
    else out.push(href ? { type, text: t, href } : { type, text: t });
  };
  const plain = (t) => push('text', t);

  // 把内层已经解析好的片段"升级"成加粗/斜体。
  // 为什么不嵌套解析：`**a *b* c**` 这种在模型输出里几乎不出现，但**打码的身份证号
  // （3101***********1234）**在中文文档里到处都是——那段星号绝不能被当成强调。
  // 所以规则是：一整串星号/下划线只认 1~3 个，4 个以上原样当文字。
  const upgrade = (segs, n) => {
    for (const s of segs) {
      if (n === 3) s.type = s.type === 'text' ? 'bolditalic' : s.type === 'italic' ? 'bolditalic' : s.type === 'bold' ? 'bolditalic' : s.type;
      else if (n === 2) s.type = s.type === 'text' ? 'bold' : s.type === 'italic' ? 'bolditalic' : s.type;
      else s.type = s.type === 'text' ? 'italic' : s.type === 'bold' ? 'bolditalic' : s.type;
      push(s.type, s.text, s.href);
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // 行内代码：`code`（内部不再解析任何格式）
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        push('code', src.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }

    // 链接 [文字](地址)
    if (ch === '[') {
      const close = src.indexOf('](', i + 1);
      const end = close > 0 ? src.indexOf(')', close + 2) : -1;
      if (close > 0 && end > close + 2) {
        push('link', src.slice(i + 1, close), src.slice(close + 2, end));
        i = end + 1;
        continue;
      }
    }

    // 强调：* / _ ，只认 1~3 个连续的记号
    if (ch === '*' || ch === '_') {
      let n = 0;
      while (src[i + n] === ch) n += 1;
      const mark = ch.repeat(Math.min(n, 3));
      if (n <= 3) {
        // 找配对的同长度记号串，且被包裹的内容不以空白开头/结尾
        let j = i + n;
        let close = -1;
        while (j < src.length) {
          const k = src.indexOf(mark, j);
          if (k < 0) break;
          // 前后不能还连着同样的记号（否则说明这串更长，不该在这里收尾）
          const before = src[k - 1];
          const after = src[k + mark.length];
          const inner = src.slice(i + n, k);
          if (before !== ch && after !== ch && inner && !/^\s|\s$/.test(inner) && !inner.includes('\n\n')) {
            close = k;
            break;
          }
          j = k + 1;
        }
        if (close > 0) {
          upgrade(parseInline(src.slice(i + n, close)), n);
          i = close + n;
          continue;
        }
      }
      plain(ch.repeat(n));
      i += n;
      continue;
    }

    // 普通文字：一次吃到一个可能的记号为止，少切很多刀
    let j = i;
    while (j < src.length && !'`[*_'.includes(src[j])) j += 1;
    if (j === i) {
      plain(src[i]);
      i += 1;
    } else {
      plain(src.slice(i, j));
      i = j;
    }
  }
  return out;
}

/** 行内片段 → 纯文字（导出 TXT、显示在文本框、以及"没有排版要求"时的回退） */
export function inlineToPlain(inline) {
  if (!Array.isArray(inline)) return String(inline ?? '');
  return inline.map((s) => s.text || '').join('');
}

/** 把一行按 Markdown 表格切开，尊重 \| 转义 */
function splitRow(line) {
  const cells = [];
  let cur = '';
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function parseAligns(sepLine, count) {
  const raw = splitRow(sepLine);
  const aligns = [];
  for (let i = 0; i < count; i += 1) {
    const cell = raw[i] || '';
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

function isTableStart(lines, i) {
  if (!lines[i].includes('|')) return false;
  return i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-');
}

/**
 * Markdown → 文档块。
 * @param {string} md
 * @returns {Array<object>}
 */
export function parseMarkdown(md) {
  const text = String(md ?? '').replace(/\r\n?/g, '\n');
  // \f = 强制翻页：多页扫描件"一页对一页"，与 buildTextPDF 的约定一致
  const parts = text.split('\f');
  if (parts.length === 1) return parseBlocks(parts[0]);
  const blocks = [];
  parts.forEach((part, i) => {
    if (i) blocks.push({ type: 'pagebreak' });
    blocks.push(...parseBlocks(part));
  });
  return blocks;
}

/** 单页（或单段）的 Markdown → 文档块 */
function parseBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // ``` 代码块
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const close = fence[1][0].repeat(3);
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^ {0,3}${close === '~~~' ? '~~~' : '```'}`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过收尾的围栏（没有也认了）
      blocks.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') });
      continue;
    }

    // 标题
    const h = HEADING_RE.exec(line);
    if (h) {
      blocks.push({ type: 'heading', level: Math.min(6, h[1].length), inline: parseInline(h[2]) });
      i += 1;
      continue;
    }

    // 分隔线（要放在列表前面判断，否则 "---" 会被当成空列表项）
    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // 表格
    if (isTableStart(lines, i)) {
      const header = splitRow(line).map(parseInline);
      const aligns = parseAligns(lines[i + 1], header.length);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = splitRow(lines[i]);
        // 补齐/截断到表头列数：模型偶尔少数一列，缺的补空，别让表格塌掉
        while (cells.length < header.length) cells.push('');
        rows.push(cells.slice(0, header.length).map(parseInline));
        i += 1;
      }
      blocks.push({ type: 'table', header, rows, aligns, hasHeader: true });
      continue;
    }

    // 列表
    const li = LIST_RE.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (m) {
          const indent = m[1].replace(/\t/g, '  ').length;
          items.push({ level: Math.min(3, Math.floor(indent / 2)), inline: parseInline(m[3]) });
          i += 1;
          continue;
        }
        // 列表项里的续行（缩进且不是新块）并到上一项的尾部
        if (lines[i].trim() && !/^ {0,3}(#|>|```|~~~)/.test(lines[i]) && !HEADING_RE.test(lines[i]) && items.length && /^\s{2,}\S/.test(lines[i])) {
          const extra = lines[i].trim();
          const lastInline = items[items.length - 1].inline;
          const tail = lastInline[lastInline.length - 1];
          if (tail && tail.type === 'text') tail.text += (isWide(tail.text.slice(-1)) && isWide(extra[0]) ? '' : ' ') + extra;
          else lastInline.push({ type: 'text', text: extra });
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // 引用：不单独做块类型（渲染器不一定支持），降级成段落，去掉 > 记号
    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const buf = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push(QUOTE_RE.exec(lines[i])[1]);
        i += 1;
      }
      blocks.push({ type: 'para', inline: parseInline(joinSoft(buf)) });
      continue;
    }

    // 普通段落：连续非空行合并
    const buf = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !HEADING_RE.test(lines[i]) && !HR_RE.test(lines[i]) && !LIST_RE.test(lines[i]) && !FENCE_RE.test(lines[i]) && !QUOTE_RE.test(lines[i]) && !isTableStart(lines, i)) {
      buf.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'para', inline: parseInline(joinSoft(buf)) });
  }

  return blocks;
}

/** 文档块 → 纯文字（一页一份，用于 TXT 导出和"只有文字"的场合） */
export function blocksToPlain(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (b.type === 'pagebreak') out.push('\f');
    else if (b.type === 'heading' || b.type === 'para') out.push(inlineToPlain(b.inline));
    else if (b.type === 'code') out.push(b.text);
    else if (b.type === 'list') out.push(b.items.map((it, idx) => `${b.ordered ? `${idx + 1}.` : '·'} ${inlineToPlain(it.inline)}`).join('\n'));
    else if (b.type === 'table') {
      const all = [b.header, ...b.rows].filter(Boolean);
      out.push(all.map((row) => row.map(inlineToPlain).join(' | ')).join('\n'));
    }
  }
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 这段文字看起来是不是已经带了 Markdown 结构（用来判断要不要走"保排版"那条路） */
export function looksStructured(text) {
  const s = String(text ?? '');
  return /^\s{0,3}#{1,6}\s/m.test(s) || /^\s*\|.*\|\s*$/m.test(s) || /^\s*[-*+]\s+\S/m.test(s) || /\*\*[^*]+\*\*/.test(s);
}
