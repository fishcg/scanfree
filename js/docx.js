/**
 * docx.js —— 零依赖的 .docx 生成器。
 *
 * 背景：项目里已经有 markdown.js（把 AI 返回的 Markdown 解析成"结构化文档块"），
 * 也有 pdf.js / zip.js。但要给用户一份**能继续编辑**的导出，PDF 不够用，
 * 于是需要 Word。引 docx 之类的库要多背几百 KB 依赖，而 .docx 本质就是一个
 * 装着几个 XML 的 zip —— zip 我们已经有了（zip.js，store 模式），
 * 剩下的只是老老实实把 OOXML 拼对。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么这个文件看起来很啰嗦：docx 里有一批"内容上是空的、但少一个 Word
 * 就打不开或显示异常"的部件。它们不是可选项，逐个记在这里：
 *
 *   [Content_Types].xml          按扩展名/部件声明 MIME。少一个 Override，
 *                                Word 会说"文件已损坏"而不是"少了个部件"。
 *   _rels/.rels                  包的入口。**关系类型 officeDocument 必须
 *                                恰好一个**，Word 靠它找 word/document.xml。
 *                                少了它，zip 里就算有 document.xml 也打不开。
 *   word/_rels/document.xml.rels 即使 document.xml 一个 r:id 都没引用，
 *                                这个部件也建议存在（本项目里是空 Relationships）。
 *   word/styles.xml              Normal 与 Heading1..6 都必须真实定义。
 *                                只写 pStyle 而不定义样式，Word 不报错但会
 *                                掉成默认外观；而 Normal 缺失时更糟。
 *   w:sectPr                     正文最后一个元素，定义纸张与页边距。
 *                                没有它 Word 能开但页面尺寸是未定义的。
 *   docProps/core.xml            dc:title / dc:creator 等。可选，但"另存为"
 *                                和文件属性面板都读它，成本极低就一起给了。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一个设计取舍：**关系（relationship）只保留最小集**。
 *   - 列表用真正的 w:numPr + word/numbering.xml（bullet / decimal 各一套
 *     abstractNum），而不是手打 "• " / "1. " 前缀：手打前缀看着简单，
 *     但用户在 Word 里一改缩进、一按 Tab 就散了，而且复制到别处会多出字符。
 *     numbering.xml 的坑主要在 numId ↔ abstractNumId 的对应与 lvl 的
 *     w:ilvl/w:numFmt 必须齐，本文件里是写死的常量，对照着看即可。
 *   - 超链接**不生成** w:hyperlink + rels 关系，只做成蓝色带下划线的 run。
 *     这样 document.xml.rels 可以保持空内容，少一类"关系 id 对不上就整个
 *     文件打不开"的故障。代价是点击不能跳转 —— 对"导出可编辑文档"这个
 *     场景可以接受。
 */

import { buildZip } from './zip.js';

/** 一英寸 = 1440 twips（Word 的长度单位），A4 宽 11906 / 高 16838 */
const PAGE = { w: 11906, h: 16838, margin: 1440 };

/**
 * visible/shared strings 里不允许出现的字符（XML 1.0 的 Char 产生式）：
 * 除了 \t \n \r 之外的所有 C0 控制字符，外加 \uFFFE / \uFFFF 这两个非字符。
 *
 * 为什么必须剥掉而不是转义：这类字符在 XML 里**没有合法的转义写法**，
 * 只要出现在文件里，解析器就直接报错（python-docx 会抛
 * "All strings must be XML compatible"，Word 则报文档损坏）。
 * 而 OCR / AI 返回的文本里偶尔真的会混进 \u0000，所以必须清理。
 */
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

const enc = new TextEncoder();

/** 字符串 → UTF-8 字节（zip.js 要字节数组） */
function utf8(s) {
  return enc.encode(s);
}

