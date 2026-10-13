/**
 * DOCX 生成器测试。
 *
 * 和其它导出器（pdf.test.mjs / zip.test.mjs）同样的思路：结构断言只是下限，
 * 真正的裁判是**第三方实现**。这里请了三个：
 *
 *   1. 系统 `unzip -t`      —— 校验 zip 结构与每个条目的 CRC；
 *   2. python3 + python-docx —— 一个完全独立的 OOXML 实现，会真正解析
 *      样式表、编号表和表格网格，任何结构错误（哪怕只是一个标签顺序不对）
 *      都会在这里抛出来；
 *   3. macOS 自带 `textutil` —— 走的是系统的 Word 解析栈（不是我们的代码），
 *      把 docx 转成纯文本，验证文字真的能"读回来"。
 *
 * 三者缺任何一个就 skip 对应用例，测试本身不会因此变红。
 *
 * 运行：node --test tests/docx.test.mjs
 * （注意必须给文件路径：node --test tests/ 传目录会被 node 当成模块入口而报错）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDOCX, blocksToPlain } from '../js/docx.js';

/** 本项目专用的 python3（装了 python-docx 1.2.0）；找不到就退回系统 python3 */
const PY_CANDIDATES = [
  '/Users/fish/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3',
  'python3',
  '/usr/bin/python3',
];

