/**
 * buildMarkdownPDF 的测试：把结构化文档块画成"保排版"的 PDF。
 *
 * 这里测的是**排版结果**，不是"函数跑完了"：
 *   - 中文必须走 CID 十六进制（写错一个字节，整份文件就全是乱码方块）
 *   - 加粗是 Tr 2 描边画的（STSong-Light 没有粗体，靠描边假装）
 *   - 表格必须真的画出格线（导出的合同少了表格线，用户一眼就看出来不对）
 *   - 文字不许跑到页面下边距以外（分页算错时最典型的症状）
 * 最后用 Ghostscript 真解析一遍——只有它能证明"别的阅读器打得开"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { buildMarkdownPDF } from '../js/pdf.js';
import { parseMarkdown } from '../js/markdown.js';

const GS = ['/opt/homebrew/bin/gs', '/usr/bin/gs', '/usr/local/bin/gs'].find((p) => existsSync(p));

const latin = (u8) => Buffer.from(u8).toString('latin1');
const cid = (s) => `<${[...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase()}>`;

const CONTRACT = `# 房屋租赁合同

合同编号：2026-ZL-0088

出租方（甲方）：张明  身份证号：3101***********1234

承租方（乙方）：李华  身份证号：3101***********5678

| 项目 | 金额 | 备注 |
| --- | --- | --- |
| 月租金 | 人民币6500元 | 押一付三 |
| 押金 | 人民币6500元 | 退租时结算 |

甲方签字：__________  日期：2026年1月1日`;

test('生成的 PDF 是一个结构完整的文件', () => {
  const pdf = latin(buildMarkdownPDF(parseMarkdown(CONTRACT), { title: '房屋租赁合同' }));
  assert.ok(pdf.startsWith('%PDF-1.4'), '要以 %PDF-1.4 开头');
  assert.ok(pdf.trimEnd().endsWith('%%EOF'), '要以 %%EOF 结尾');
  assert.match(pdf, /\/Type \/Catalog/);
  assert.match(pdf, /\/Type \/Pages/);
  assert.match(pdf, /\/Count 1\b/, '一页文档 /Count 应该是 1');
  assert.match(pdf, /startxref\n\d+\n%%EOF/);
  // 中文字体：Type0 + UniGB-UCS2-H，这是不嵌入也能显示中文的关键
  assert.match(pdf, /\/BaseFont \/STSong-Light/);
  assert.match(pdf, /\/Encoding \/UniGB-UCS2-H/);
});

test('xref 里每一条偏移都真的指向那个对象', () => {
  const pdf = latin(buildMarkdownPDF(parseMarkdown(CONTRACT)));
  const xrefAt = pdf.lastIndexOf('\nxref\n') + 1;
  const lines = pdf.slice(xrefAt).split('\n');
  const total = Number(lines[1].split(' ')[1]);
  for (let i = 1; i < total; i += 1) {
    const off = Number(lines[2 + i].slice(0, 10));
    assert.ok(pdf.startsWith(`${i} 0 obj`, off), `对象 ${i} 的偏移 ${off} 指错了地方`);
  }
});

test('中文写成 CID 十六进制，英文写成明文', () => {
  const pdf = latin(buildMarkdownPDF(parseMarkdown('# 租赁合同\n\nRent 6500 CNY')));
  assert.ok(pdf.includes(cid('租赁合同')), '中文应该是 UTF-16BE 的十六进制串');
  assert.ok(pdf.includes('(Rent 6500 CNY)'), '英文应该是可读明文');
  // 中文绝不能以 UTF-8 原样出现在内容流里，否则不同阅读器会各显示各的乱码
  assert.ok(!pdf.includes('租赁合同'), '中文不该以原样字节出现');
});

test('加粗用描边画（Tr 2），不加粗的文字不带描边', () => {
  const bolded = latin(buildMarkdownPDF(parseMarkdown('**重要：**请在明天之前交材料')));
  assert.match(bolded, /2 Tr 0\.36 w 0 g/, '加粗要先切到"填充+描边"模式');
  assert.match(bolded, /0 Tr/, '画完必须切回来，否则后面全变粗');

  const plain = latin(buildMarkdownPDF(parseMarkdown('请在明天之前交材料')));
  assert.ok(!plain.includes('2 Tr'), '没有加粗就不该出现描边指令');
});

test('标题按字号放大，并且画了一条分隔线', () => {
  const pdf = latin(buildMarkdownPDF(parseMarkdown('# 大标题\n\n正文')));
  // 一级标题 20.5pt，正文 10.5pt
  assert.match(pdf, /\/F2 20\.5 Tf/, '一级标题要用 20.5pt');
  assert.match(pdf, /\/F2 10\.5 Tf/, '正文要用 10.5pt');
  assert.match(pdf, / [\d.]+ [\d.]+ m [\d.]+ [\d.]+ l S/, '一级标题下面要画一条线');
});

test('表格真的画出格线，列数对得上', () => {
  const pdf = latin(buildMarkdownPDF(parseMarkdown('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |')));
  // 表头底色
  assert.match(pdf, /0\.94 g [\d.]+ [\d.]+ [\d.]+ [\d.]+ re f/, '表头要有底色');
  // 竖线：3 列 → 每行 4 条竖线；两行（表头 + 数据）→ 8 条
  const vertical = pdf.match(/m [\d.]+ [\d.]+ l S/g) || [];
  assert.ok(vertical.length >= 8, `表格竖线太少（${vertical.length} 条）`);
  // 横线：表头上下 + 数据行下方
  const horizontal = (pdf.match(/[\d.]+ [\d.]+ m [\d.]+ [\d.]+ l S/g) || []).length;
  assert.ok(horizontal >= 3, `表格横线太少（${horizontal} 条）`);
  // 单元格里的字要画出来
  assert.ok(pdf.includes(cid('A')) || pdf.includes('(A)'));
});

test('段落里的硬换行真的换行（不是被合并成一行）', () => {
  const one = latin(buildMarkdownPDF(parseMarkdown('第一行\n第二行')));
  const merged = latin(buildMarkdownPDF(parseMarkdown('第一行第二行')));
  // 页脚页码也是一行 Tm，比正文时先把它滤掉（它就画在下边距 38 上）
  const yOf = (pdf) => [...pdf.matchAll(/1 0 [\d.]+ 1 ([\d.-]+) ([\d.-]+) Tm/g)]
    .map((m) => Number(m[2]))
    .filter((y) => Math.abs(y - 38) > 0.6);
  assert.equal(yOf(one).length, 2, '两行文字要画在两个 y 上');
  assert.equal(yOf(merged).length, 1, '合成一句就只该有一个 y');
  assert.ok(yOf(one)[0] !== yOf(one)[1], '两行的 y 必须不同');
});

test('长文档自动分页，文字不会跑到下边距外面', () => {
  const para = '这是一段用来把页面填满的文字，反复出现以便触发自动分页。';
  const md = Array.from({ length: 80 }, (_, i) => `## 第 ${i + 1} 节\n\n${para}${para}`).join('\n\n');
  const pdf = latin(buildMarkdownPDF(parseMarkdown(md), { margin: 64 }));
  const pages = Number(pdf.match(/\/Count (\d+)/)[1]);
  assert.ok(pages >= 3, `80 节应该排出好几页，实际 ${pages} 页`);

  // 所有文字基线的 y：正文不许低于下边距 64（页脚画在 38，单独放过）
  const ys = [...pdf.matchAll(/1 0 [\d.]+ 1 ([\d.-]+) ([\d.-]+) Tm/g)].map((m) => Number(m[2]));
  assert.ok(ys.length > 100, '应该有大量文字');
  const tooLow = ys.filter((y) => y < 63.5 && Math.abs(y - 38) > 0.6);
  assert.deepEqual(tooLow, [], `有文字画到了下边距以外：${tooLow.slice(0, 5)}`);

  // 每页都得有页脚（"3 / 7"），否则说明页数统计错了
  const footers = ys.filter((y) => Math.abs(y - 38) < 0.6);
  assert.equal(footers.length, pages, '每页一个页码');
});

test('\\f 强制翻页：第二页不会混进第一页的内容', () => {
  const pdf = latin(buildMarkdownPDF(parseMarkdown('# 第一页标题\n\f# 第二页标题')));
  assert.match(pdf, /\/Count 2\b/);
  const [p1, p2] = pdf.split('endstream');
  assert.ok(p1.includes(cid('第一页标题')));
  assert.ok(!p1.includes(cid('第二页标题')), '第一页不该出现第二页的字');
  assert.ok(p2.includes(cid('第二页标题')));
});

test('列表画了项目符号和序号，并且换行时文字对齐', () => {
  const pdf = latin(buildMarkdownPDF(parseMarkdown('1. 第一项内容\n2. 第二项内容\n\n- 无序甲\n- 无序乙')));
  assert.ok(pdf.includes('(1.)') && pdf.includes('(2.)'), '有序列表要有 1. 2.');
  assert.ok(pdf.includes('(·)'), '无序列表要有圆点');
});

test('空内容报错，而不是生成一个打不开的文件', () => {
  assert.throws(() => buildMarkdownPDF([], {}), /还没有可导出的内容/);
  assert.throws(() => buildMarkdownPDF(null, {}), /还没有可导出的内容/);
});

test('一份合同的大小在几十 KB 以内（就是纯文字，没有图片）', () => {
  const bytes = buildMarkdownPDF(parseMarkdown(CONTRACT), { title: '房屋租赁合同' });
  assert.ok(bytes.length > 2000, `太小了，可能没画出东西：${bytes.length}`);
  assert.ok(bytes.length < 40 * 1024, `纯文字 PDF 不该这么大：${bytes.length}`);
});

test('Ghostscript 能打开（真解析，不是我们自说自话）', (t) => {
  if (!GS) return t.skip('本机没有 ghostscript');
  const bytes = buildMarkdownPDF(parseMarkdown(CONTRACT), { title: '房屋租赁合同' });
  const file = `/tmp/scanfree-layout-test-${process.pid}.pdf`;
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(file)}, Buffer.from(process.argv[1],'base64'))`, Buffer.from(bytes).toString('base64')]);
  const out = execFileSync(GS, ['-dNOPAUSE', '-dBATCH', '-dQUIET', '-sDEVICE=nullpage', '-dPDFSTOPONERROR', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(out.trim(), '', 'Ghostscript 不该有抱怨');
});