/** 剥掉 XML 非法字符。所有外部文本都必须先过这一关。 */
function clean(s) {
  return (
    String(s ?? '')
      .replace(ILLEGAL_XML, '')
      // \r 也要归一化：XML 解析器会把裸 \r 折成空格（end-of-line handling），
      // 于是"回车换行"的文本会被压成一行。markdown.js 从 textarea 读到的
      // 内容正是 \r\n，所以必须在这里统一成 \n，后面才认得出换行。
      .replace(/\r\n?/g, '\n')
  );
}

/**
 * XML 文本节点转义。
 * 顺序很重要：必须先转 `&`，否则 `&amp;` 会被二次转义成 `&amp;amp;`。
 */
function esc(s) {
  return clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** XML 属性值转义（这里用双引号包裹属性，所以顺带把单引号也转掉更保险） */
function escAttr(s) {
  return esc(s).replace(/'/g, '&apos;');
}

/**
 * 拼一个 run（w:r）。
 * @param {string} props run 属性（w:rPr 的内容，可为空字符串）
 * @param {string} text  已经**原样**的文本（内部负责转义与控制字符剥离）
 */
function run(props, text) {
  const rPr = props ? `<w:rPr>${props}</w:rPr>` : '';
  return `<w:r>${rPr}${textNodes(text)}</w:r>`;
}

/**
 * 文本 → w:t / w:br / w:tab 序列。
 *
 * `\n` 为什么不能直接放进 w:t：XML 会把连续空白折叠，换行会变成一个空格，
 * 多行文本就糊成一行了 —— 必须显式转成 `<w:br/>`。
 * 首尾空格同理，靠 `xml:space="preserve"` 保住。
 */
function textNodes(text) {
  const s = clean(text);
  if (s === '') return '';
  const parts = [];
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) parts.push('<w:br/>');
    // 一行内部再按 \t 切开
    const segs = lines[i].split('\t');
    for (let j = 0; j < segs.length; j++) {
      if (j > 0) parts.push('<w:tab/>');
      const seg = segs[j];
      if (seg === '') continue;
      const preserve = /^\s|\s$/.test(seg) ? ' xml:space="preserve"' : '';
      parts.push(`<w:t${preserve}>${esc(seg)}</w:t>`);
    }
  }
  return parts.join('');
}

/** 行内代码的等宽字体：Windows/Mac 都常见的两个，不引任何字体文件 */
const MONO = 'Consolas,Courier New';

/**
 * 行内片段 → run（或 run 序列）。
 *
 * 返回数组是因为：一个 Inline 理论上可能拆成多个 run（目前只有 code + 换行
 * 这种情况会用到），保持数组接口以后扩展不用改调用方。
 */
function inlineRuns(seg) {
  const t = seg.text ?? '';
  switch (seg.type) {
    case 'bold':
      return [run('<w:b/>', t)];
    case 'italic':
      return [run('<w:i/>', t)];
    case 'bolditalic':
      return [run('<w:b/><w:i/>', t)];
    case 'code':
      // 行内代码：缩小到 10.5pt（21 半磅）让等宽字不至于把行撑得太宽
      return [run(`<w:rFonts w:ascii="${MONO}" w:hAnsi="${MONO}"/><w:sz w:val="21"/><w:szCs w:val="21"/>`, t)];
    case 'link':
      // 取舍见文件头：只做视觉样式，不生成真正的关系。
      // href 仍然进不了 document.xml（它没有可放的地方），放弃即可。
      return [run('<w:color w:val="0563C1"/><w:u w:val="single"/>', t)];
    case 'text':
    default:
      return [run('', t)];
  }
}

/** 一段 inline 数组 → run 序列 */
function inlineToRuns(inline) {
  if (!Array.isArray(inline)) return '';
  return inline.map(inlineRuns).join('');
}

/** 段落：<w:p> 包住 runs；runs 为空时给一个自闭合的空段落 */
function para(runs, pPrInner = '') {
  const pPr = pPrInner ? `<w:pPr>${pPrInner}</w:pPr>` : '';
  if (!runs) return `<w:p>${pPr}</w:p>`;
  return `<w:p>${pPr}${runs}</w:p>`;
}