/** 找一个"存在且真的装了 python-docx"的解释器，返回路径或 null */
const findPython = () => {
  for (const py of PY_CANDIDATES) {
    try {
      execFileSync(py, ['-c', 'import docx'], { stdio: 'ignore' });
      return py;
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
};

const hasUnzip = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const hasTextutil = (() => {
  try {
    execFileSync('textutil', ['-help'], { stdio: 'ignore' });
    return true;
  } catch {
    // textutil -help 在不带参数时可能以非 0 退出，用 which 兜一层
    try {
      execFileSync('/usr/bin/textutil', ['-help'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
})();

const bytesOf = (u8) => Buffer.from(u8);

/** 把 docx 写成临时文件，交给外部工具处理，结束后清理干净 */
function withDocx(bytes, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'scanfree-docx-'));
  try {
    const file = join(dir, 'out.docx');
    writeFileSync(file, bytes);
    return fn(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 从 zip 字节里直接取出某个条目的文本（store 模式，中央目录是权威） */
function entryText(bytes, name) {
  const b = bytesOf(bytes);
  const eocd = b.length - 22;
  assert.equal(b.readUInt32LE(eocd), 0x06054b50, '应以中央目录结束记录收尾');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    assert.equal(b.readUInt32LE(p), 0x02014b50, '偏移处应是中央目录头');
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const size = b.readUInt32LE(p + 24);
    const localOffset = b.readUInt32LE(p + 42);
    const entryName = b.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (entryName === name) {
      // 本地头的 extra 长度可能与中央目录不同，必须按本地头重新算数据起点
      const localNameLen = b.readUInt16LE(localOffset + 26);
      const localExtraLen = b.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      return b.subarray(start, start + size).toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip 里没有 ${name}`);
}

/**
 * OOXML 属性容器的**子元素顺序表**（摘自 ECMA-376 的 CT_* 定义）。
 *
 * 为什么值得专门写一个测试：这些容器的内容是"序列（sequence）"而不是
 * "全选（all）"，也就是说 <w:tblPr><w:tblLayout/><w:tblBorders/></w:tblPr>
 * 在规范上是**非法**的。而 Word 对这个的处理很讨厌 —— 有时它只是静默忽略
 * 你写错位置的那个属性（于是边框莫名消失），有时直接报"文档已损坏"，
 * 从现象上完全看不出是顺序问题。python-docx 则基本不校验顺序，
 * 所以只有把顺序表抄下来自查，才能挡住这类错误。
 *
 * 每个 <w:xxxPr> 块单独取子元素名（因为父块自己的名字也匹配 /<w:\w+>/）。
 */
const PROP_ORDER = {
  pPr: ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'],
  rPr: ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath'],
  tblPr: ['tblStyle', 'tblpPr', 'tblOverlap', 'bidiVisual', 'tblStyleRowBandSize', 'tblStyleColBandSize', 'tblW', 'jc', 'tblCellSpacing', 'tblInd', 'tblBorders', 'shd', 'tblLayout', 'tblCellMar', 'tblLook', 'tblCaption', 'tblDescription', 'tblPrChange'],
  trPr: ['cnfStyle', 'divId', 'gridBefore', 'gridAfter', 'wBefore', 'wAfter', 'cantSplit', 'trHeight', 'tblHeader', 'tblCellSpacing', 'jc', 'hidden', 'ins', 'del', 'trPrChange'],
  tcPr: ['cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge', 'tcBorders', 'shd', 'noWrap', 'tcMar', 'textDirection', 'tcFitText', 'vAlign', 'hideMark', 'headers'],
  sectPr: ['footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders', 'lnNumType', 'pgNumType', 'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter', 'docGrid', 'printerSettings'],
  lvl: ['start', 'numFmt', 'lvlRestart', 'pStyle', 'isLgl', 'suff', 'lvlText', 'lvlPicBulletId', 'legacy', 'lvlJc', 'pPr', 'rPr'],
  abstractNum: ['nsid', 'multiLevelType', 'tmpl', 'name', 'styleLink', 'numStyleLink', 'lvl'],
  num: ['abstractNumId', 'lvlOverride'],
};
/**
 * 取出一个属性容器的**直接**子元素名。
 *
 * 为什么不直接用正则切：<w:pPr><w:numPr><w:ilvl/><w:numId/></w:numPr></w:pPr>
 * 里 ilvl/numId 是"孙元素"，不属于 pPr 的顺序表。用一个深度计数器走一遍
 * 才能准确区分（非贪婪正则会漏切，贪婪正则会多切）。
 */
function directChildren(inner) {
  const names = [];
  const re = /<(\/?)([A-Za-z:]+)((?:"[^"]*"|[^>])*?)(\/?)>/g;
  let depth = 0;
  let m;
  while ((m = re.exec(inner))) {
    const [, closing, tag, , selfClose] = m;
    if (closing) {
      depth -= 1;
      continue;
    }
    if (depth === 0) names.push(tag.replace(/^w:/, ''));
    if (!selfClose) depth += 1;
  }
  return names;
}

/** 找出 XML 里所有顺序不对（或含非法子元素）的属性块 */
function orderViolations(xml) {
  const out = [];
  for (const [tag, order] of Object.entries(PROP_ORDER)) {
    const re = new RegExp(`<w:${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</w:${tag}>`, 'g');
    for (const m of xml.matchAll(re)) {
      const names = directChildren(m[1]);
      const unknown = names.filter((n) => !order.includes(n));
      if (unknown.length) out.push(`<w:${tag}> 含非法子元素 ${unknown.join(',')}`);
      const idx = names.map((n) => order.indexOf(n)).filter((i) => i >= 0);
      const sorted = [...idx].sort((a, b) => a - b);
      if (idx.join() !== sorted.join()) {
        out.push(`<w:${tag}> 子元素顺序错误：${names.join(' → ')}`);
      }
    }
  }
  return [...new Set(out)];
}

const SAMPLE = () => [
  { type: 'heading', level: 1, inline: [{ type: 'text', text: '体检报告 2026' }] },
  {
    type: 'para',
    inline: [
      { type: 'text', text: '姓名：张三 & 李四 <测试> ' },
      { type: 'bold', text: '加粗' },
      { type: 'text', text: '、' },
      { type: 'italic', text: '斜体' },
      { type: 'text', text: '、' },
      { type: 'bolditalic', text: '又粗又斜' },
      { type: 'text', text: '、' },
      { type: 'code', text: 'const a = 1;' },
      { type: 'text', text: ' 参见 ' },
      { type: 'link', text: '官网', href: 'https://example.com' },
    ],
  },
  { type: 'heading', level: 2, inline: [{ type: 'text', text: '检查项目' }] },
  {
    type: 'list',
    ordered: false,
    items: [
      { level: 0, inline: [{ type: 'text', text: '血常规' }] },
      { level: 1, inline: [{ type: 'text', text: '白细胞计数' }] },
    ],
  },
  {
    type: 'list',
    ordered: true,
    items: [
      { level: 0, inline: [{ type: 'text', text: '第一项' }] },
      { level: 0, inline: [{ type: 'text', text: '第二项' }] },
    ],
  },
  { type: 'hr' },
  {
    type: 'table',
    header: [
      [{ type: 'text', text: '项目' }],
      [{ type: 'text', text: '结果' }],
      [{ type: 'text', text: '单位' }],
    ],
    aligns: ['left', 'center', 'right'],
    hasHeader: true,
    rows: [
      [
        [{ type: 'text', text: '白细胞' }],
        [{ type: 'text', text: '6.2' }],
        [{ type: 'text', text: '10^9/L' }],
      ],
      [
        [{ type: 'text', text: '血红蛋白' }],
        [{ type: 'bold', text: '155' }],
        [{ type: 'text', text: 'g/L' }],
      ],
    ],
  },
  { type: 'code', text: 'function hi() {\n  return "你好";\n}', lang: 'js' },
];

test('生成的字节是合法 zip：unzip -t 校验 CRC，条目名齐全（无 unzip 时跳过）', async (t) => {
  if (!hasUnzip) {
    t.skip('本机没有 unzip');
    return;
  }
  const bytes = await buildDOCX(SAMPLE(), { title: '体检报告' });

  withDocx(bytes, (file) => {
    // -t 会逐个条目重算 CRC，任何一位错误都会以非 0 退出
    const out = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
    assert.match(out, /No errors detected/, 'unzip 应报告所有条目 CRC 正确');

    const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((s) => s.trim());
    for (const need of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'word/_rels/document.xml.rels',
      'docProps/core.xml',
      'word/numbering.xml',
    ]) {
      assert.ok(names.includes(need), `zip 里应包含 ${need}（实际：${names.join(', ')}）`);
    }
  });
});

test('python-docx（真正的第三方解析器）能打开并读回结构', async (t) => {
  const py = findPython();
  if (!py) {
    t.skip('本机没有可用的 python3 + python-docx');
    return;
  }
  const bytes = await buildDOCX(SAMPLE(), { title: '体检报告 2026', author: '全民扫描' });

  // 内联脚本：只打印我们需要断言的几行，避免依赖 python 侧的断言风格
  const script = [
    'import sys, docx',
    'd = docx.Document(sys.argv[1])',
    'ps = [p for p in d.paragraphs if p.text.strip()]',
    'print("STYLES:" + "|".join(p.style.name for p in ps))',
    'print("HEADS:" + "|".join(p.text for p in ps if p.style.name.startswith("Heading")))',
    'print("FIRST:" + (ps[0].text if ps else ""))',
    'para = [p for p in ps if p.text.startswith("姓名")][0]',
    'print("PARA:" + para.text)',
    'print("BOLD:" + "|".join(r.text for r in para.runs if r.bold))',
    'print("ITALIC:" + "|".join(r.text for r in para.runs if r.italic))',
    'print("BOLDITALIC:" + "|".join(r.text for r in para.runs if r.bold and r.italic))',
    'print("MONO:" + "|".join(r.text for r in para.runs if (r.font.name or "").startswith("Consolas")))',
    'print("LINKISH:" + "|".join(r.text for r in para.runs if r.underline))',
    'print("TABLES:%d" % len(d.tables))',
    't0 = d.tables[0]',
    'print("DIMS:%d,%d" % (len(t0.rows), len(t0.columns)))',
    'print("CELLS:" + "|".join(c.text for r in t0.rows for c in r.cells))',
    'print("HDR:" + str(t0.rows[0]._tr.trPr is not None and t0.rows[0]._tr.trPr.find(docx.oxml.ns.qn("w:tblHeader")) is not None))',
    'print("TITLE:" + str(d.core_properties.title))',
    'print("AUTHOR:" + str(d.core_properties.author))',
    'print("CREATED:" + ("NONE" if d.core_properties.created is None else "OK"))',
  ].join('\n');

  withDocx(bytes, (file) => {
    const lines = execFileSync(py, ['-c', script, file], { encoding: 'utf8' }).trim().split('\n');
    const get = (k) => {
      const line = lines.find((l) => l.startsWith(k + ':'));
      assert.ok(line, `python 没有输出 ${k}，实际输出：\n${lines.join('\n')}`);
      return line.slice(k.length + 1);
    };

    // 标题段落到的是 Word 内置样式（不是 "Normal"）
    assert.equal(get('FIRST'), '体检报告 2026');
    assert.ok(get('STYLES').startsWith('Heading 1|'), `首个样式应是 Heading 1，实际 ${get('STYLES')}`);
    assert.equal(get('HEADS'), '体检报告 2026|检查项目', '两级标题都应拿到 Heading 样式');

    // 行内格式
    assert.match(get('PARA'), /姓名：张三 & 李四 <测试>/, '转义后的特殊字符应原样读回');
    assert.match(get('BOLD'), /加粗/, '加粗 run 应被解析为 bold');
    assert.match(get('ITALIC'), /斜体/, '斜体 run 应被解析为 italic');
    assert.match(get('BOLDITALIC'), /又粗又斜/, '又粗又斜应是同一个 run 同时 bold+italic');
    assert.match(get('MONO'), /const a = 1;/, '行内代码应用等宽字体');
    assert.match(get('LINKISH'), /官网/, '链接样式应带下划线');

    // 表格：3 列 2 数据行 + 1 表头行 = 3 行；表头要能跨页重复
    assert.equal(get('TABLES'), '1');
    assert.equal(get('DIMS'), '3,3', '表格应是 3 行 3 列');
    assert.equal(get('CELLS'), '项目|结果|单位|白细胞|6.2|10^9/L|血红蛋白|155|g/L');
    assert.equal(get('HDR'), 'True', '表头行应带 w:tblHeader');

    // core.xml
    assert.equal(get('TITLE'), '体检报告 2026');
    assert.equal(get('AUTHOR'), '全民扫描');
    assert.equal(get('CREATED'), 'OK', 'dcterms:created 应是 python-docx 认得的日期');
  });
});

test('XML 转义：& < > 变成实体，中文按 UTF-8 原样存在', async () => {
  const bytes = await buildDOCX([
    { type: 'para', inline: [{ type: 'text', text: 'A & B <tag> "引号" 中文' }] },
  ]);
  const xml = entryText(bytes, 'word/document.xml');

  assert.ok(xml.includes('A &amp; B &lt;tag&gt; &quot;引号&quot; 中文'), `转义结果不对：${xml.slice(0, 400)}`);
  assert.ok(!xml.includes('<tag>'), '不应把裸 < > 写进 XML');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(xml), '不应出现未转义的裸 &');

  // 中文必须是 UTF-8 字节，而不是 latin1 / 实体
  const raw = bytes;
  assert.ok(Buffer.from(raw).includes(Buffer.from('中文', 'utf8')), 'document.xml 里应有 UTF-8 编码的中文');
  assert.ok(xml.includes('<w:t'), '文字应放在 w:t 里');
  assert.ok(!/[\uD800-\uDFFF]/.test(xml), '不该出现落单的代理对');
});

test('非法控制字符被剥掉（\u0000 \u001F 之类进不了 XML）', async () => {
  const bytes = await buildDOCX([
    { type: 'para', inline: [{ type: 'text', text: 'a\u0000b\u001Fc' }] },
    { type: 'para', inline: [{ type: 'text', text: 'x\u0007\u000B\u000C\u000Ey' }] },
    { type: 'heading', level: 2, inline: [{ type: 'text', text: '标题\u0001' }] },
    { type: 'code', text: 'code\u0000line' },
  ]);
  const xml = entryText(bytes, 'word/document.xml');

  // XML 1.0 的 Char 产生式：\t \n \r 之外的控制字符一律非法
  const bad = xml.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g);
  assert.equal(bad, null, `document.xml 里仍有非法控制字符：${JSON.stringify(bad)}`);
  assert.ok(xml.includes('abc'), '剥掉控制字符后剩下的文字应保留');
  assert.ok(xml.includes('>xy<'), '被剥掉的控制字符两侧的可见字符都不该丢');

  // 注意：不能对整个 zip 字节做 "不含 0x00" 的断言 ——
  // ZIP 头部里的 32 位长度/偏移字段在高位为 0 时天然就是 0x00 字节，
  // 那是格式本身的一部分，不代表内容脏。真正要保证的是**解出来的 XML**干净，
  // 上面那条正则已经覆盖；这里再确认三个含用户文本的部件都干净。
  for (const name of ['word/document.xml', 'word/styles.xml', 'docProps/core.xml']) {
    const part = entryText(bytes, name);
    assert.equal(part.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g), null, `${name} 里不应有非法控制字符`);
  }
});

test('空块数组也能生成一个 Word 打得开的空文档（不抛异常）', async () => {
  const bytes = await buildDOCX([]);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length > 500, '再空的 docx 也要带齐部件，不可能只有几字节');

  const xml = entryText(bytes, 'word/document.xml');
  assert.match(xml, /<w:body>/, '应有正文');
  assert.match(xml, /<w:sectPr>/, '空文档也必须带节属性，否则页面尺寸未定义');
  assert.equal(/<w:p[ >]/.test(xml), false, '空文档不应凭空造出段落');

  if (hasUnzip) {
    withDocx(bytes, (file) => {
      assert.match(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }), /No errors detected/);
    });
  }
  // 缺块的调用也不该炸
  await assert.doesNotReject(buildDOCX(undefined));
});

test('段落/标题/单元格里的 \\n 是硬换行，必须变成 <w:br/> 而不是被折叠掉', async () => {
  // markdown.js 保留了段落内的换行（扫描件里一行往往是一条独立信息），
  // 如果这里不转成 <w:br/>，Word 会把"出租方…/承租方…"挤成一条读不通的长句。
  const bytes = await buildDOCX([
    { type: 'heading', level: 2, inline: [{ type: 'text', text: '甲\n乙' }] },
    { type: 'para', inline: [{ type: 'text', text: '出租方（甲方）：张明\n承租方（乙方）：李华' }] },
    // 加粗/斜体/行内代码同样要换行（它们和 text 走的是同一套文本输出）
    { type: 'para', inline: [{ type: 'bold', text: '粗一\n粗二' }, { type: 'italic', text: '斜\n二' }, { type: 'code', text: 'a\nb' }] },
    { type: 'table', header: null, rows: [[[{ type: 'text', text: '格一\n格二' }]]], aligns: [null], hasHeader: false },
  ]);
  const xml = entryText(bytes, 'word/document.xml');

  // 关键：换行符本身绝不能出现在 document.xml 的文本节点里
  assert.ok(!/<w:t[^>]*>[^<]*\n/.test(xml), 'w:t 里不该有字面换行符（OOXML 里它不是换行）');
  assert.ok(!/<w:t[^>]*>[^<]*\r/.test(xml), 'w:t 里不该有回车符');

  // 这段两行文字 + 后面那段里"加粗"也带一个换行，所以正文里共 2 个 <w:br/>
  const para = xml.match(/<w:body>[\s\S]*?出租方[\s\S]*?<\/w:p>/);
  assert.ok(para, '应能找到那段两行文字');
  assert.equal((para[0].match(/<w:br\/>/g) || []).length, 2, '正文段里应有 2 个 w:br（正文那处 + 加粗那处）');
  assert.match(para[0], /出租方（甲方）：张明<\/w:t><w:br\/><w:t>承租方（乙方）：李华/);

  // 标题：换行也在，且段落仍是 Heading2
  const head = xml.match(/<w:p><w:pPr><w:pStyle w:val="Heading2"\/>[\s\S]*?<\/w:p>/);
  assert.ok(head, '找不到 Heading2 段落');
  assert.ok(head[0].includes('<w:br/>'), '标题里的换行同样要变 w:br');

  // 表格单元格里也有 w:br（不能只在正文里处理）
  const cell = xml.match(/<w:tc>[\s\S]*?<\/w:tc>/);
  assert.ok(cell && cell[0].includes('<w:br/>'), '单元格里的换行也要变 w:br');
});

test('CRLF（textarea 来的 \\r\\n）等价于 LF，不会被压成一行', async () => {
  // 裸 \r 在 XML 里会被解析器折成空格，所以必须先归一化再切行
  const bytes = await buildDOCX([{ type: 'para', inline: [{ type: 'text', text: '一\r\n二\r三' }] }]);
  const xml = entryText(bytes, 'word/document.xml');
  assert.ok(!xml.includes('\r'), '输出里不该残留 \r');
  const body = xml.match(/<w:body>[\s\S]*?<w:sectPr/)[0];
  assert.equal((body.match(/<w:br\/>/g) || []).length, 2, '\r\n 和单独的 \r 都算换行');
});

test('python-docx 逐 run 拆出来看：软换行真的落在 <w:br/> 上（无 python3 时跳过）', async (t) => {
  // 独立验证：不数标签，而是让第三方解析器把每个 run 的子元素列出来。
  // w:br 必须是独立的子元素——如果谁偷懒把 \\n 写进 w:t 再配 xml:space="preserve"，
  // 这里就会看到"没有 br 子元素"，直接被抓住。
  const py = findPython();
  if (!py) {
    t.skip('本机没有可用的 python3 + python-docx');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'scanfree-docx-br-'));
  try {
    const file = join(dir, 'br.docx');
    writeFileSync(file, await buildDOCX([
      { type: 'para', inline: [{ type: 'text', text: '出租方（甲方）：张明\n承租方（乙方）：李华' }] },
      { type: 'table', header: null, rows: [[[{ type: 'text', text: '格一\n格二' }]]], aligns: [null], hasHeader: false },
    ]));
    const script = [
      'import sys, docx',
      'from docx.oxml.ns import qn',
      'd = docx.Document(sys.argv[1])',
      'p = d.paragraphs[0]',
      'print("PARA:" + repr(p.text))',
      // w:br 是 run 的直接子元素；拆出每段文字并在 br 处补 \\n
      'r = p.runs[0]',
      'parts = []',
      'for child in r._r:',
      '    if child.tag == qn("w:br"):',
      // 用 chr(10) 而不是 "\\n"：避免在 JS 字符串里再套一层转义（很容易写错）
      '        parts.append(chr(10))',
      '    elif child.tag == qn("w:t"):',
      '        parts.append(child.text or "")',
      'print("RUNS:" + repr("".join(parts)))',
      'print("BRCOUNT:" + str(len(r._r.findall(qn("w:br")))))',
      'cell = d.tables[0].rows[0].cells[0]',
      'print("CELL:" + repr(cell.text))',
      'print("CELLBR:" + str(len(cell.paragraphs[0].runs[0]._r.findall(qn("w:br")))))',
    ].join('\n');
    const out = execFileSync(py, ['-c', script, file], { encoding: 'utf8' }).trim();
    const get = (k) => (out.match(new RegExp('^' + k + ':(.*)$', 'm')) || [])[1];
    assert.equal(get('BRCOUNT'), '1', '正文 run 里应有 1 个 w:br 子元素');
    // python 的 repr 用单引号并把换行写成 \\n，这里反解回真实字符串再比
    const unrepr = (s) => JSON.parse('"' + s.slice(1, -1).replace(/"/g, '\\"') + '"');
    assert.equal(unrepr(get('RUNS')), '出租方（甲方）：张明\n承租方（乙方）：李华', 'w:br 处应还原成换行');
    // python-docx 的 .text 会把 <w:br/> 渲染成 \n（它认这个换行），两条信息不该粘在一起
    assert.ok(!get('PARA').includes('张明承租方'), '两行信息不该被粘成一行');
    assert.equal(get('CELLBR'), '1', '单元格里同样要有 w:br');
    assert.ok(!get('CELL').includes('格一格二'), '单元格两行也不该粘在一起');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('表格是真正的 w:tbl：边框、网格、列宽、表头跨页重复', async () => {
  const bytes = await buildDOCX(SAMPLE());
  const xml = entryText(bytes, 'word/document.xml');

  assert.match(xml, /<w:tbl>/, '应使用真正的 Word 表格');
  assert.match(xml, /<w:tblPr>/, '应有 w:tblPr');
  assert.match(xml, /<w:tblBorders>/, '应有四边边框定义');
  assert.match(xml, /<w:top w:val="single"/);
  assert.match(xml, /<w:bottom w:val="single"/);
  assert.match(xml, /<w:insideH w:val="single"/);
  assert.match(xml, /<w:tblGrid>/, '没有 tblGrid，不同阅读器会各自猜列宽');
  assert.equal((xml.match(/<w:gridCol /g) || []).length, 3, '网格应有 3 列');
  assert.equal((xml.match(/<w:tr>/g) || []).length, 3, '3 行 = 表头 + 2 数据行');
  assert.equal((xml.match(/<w:tc>/g) || []).length, 9, '3 行 × 3 列 = 9 个单元格');
  assert.ok(xml.includes('<w:tblHeader/>'), '表头行应带 w:tblHeader 以支持跨页重复');
  // 表头只能出现一次（数据行不能也标成表头）
  assert.equal((xml.match(/<w:tblHeader\/>/g) || []).length, 1);
  // 对齐：left→start / center→center / right→end
  assert.match(xml, /<w:jc w:val="start"\/>/);
  assert.match(xml, /<w:jc w:val="center"\/>/);
  assert.match(xml, /<w:jc w:val="end"\/>/);
  // 每个单元格都要有显式宽度
  assert.equal((xml.match(/<w:tcW /g) || []).length, 9);
});

test('hr 用段落下边框实现；列表引用 numbering.xml 的 numId', async () => {
  const bytes = await buildDOCX(SAMPLE());
  const xml = entryText(bytes, 'word/document.xml');
  const numbering = entryText(bytes, 'word/numbering.xml');

  // hr：空段落 + 下边框（docx 里没有独立的横线元素）
  assert.match(xml, /<w:pBdr><w:bottom w:val="single"/, 'hr 应是带下边框的空段落');

  // 无序列表 → numId 1；有序列表 → numId 2，两者都带 ilvl
  assert.match(xml, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr>/, '无序列表应引用 numId=1');
  assert.match(xml, /<w:numPr><w:ilvl w:val="1"\/><w:numId w:val="1"\/><\/w:numPr>/, '缩进一层的项应带 ilvl=1');
  assert.match(xml, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="2"\/><\/w:numPr>/, '有序列表应引用 numId=2');

  // numbering.xml 里两套编号都要真的定义出来，且 num→abstractNum 映射完整
  assert.match(numbering, /<w:abstractNum w:abstractNumId="10">/);
  assert.match(numbering, /<w:abstractNum w:abstractNumId="20">/);
  assert.match(numbering, /<w:num w:numId="1"><w:abstractNumId w:val="10"\/><\/w:num>/);
  assert.match(numbering, /<w:num w:numId="2"><w:abstractNumId w:val="20"\/><\/w:num>/);
  // 有序列表是 decimal 且带 "%1." 占位符（Word 里就显示 1. 2. 3.）
  assert.match(numbering, /<w:numFmt w:val="decimal"\/><w:lvlText w:val="%1\."\/>/);
  assert.match(numbering, /<w:numFmt w:val="bullet"\/>/);
  // 每个 lvl 都必须给出 ilvl / numFmt / lvlText / lvlJc 四件套，缺一个 Word 会忽略整级
  const lvls = numbering.match(/<w:lvl w:ilvl="\d">/g) || [];
  assert.equal(lvls.length, 8, '两套 abstractNum × 4 级 = 8 个 w:lvl');
  assert.equal((numbering.match(/<w:lvlJc w:val="left"\/>/g) || []).length, 8);
  assert.equal((numbering.match(/<w:start w:val="1"\/>/g) || []).length, 8);
});

test('code 块：等宽字体 + 底纹 + 换行转成 w:br', async () => {
  const bytes = await buildDOCX(SAMPLE());
  const xml = entryText(bytes, 'word/document.xml');

  assert.match(xml, /w:ascii="Consolas,Courier New"/, '代码块应用等宽字体');
  assert.match(xml, /<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"\/>/, '代码块应有浅灰底');
  assert.ok(xml.includes('<w:br/>'), '多行代码的换行必须转成 w:br，否则会被折成一行');
  // 三行代码 → 两个 br
  const codePart = xml.slice(xml.indexOf('function hi()'));
  assert.ok(codePart.startsWith('function hi()'), '代码文字应原样出现');
  assert.ok(/\{<w:br\/>\s*return/.test(codePart) || codePart.includes('<w:br/>'), '行间应插入 w:br');
});

test('中文默认字体走 eastAsia（宋体），且可由 opts 覆盖', async () => {
  const styles = entryText(await buildDOCX([]), 'word/styles.xml');
  assert.match(styles, /w:eastAsia="宋体"/, '默认中文字体应是宋体');
  assert.match(styles, /w:ascii="Calibri"/, '默认西文字体应是 Calibri');
  assert.match(styles, /w:hint="eastAsia"/, 'hint 决定中日韩字符优先用哪一支字体');

  const custom = entryText(await buildDOCX([], { fontZh: '微软雅黑', fontEn: 'Arial', fontSizePt: 14 }), 'word/styles.xml');
  assert.match(custom, /w:eastAsia="微软雅黑"/);
  assert.match(custom, /w:ascii="Arial"/);
  assert.match(custom, /<w:sz w:val="28"\/>/, '14pt 应换算成 28 半磅');

  // 标题与列表样式必须真实定义（只写 pStyle 不定义样式，Word 会掉成默认外观）
  assert.match(styles, /<w:style w:type="paragraph" w:default="1" w:styleId="Normal">/);
  for (let n = 1; n <= 6; n++) {
    assert.ok(styles.includes(`w:styleId="Heading${n}"`), `styles.xml 应定义 Heading${n}`);
    assert.ok(styles.includes(`<w:name w:val="heading ${n}"/>`), `Heading${n} 的 w:name 必须是内置名，否则 Word 不认`);
  }
  assert.match(styles, /w:styleId="ListParagraph"/);
});

test('内容类型与包关系齐全（少一个 Word 就判文件损坏）', async () => {
  const bytes = await buildDOCX([]);
  const ct = entryText(bytes, '[Content_Types].xml');
  const rels = entryText(bytes, '_rels/.rels');
  const docRels = entryText(bytes, 'word/_rels/document.xml.rels');
  const core = entryText(bytes, 'docProps/core.xml');

  assert.match(ct, /<Default Extension="rels" ContentType="application\/vnd.openxmlformats-package.relationships\+xml"\/>/);
  for (const part of ['/word/document.xml', '/word/styles.xml', '/word/numbering.xml', '/docProps/core.xml']) {
    assert.ok(ct.includes(`PartName="${part}"`), `[Content_Types].xml 缺少 ${part} 的 Override`);
  }
  // officeDocument 关系必须恰好一个，Word 靠它找主文档。
  // 注意别用裸的 /officeDocument/ 计数：关系类型 URL 里这个单词本来就出现两次
  // （命名空间 .../officeDocument/2006/relationships 一次，类型名再一次），
  // 数错了会误判。这里只数真正的关系类型名。
  assert.equal((rels.match(/relationships\/officeDocument"/g) || []).length, 1, 'officeDocument 关系必须恰好一个');
  assert.equal((rels.match(/<Relationship /g) || []).length, 2);
  assert.match(rels, /Target="word\/document.xml"/);
  assert.match(rels, /Target="docProps\/core.xml"/);
  assert.match(docRels, /<Relationships[\s>]/);
  assert.match(docRels, /Target="styles.xml"/);
  assert.match(docRels, /Target="numbering.xml"/);

  assert.match(core, /<dc:title>扫描文档<\/dc:title>/, '默认标题应兜底，不能是空');
  assert.match(core, /<dc:creator>全民扫描 ScanFree<\/dc:creator>/);
  assert.match(core, /<cp:lastModifiedBy>/);
  assert.match(core, /<dcterms:created xsi:type="dcterms:W3CDTF">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/dcterms:created>/);
  assert.match(core, /<dcterms:modified xsi:type="dcterms:W3CDTF">/);

  // core.xml 里的中文也必须正确转义/编码
  const t = entryText(await buildDOCX([], { title: '报告 & 结论' }), 'docProps/core.xml');
  assert.match(t, /<dc:title>报告 &amp; 结论<\/dc:title>/);
});

test('textutil（macOS 系统自带的另一套实现）能把文字转回来（无 textutil 时跳过）', async (t) => {
  if (!hasTextutil) {
    t.skip('本机没有 textutil');
    return;
  }
  const bytes = await buildDOCX(SAMPLE(), { title: '体检报告' });

  withDocx(bytes, (file) => {
    const out = execFileSync('textutil', ['-convert', 'txt', '-stdout', file], { encoding: 'utf8' });
    // 这是系统 Word 解析栈（不是我们的代码）读出来的文字
    for (const need of ['体检报告 2026', '检查项目', '姓名：张三 & 李四 <测试>', '白细胞计数', '血红蛋白', 'function hi()']) {
      assert.ok(out.includes(need), `textutil 转出的文本里应包含「${need}」，实际：\n${out.slice(0, 600)}`);
    }
    // 表格单元格必须也在
    assert.ok(out.includes('10^9/L'), '表格内容应能转出来');
    // 控制字符被剥掉后应留下 abc
    assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(out), '转出的文本里不应有控制字符');
  });
});

test('坏输入不崩：未知块类型被忽略而不是生成坏 XML', async () => {
  const bytes = await buildDOCX([
    null,
    { type: 'unknown-kind' },
    { type: 'para', inline: null },
    { type: 'list', ordered: true, items: [] },
    { type: 'table', header: null, rows: [], aligns: [], hasHeader: false },
    { type: 'heading', level: 99, inline: [{ type: 'text', text: '越界标题' }] },
    { type: 'code', text: '' },
    { type: 'para', inline: [{ type: 'text', text: '' }, { type: 'bold', text: '空 run' }] },
  ]);
  const xml = entryText(bytes, 'word/document.xml');

  assert.ok(xml.includes('越界标题'), '越界的 level 应被夹到 1..6 而不是丢掉内容');
  assert.match(xml, /<w:pStyle w:val="Heading6"\/>/, 'level 99 应夹到 Heading6');
  assert.ok(xml.includes('空 run'));
  // 没有行的表格也要合法：至少要有一个 w:tr，否则 w:tbl 是非法的
  assert.match(xml, /<w:tbl>[\s\S]*<w:tr>/);
  assert.ok(!xml.includes('unknown-kind'), '未知类型不应泄漏进 XML');
  assert.ok(!xml.includes('undefined'), '不应把 undefined 拼进 XML');
  assert.ok(!xml.includes('NaN'));

  if (hasUnzip) {
    withDocx(bytes, (file) => {
      assert.match(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }), /No errors detected/);
    });
  }
});

test('OOXML 属性容器里的子元素顺序合规（顺序错了 Word 会静默丢属性或判损坏）', async () => {
  // 用最"全"的样例：标题/段落/两种列表/表格/代码块/hr 都有各自的 pPr、rPr、
  // tblPr、trPr、tcPr，正好把顺序表整个走一遍
  for (const [name, bytes] of [
    ['document.xml', await buildDOCX(SAMPLE(), { title: '报告', author: '扫描' })],
    ['styles.xml', await buildDOCX([], { fontZh: '微软雅黑', fontSizePt: 14 })],
  ]) {
    const xml = entryText(bytes, `word/${name}`);
    assert.deepEqual(orderViolations(xml), [], `${name} 里的属性子元素顺序不合规`);
  }

  const numbering = entryText(await buildDOCX(SAMPLE()), 'word/numbering.xml');
  assert.deepEqual(orderViolations(numbering), [], 'numbering.xml 里的 w:lvl 顺序不合规');

  // 反向自检：确认这个检查器真的能抓到错误，而不是恒返回空数组。
  // （这几个字面量必须真的是**违规**写法，否则自检本身就是假绿。）
  assert.ok(
    orderViolations('<w:pPr><w:ind w:left="0"/><w:spacing w:after="0"/></w:pPr>').length > 0,
    '顺序检查器本身要能抓到 pPr 里 ind 排在 spacing 前面'
  );
  assert.ok(
    orderViolations('<w:tblPr><w:tblBorders/><w:tblW w:w="1"/></w:tblPr>').length > 0,
    '顺序检查器本身要能抓到 tblPr 里 tblBorders 排在 tblW 前面'
  );
  assert.ok(
    orderViolations('<w:tcPr><w:tcW w:w="1"/><w:jc w:val="center"/></w:tcPr>').length > 0,
    '单元格的 w:jc 属于段落而不是 tcPr，塞进 tcPr 必须被判非法'
  );
  assert.ok(
    orderViolations('<w:lvl w:ilvl="0"><w:pPr/><w:lvlJc w:val="left"/></w:lvl>').length > 0,
    '顺序检查器本身要能抓到 w:lvl 里 pPr 排在 lvlJc 前面（lvlJc 才是在前的那个）'
  );
  assert.ok(
    orderViolations('<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/><w:nsid w:val="1A2B3C01"/></w:abstractNum>').length > 0,
    '顺序检查器本身要能抓到 abstractNum 里 multiLevelType 排在 nsid 前面'
  );
  // 合规的写法必须被判过（否则检查器只会误报）
  assert.deepEqual(orderViolations('<w:pPr><w:spacing w:after="0"/><w:ind w:left="0"/></w:pPr>'), []);
  assert.deepEqual(orderViolations('<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>'), [], '孙元素不该被算进顺序表');
  assert.deepEqual(orderViolations('<w:lvl><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr/></w:lvl>'), []);
});

/**
 * 上面那套手写顺序表只能覆盖我"想到要检查"的容器；这里再上一层保险：
 * 用 ISO/IEC 29500 的官方 wml.xsd 做真正的 schema 校验。
 *
 * 为什么值得单独一个用例：w:nsid 和 w:multiLevelType 这种冷门元素的先后顺序
 * 我是靠 schema 才发现的（手写检查当时漏了 abstractNum），schema 校验是唯一
 * 能对"所有容器、所有属性"一次性兜住的检查。
 *
 * schema 是好心人随工具附带的，路径不一定在；找不到就 skip。
 */
const WML_SCHEMA = join(
  '/Users/fish/Library/Application Support/Claude-3p/local-agent-mode-sessions/skills-plugin',
  '00000000-0000-4000-8000-000000000001/2501af0e-be5c-4448-86b2-b8a10f281b1b',
  'skills/docx/scripts/office/schemas/ISO-IEC29500-4_2016/wml.xsd'
);

test('官方 wml.xsd（ISO/IEC 29500-4）schema 校验通过（无 schema 时跳过）', async (t) => {
  if (!existsSync(WML_SCHEMA)) {
    t.skip('本机没有 ISO/IEC 29500-4 的 wml.xsd');
    return;
  }
  const py = findPython();
  if (!py) {
    t.skip('没有可用的 python3');
    return;
  }
  // 这个解释器必须同时有 python-docx（findPython 保证）和 lxml（python-docx 的依赖）
  try {
    execFileSync(py, ['-c', 'from lxml import etree'], { stdio: 'ignore' });
  } catch {
    t.skip('python3 里没有 lxml');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'scanfree-docx-xsd-'));
  try {
    const bytes = await buildDOCX(SAMPLE(), { title: '报告', author: '扫描' });
    const file = join(dir, 'schema.docx');
    writeFileSync(file, bytes);
    const script = [
      'import sys, zipfile',
      'from lxml import etree',
      'schema = etree.XMLSchema(etree.parse(sys.argv[1]))',
      'z = zipfile.ZipFile(sys.argv[2])',
      'bad = []',
      'for name in ("word/document.xml", "word/styles.xml", "word/numbering.xml"):',
      '    doc = etree.fromstring(z.read(name))',
      '    if not schema.validate(doc):',
      '        bad.append(name + ": " + "; ".join(e.message for e in schema.error_log[:5]))',
      'print("OK" if not bad else "\\n".join(bad))',
    ].join('\n');
    const out = execFileSync(py, ['-c', script, WML_SCHEMA, file], { encoding: 'utf8' }).trim();
    assert.equal(out, 'OK', `OOXML 部件不符合官方 schema：\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blocksToPlain：不碰 XML 的纯文字预览入口（给"要不要导 Word"的日志/调试用）', () => {
  // 这个函数不参与导出，但它是块格式的"另一条独立读法"：
  // 如果它和 renderBlock 对块格式的理解不一致，说明有一边读错了。
  const t = (s) => [{ type: 'text', text: s }];
  assert.equal(
    blocksToPlain([
      { type: 'heading', level: 1, inline: t('标题') },
      { type: 'para', inline: [{ type: 'bold', text: '粗' }, ...t('普通')] },
      { type: 'list', ordered: true, items: [{ level: 0, inline: t('第一') }, { level: 0, inline: t('第二') }] },
      { type: 'table', header: [t('A')], rows: [[t('1'), t('2')]], aligns: ['left', 'left'] },
      { type: 'hr' },
      { type: 'code', text: 'x = 1' },
    ]),
    ['标题', '粗普通', '第一\n第二', 'A\n1\t2', '---', 'x = 1'].join('\n')
  );
  // 坏输入不抛异常（和 buildDOCX 一样，导出的东西不能因为上游给了 null 就崩）
  assert.equal(blocksToPlain(null), '');
  assert.equal(blocksToPlain([null, { type: 'para' }]), '\n');
});