/** 段落属性小工具（顺序按 OOXML schema：pStyle → numPr → spacing → ind → …） */
const pStyle = (id) => `<w:pStyle w:val="${escAttr(id)}"/>`;
const numPr = (numId, ilvl) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
/** 左缩进 + 悬挂缩进：列表续行对齐用（numbering.xml 里也有，这里在样式层再兜一层） */
const indent = (left, hanging) => `<w:ind w:left="${left}"${hanging ? ` w:hanging="${hanging}"` : ''}/>`;

/** 标题：用 Word 内置样式 Heading1..Heading6（样式 id 必须与 styles.xml 里一致） */
function headingBlock(block) {
  const level = Math.min(6, Math.max(1, Number(block.level) || 1));
  return para(inlineToRuns(block.inline), pStyle(`Heading${level}`));
}

/** 普通段落 */
function paraBlock(block) {
  return para(inlineToRuns(block.inline));
}

/**
 * 列表块 → 若干段落。
 *
 * ordered=false 用 numbering.xml 里的 numId=1（bullet），true 用 numId=2（decimal）。
 * items[].level 是 Markdown 的缩进层级（0..3），直接映射到 w:ilvl。
 */
function listBlock(block) {
  const numId = block.ordered ? 2 : 1;
  const items = Array.isArray(block.items) ? block.items : [];
  const out = [];
  for (const it of items) {
    const lvl = Math.min(3, Math.max(0, Number(it?.level) || 0));
    const runs = inlineToRuns(it?.inline);
    const props = pStyle('ListParagraph') + numPr(numId, lvl) + indent(720 * (lvl + 1), 360);
    out.push(para(runs, props));
  }
  return out.join('');
}

/** 表格边框：四边单线（12 = 1.5pt 的八分之一磅，0 = 线宽用默认） */
const TBL_BORDERS =
  '<w:tblBorders>' +
  '<w:top w:val="single" w:sz="8" w:space="0" w:color="808080"/>' +
  '<w:left w:val="single" w:sz="8" w:space="0" w:color="808080"/>' +
  '<w:bottom w:val="single" w:sz="8" w:space="0" w:color="808080"/>' +
  '<w:right w:val="single" w:sz="8" w:space="0" w:color="808080"/>' +
  '<w:insideH w:val="single" w:sz="8" w:space="0" w:color="808080"/>' +
  '<w:insideV w:val="single" w:sz="8" w:space="0" w:color="808080"/>' +
  '</w:tblBorders>';

/** 对齐映射：Markdown 的 left/center/right → OOXML 的 start/center/end */
const JCOF = { left: 'start', center: 'center', right: 'end' };

/** 行内数组 → 纯文字（给表格单元格做长度估算用） */
function plain(inline) {
  // 每种 Inline 都把文字放在 .text 里（bold/code/link 也一样），
  // 所以这里读 s.text 而不是只看 type === 'text'——否则粗体字会整段消失。
  return Array.isArray(inline) ? inline.map((s) => s?.text ?? '').join('') : '';
}

/** 一个表格单元格 <w:tc> */
function cell(inline, width, jc) {
  // 单元格的**文字对齐**写在里面段落的 w:jc 上 —— 这是踩过的坑：
  // w:tcPr 里根本没有 w:jc 这个子元素（它属于 w:pPr），塞进去会被
  // OOXML schema 判非法。python-docx 读的时候不报错，但严格的校验器
  // 会拒绝，所以老实用段落对齐。
  const jcXml = jc ? `<w:jc w:val="${jc}"/>` : '';
  return (
    '<w:tc>' +
    `<w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>` +
    para(inlineToRuns(inline), jcXml) +
    '</w:tc>'
  );
}

/** 一行表格 <w:tr>；header=true 时加 w:tblHeader 让标题行跨页重复 */
function row(cells, widths, header) {
  // trPr 子元素顺序按 schema：cantSplit 在 tblHeader 之前，写反了 Word 会挑刺
  const trPr = header
    ? '<w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>'
    : '<w:trPr><w:cantSplit/></w:trPr>';
  return `<w:tr>${trPr}${cells.join('')}</w:tr>`;
}

/**
 * 表格块 → 真正的 Word 表格（w:tbl / w:tblPr / w:tblGrid / w:tr / w:tc）。
 *
 * 列宽估算：docx 里必须显式给列宽（tblGrid + 每个 tcW），否则不同阅读器
 * 会各自猜一套，最容易出现"在 Word 里好好的、在 WPS 里串列"。
 * 这里没有字体度量数据（不像 pdf.js 有 Helvetica 宽度表），所以用一个
 * 粗略规则：中文按 2 个宽度单位、ASCII 按 1 个算，再夹在合理区间里。
 * 它不追求精确排版，只求列宽比例大致合理且总和等于可用正文宽度。
 */
function tableBlock(block) {
  const header = Array.isArray(block.header) && block.header.length ? block.header : null;
  const rows = Array.isArray(block.rows) ? block.rows : [];

  // 列数取"表头、第一行、aligns"三者的最大值，防止 AI 少给一列就串列
  const firstRow = rows.find((r) => Array.isArray(r) && r.length) || [];
  const cols = Math.max(header ? header.length : 0, firstRow.length, Array.isArray(block.aligns) ? block.aligns.length : 0, 1);

  const usable = PAGE.w - PAGE.margin * 2;
  const gutter = 108; // 每列留一点内边距

  // 1) 估算每列的相对宽度
  const weights = [];
  for (let c = 0; c < cols; c++) {
    let w = 4;
    const probe = header?.[c] ?? firstRow[c];
    if (probe) {
      let units = 0;
      for (const ch of plain(probe)) {
        // 把长内容按 ~20 个宽度单位截断，避免某一列独占整张表
        if (units >= 20) break;
        units += ch.codePointAt(0) > 0xff ? 2 : 1;
      }
      w = Math.max(4, Math.min(20, units));
    }
    weights.push(w);
  }
  const total = weights.reduce((a, b) => a + b, 0);

  // 2) 归一化成 twips，并保证每列至少放得下一个字
  const widths = [];
  let used = 0;
  for (let c = 0; c < cols; c++) {
    const v = c === cols - 1 ? usable - used : Math.max(gutter + 200, Math.round((usable * weights[c]) / total));
    const w = Math.max(gutter + 200, v);
    widths.push(w);
    used += w;
  }

  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  // tblPr 子元素顺序按 schema：tblW → tblBorders → tblLayout。
  // 这个顺序不是"随便写也行"的：严格校验器会因为 tblLayout 排在 tblBorders
  // 前面而判文档非法（Word 有时只是静默忽略，更难查）。
  const tblPr = `<w:tblPr><w:tblW w:w="${usable}" w:type="dxa"/>${TBL_BORDERS}<w:tblLayout w:type="fixed"/></w:tblPr>`;

  const out = [];
  if (header) {
    // hasHeader === false 时不要 w:tblHeader（调用方明确说了首行不算表头）
    const useHeader = block.hasHeader !== false;
    out.push(row(header.map((cl, i) => cell(cl, widths[i], JCOF[block.aligns?.[i]] || null)), widths, useHeader));
  }
  for (const r of rows) {
    const cells = [];
    for (let c = 0; c < cols; c++) {
      cells.push(cell(Array.isArray(r?.[c]) ? r[c] : [], widths[c], JCOF[block.aligns?.[c]] || null));
    }
    out.push(row(cells, widths, false));
  }

  // 没有任何行时给一个空行，否则 w:tbl 无 w:tr，是非法表格
  if (!out.length) out.push(row(widths.map((w) => cell([], w, null)), widths, false));

  return `<w:tbl>${tblPr}<w:tblGrid>${grid}</w:tblGrid>${out.join('')}</w:tbl>`;
}

/**
 * 代码块。
 *
 * 为什么不用 w:pStyle val="HTMLPreformatted" 之类的内置样式：
 * 那类样式在很多精简版 Word / WPS 里并不存在（内置样式也要 styles.xml 里
 * 有定义才会生效），所以直接内联属性 + 底纹最稳。
 * `w:shd` 的 fill 是浅灰底，`w:rFonts` 换成等宽，缩进 200 twips 让代码
 * 与正文有区分。多行靠 textNodes 里的 <w:br/> 保留。
 */
function codeBlock(block) {
  // pPr 子元素顺序按 schema：pBdr → shd → spacing → ind（shd 必须排在 spacing 前）
  const pPr =
    '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' +
    '<w:spacing w:before="120" w:after="120" w:line="240" w:lineRule="auto"/>' +
    '<w:ind w:left="200" w:right="200"/>';
  const rPr =
    `<w:rFonts w:ascii="${MONO}" w:hAnsi="${MONO}" w:cs="${MONO}"/><w:sz w:val="20"/><w:szCs w:val="20"/>`;
  return para(run(rPr, block.text ?? ''), pPr);
}

/**
 * 水平分隔线。
 *
 * 为什么不画 w:pBdr 之外的图形：docx 里没有"独立横线"元素，业界通用做法
 * 就是一个空段落加段落下边框（Word 自己的"插入水平线"也是这么存的）。
 * 高度为 0 的空段落 + 6 号单线，视觉上就是一条细分隔线。
 */
function hrBlock() {
  return (
    '<w:p><w:pPr>' +
    '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="A0A0A0"/></w:pBdr>' +
    '<w:spacing w:before="120" w:after="120" w:line="240" w:lineRule="auto"/>' +
    '</w:pPr></w:p>'
  );
}

/** 未知块类型 → 有 inline 就当段落渲染，否则整块丢掉（宁可少内容也别生成坏 XML） */
function fallbackBlock(block) {
  if (Array.isArray(block?.inline)) return paraBlock(block);
  if (typeof block?.text === 'string') return paraBlock({ inline: [{ type: 'text', text: block.text }] });
  return '';
}

/** 单个块 → document.xml 的正文片段 */
function renderBlock(block) {
  switch (block?.type) {
    case 'heading':
      return headingBlock(block);
    case 'para':
      return paraBlock(block);
    case 'list':
      return listBlock(block);
    case 'table':
      return tableBlock(block);
    case 'code':
      return codeBlock(block);
    case 'hr':
      return hrBlock();
    default:
      return fallbackBlock(block);
  }
}

/**
 * 把"结构化文档块"渲染成 .docx 字节。
 *
 * @param {Array<object>} blocks 块数组，格式见文件头注释（markdown.js 的 parseMarkdown 输出）
 * @param {{title?: string, author?: string, subject?: string,
 *          fontZh?: string, fontEn?: string, fontSizePt?: number}} [opts]
 * @returns {Promise<Uint8Array>} 完整的 .docx 字节（因为内部 await buildZip，所以是 async）
 */
export async function buildDOCX(blocks, opts = {}) {
  const title = opts.title ? clean(opts.title) : '扫描文档';
  const author = opts.author ? clean(opts.author) : '全民扫描 ScanFree';
  const subject = opts.subject ? clean(opts.subject) : '';
  const fontZh = opts.fontZh ? clean(opts.fontZh) : '宋体';
  const fontEn = opts.fontEn ? clean(opts.fontEn) : 'Calibri';
  const szHalf = Math.max(2, Math.round((Number(opts.fontSizePt) || 11) * 2)); // 磅 → 半磅
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); // ISO8601 带 Z

  const list = Array.isArray(blocks) ? blocks : [];

  // ── word/document.xml ────────────────────────────────────────────────
  // w:sectPr 必须是 w:body 的最后一个子元素，顺序错了 Word 直接判损坏
  const body = list.map(renderBlock).join('');
  const sectPr =
    '<w:sectPr>' +
    `<w:pgSz w:w="${PAGE.w}" w:h="${PAGE.h}"/>` +
    `<w:pgMar w:top="${PAGE.margin}" w:right="${PAGE.margin}" w:bottom="${PAGE.margin}" w:left="${PAGE.margin}"` +
    ' w:header="720" w:footer="720" w:gutter="0"/>' +
    '</w:sectPr>';

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body}${sectPr}</w:body>` +
    '</w:document>';

  // ── word/styles.xml ──────────────────────────────────────────────────
  // w:docDefaults 管住"N 处没写字体"的情况：西文走 fontEn，东亚走 fontZh。
  // w:hint="eastAsia" 很关键 —— 它告诉 Word 遇到"中日韩字符"时优先用 eastAsia
  // 那一支字体，否则中文会去套 Calibri，再靠 fallback 乱猜，很容易出方框。
  const rFonts = `<w:rFonts w:ascii="${escAttr(fontEn)}" w:hAnsi="${escAttr(fontEn)}" w:eastAsia="${escAttr(
    fontZh
  )}" w:cs="${escAttr(fontEn)}" w:hint="eastAsia"/>`;

  const headingSizes = [32, 28, 26, 24, 22, 22]; // Heading1..6 的半磅字号
  const headings = headingSizes
    .map((sz, i) => {
      const n = i + 1;
      return (
        `<w:style w:type="paragraph" w:styleId="Heading${n}">` +
        `<w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
        '<w:pPr>' +
        `<w:keepNext/><w:keepLines/><w:spacing w:before="${n === 1 ? 240 : 200}" w:after="80"/>` +
        `<w:outlineLvl w:val="${i}"/>` +
        '</w:pPr>' +
        `<w:rPr>${rFonts}<w:b/><w:color w:val="1F3864"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>` +
        '</w:style>'
      );
    })
    .join('');

  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    // docDefaults 里的 rPr 顺序必须遵循 schema：rFonts → … → sz → szCs
    `<w:docDefaults><w:rPrDefault><w:rPr>${rFonts}<w:sz w:val="${szHalf}"/><w:szCs w:val="${szHalf}"/></w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    // Normal 是所有段落的最终回退样式，**必须**存在
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    headings +
    // 列表段落样式。注意只放"列表通用的东西"（缩进），
    // numPr 放在段落上（因为有序/无序、层级都不同），见 listBlock()
    '<w:style w:type="paragraph" w:styleId="ListParagraph">' +
    '<w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:spacing w:before="0" w:after="40" w:line="276" w:lineRule="auto"/></w:pPr>' +
    '</w:style>' +
    '</w:styles>';

  // ── word/numbering.xml ───────────────────────────────────────────────
  // numId 是文档里引用的编号，abstractNumId 是格式定义，两者用 w:abstractNumId 关联。
  // 这里刻意让 numId 与 abstractNumId 都取 0/1 之外的值并显式对应，
  // 避免"改了 abstractNum 顺序但忘了改 num 映射"这类低级错误。
  // w:lvl 的子元素顺序同样由 schema 规定：start → numFmt → lvlText → **lvlJc → pPr**。
  // 注意 lvlJc 在 pPr **前面**（pPr 反而是倒数第二个），这条是从
  // ISO/IEC 29500-4 的 wml.xsd（CT_Lvl）里核对过的，别凭直觉改。
  const lvlCommon = (ilvl, fmt, text) =>
    `<w:lvl w:ilvl="${ilvl}">` +
    '<w:start w:val="1"/>' +
    `<w:numFmt w:val="${fmt}"/>` +
    // %1 是占位符：bullet 用符号，decimal 用阿拉伯数字
    `<w:lvlText w:val="${text}"/>` +
    '<w:lvlJc w:val="left"/>' +
    `<w:pPr><w:ind w:left="${720 * (ilvl + 1)}" w:hanging="360"/></w:pPr>` +
    '</w:lvl>';

  const lvls = (fmt, text) => [0, 1, 2, 3].map((i) => lvlCommon(i, fmt, text)).join('');

  const numberingXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="10">' +
    // 注意顺序：CT_AbstractNum 规定 nsid 在 multiLevelType **之前**，
    // 写成 multiLevelType 在前会让严格校验器（也可能会让 Word）拒收整个部件。
    '<w:nsid w:val="1A2B3C01"/><w:multiLevelType w:val="multilevel"/><w:tmpl w:val="1A2B3C01"/>' +
    // 项目符号：三级用不同符号只是为了层级好认，• ◦ ▪ 是 Word 默认那套
    lvlCommon(0, 'bullet', '\u2022') +
    lvlCommon(1, 'bullet', '\u25E6') +
    lvlCommon(2, 'bullet', '\u25AA') +
    lvlCommon(3, 'bullet', '\u2022') +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="20">' +
    '<w:nsid w:val="1A2B3C02"/><w:multiLevelType w:val="multilevel"/><w:tmpl w:val="1A2B3C02"/>' +
    // 有序列表：全部用 decimal（Word 默认会在第 3 层换成小写字母，
    // 但 Markdown 的有序列表语义就是数字，保持十进制更符合用户预期）
    lvls('decimal', '%1.') +
    '</w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="20"/></w:num>' +
    '</w:numbering>';

  // ── [Content_Types].xml ──────────────────────────────────────────────
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>';

  // ── _rels/.rels ──────────────────────────────────────────────────────
  // officeDocument 关系**必须恰好一个**，Word 就是靠它定位主文档的
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>';

  // ── word/_rels/document.xml.rels ─────────────────────────────────────
  // 正文里没有一个 r:id（超链接被降级成普通 run），所以这里是空 Relationships。
  // 但**文件本身要存在**：部分阅读器（和 python-docx 的一些版本）会无条件
  // 去解析它，缺失时报的是"部件找不到"这种很难懂的错。
  const docRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    '</Relationships>';

  // ── docProps/core.xml ────────────────────────────────────────────────
  // dcterms 的日期类型必须声明 xsi:type，否则 Word 可能把它当普通字符串
  const coreXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
    ' xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:dcmitype="http://purl.org/dc/dcmitype/"' +
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(title)}</dc:title>` +
    `<dc:creator>${esc(author)}</dc:creator>` +
    `<cp:lastModifiedBy>${esc(author)}</cp:lastModifiedBy>` +
    (subject ? `<dc:subject>${esc(subject)}</dc:subject>` : '') +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>` +
    '</cp:coreProperties>';

  // 顺序无所谓（zip 中央目录才是权威），但按 OPC 惯例排一下，方便人肉 unzip 查看
  return buildZip([
    { name: '[Content_Types].xml', data: utf8(contentTypes) },
    { name: '_rels/.rels', data: utf8(rootRels) },
    { name: 'word/document.xml', data: utf8(documentXml) },
    { name: 'word/styles.xml', data: utf8(stylesXml) },
    { name: 'word/numbering.xml', data: utf8(numberingXml) },
    { name: 'word/_rels/document.xml.rels', data: utf8(docRels) },
    { name: 'docProps/core.xml', data: utf8(coreXml) },
  ]);
}

/**
 * 文档块 → 纯文字（不导出，但留着给"要不要导 docx"的预览/日志用，
 * 也顺便让"块格式"有一个不依赖 XML 的自检入口）。
 */
export function blocksToPlain(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  return list
    .map((b) => {
      if (b?.type === 'table') {
        const h = Array.isArray(b.header) ? b.header.map(plain).join('\t') : '';
        const rows = (b.rows || []).map((r) => r.map(plain).join('\t'));
        return [h, ...rows].filter(Boolean).join('\n');
      }
      if (b?.type === 'list') return (b.items || []).map((it) => plain(it?.inline)).join('\n');
      if (b?.type === 'hr') return '---';
      if (typeof b?.text === 'string' && b.type === 'code') return b.text;
      return plain(b?.inline);
    })
    .join('\n');
}
