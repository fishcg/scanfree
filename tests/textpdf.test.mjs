/**
 * 文字版 PDF 的测试。
 *
 * 这一份和 pdf.test.mjs（图片版）是两件不同的东西：图片版是把照片嵌进去，
 * 文字版是**把识别出来的字排成真正的文字**——能选中、能搜索、体积只有几 KB。
 * 所以这里要验的除了 PDF 结构合法，还要验"字真的在里面、真的按宽度折了行"。
 *
 * Ghostscript 能真解析（装了 gs 才跑，没装就跳过那两条）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTextPDF, measureText, wrapParagraph } from '../js/pdf.js';

const GS = ['/opt/homebrew/bin/gs', '/usr/local/bin/gs', '/usr/bin/gs'].find((p) => existsSync(p));

const dec = new TextDecoder('latin1');
const asText = (u8) => dec.decode(u8);

/** 交给 Ghostscript 真解析一遍；有问题会非零退出并把原因写到 stderr */
function gsParse(bytes, label) {
  const dir = mkdtempSync(join(tmpdir(), 'scanfree-textpdf-'));
  const file = join(dir, `${label}.pdf`);
  try {
    writeFileSync(file, bytes);
    execFileSync(GS, ['-dNOPAUSE', '-dBATCH', '-dQUIET', '-sDEVICE=nullpage', '-dPDFSTOPONERROR', file], {
      stdio: 'pipe',
      timeout: 60000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 把文件里的十六进制 CID 串解回文字，用于断言"这些字在里面" */
function cidStrings(pdfText) {
  const out = [];
  const re = /<([0-9A-F]{4,})>/g;
  let m;
  while ((m = re.exec(pdfText))) {
    let s = '';
    for (let i = 0; i + 4 <= m[1].length; i += 4) s += String.fromCharCode(parseInt(m[1].slice(i, i + 4), 16));
    out.push(s);
  }
  return out;
}

test('文字版 PDF：能生成、结构对、字是十六进制 CID 编码', () => {
  const pdf = buildTextPDF('房屋租赁合同\n出租方：张明');
  const t = asText(pdf);

  assert.match(t, /^%PDF-1\.4/);
  assert.match(t, /%%EOF\s*$/);
  assert.match(t, /\/Type \/Catalog/);
  assert.match(t, /\/Subtype \/Type0/);
  assert.match(t, /\/Encoding \/UniGB-UCS2-H/);
  assert.match(t, /\/BaseFont \/STSong-Light/);
  assert.match(t, /\/Subtype \/Type1 \/BaseFont \/Helvetica/);

  // 中文必须走 CID 字体，而且码位要能在解出来的串里找到
  const cids = cidStrings(t);
  assert.ok(cids.some((s) => s.includes('房屋租赁合同')), '正文里的中文应当以 CID 十六进制写进内容流');
  assert.ok(cids.some((s) => s.includes('出租方')), '第二行也应当在');

  // 中文不该以明文（WinAnsi）形式出现
  assert.ok(!t.includes('(房屋'), '中文不能当作 WinAnsi 单字节写进去（会变乱码）');

  // 关键：xref 里每一行偏移都要真指向 "N 0 obj"
  const xrefPos = t.lastIndexOf('\nxref\n') + 1; // 注意别匹配到 startxref
  const lines = t.slice(xrefPos).split('\n');
  const startNum = Number(lines[1].split(' ')[1]);
  assert.ok(startNum > 6, '至少要有 6 个基础对象 + 1 页');
  for (let i = 1; i < startNum; i++) {
    // lines[0]=xref, lines[1]='0 N', lines[2]=对象 0 的空闲项，所以对象 i 在 lines[2+i]
    const off = Number(lines[2 + i].slice(0, 10));
    assert.equal(t.slice(off, off + String(i).length + 6), `${i} 0 obj`, `对象 ${i} 的 xref 偏移不对`);
  }
});

test('文字版 PDF：长文自动分页，每页都有自己的内容流', () => {
  const long = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行：这是一段用来把页面撑满的中文，看看会不会自动翻页。`).join('\n');
  const pdf = buildTextPDF(long);
  const t = asText(pdf);

  const count = Number(t.match(/\/Count (\d+)/)[1]);
  assert.ok(count >= 2, `120 行应当排出多页，实际只有 ${count} 页`);

  // 每个 Page 对象都要跟一个 Contents
  assert.equal((t.match(/\/Type \/Page[^s]/g) || []).length, count, 'Page 对象数与 /Count 要一致');
  assert.equal((t.match(/\bstream\b/g) || []).length, count, '每页一个内容流');
  assert.match(t, new RegExp(`/Count ${count}`));
});

test('文字版 PDF：英文用 Helvetica 明文，中文折行不超宽', () => {
  const pdf = buildTextPDF('Hello ScanFree 2026\nmixed 中英混排 test');
  const t = asText(pdf);
  assert.ok(t.includes('(Hello ScanFree 2026)'), '纯 ASCII 的行应当是可读的明文');
  assert.ok(t.includes('(mixed )') && t.includes('( test)'), '混排行要按字体切成多段');

  // 折行：宽度不能超，且标点不顶行首
  const size = 10.5;
  const maxWidth = 400;
  const long = '这是一段很长的中文用来测试折行' .repeat(4) + '，结束。';
  const lines = wrapParagraph(long, maxWidth, size);
  assert.ok(lines.length >= 2, '要真的折了行');
  for (const l of lines) {
    if (!l) continue;
    // 允许标点悬挂导致的一点点溢出，但不能多出一整个字
    assert.ok(measureText(l, size) <= maxWidth + size, `行超宽：${l}`);
    assert.ok(!'，。、；：？！）'.includes(l[0]), `标点顶到了行首：${l}`);
  }
  // 折行不能吞字
  assert.equal(lines.join('').replace(/\s/g, ''), long.replace(/\s/g, ''), '折行前后字数要一致');
});

test('文字版 PDF：空文本应当报错，而不是生成一个坏文件', () => {
  assert.throws(() => buildTextPDF(''), /还没有可导出的文字/);
  assert.throws(() => buildTextPDF('   \n  \n'), /还没有可导出的文字/);
  assert.throws(() => buildTextPDF(null), /还没有可导出的文字/);
});

test('文字版 PDF：体积必须比图片版小得多（这是它存在的理由）', () => {
  const text = Array.from({ length: 40 }, () => '扫描全能王的核心功能是把纸变成文件。').join('\n');
  const pdf = buildTextPDF(text);
  assert.ok(pdf.length < 12 * 1024, `文字版应当只有几 KB，实际 ${pdf.length} 字节`);
  assert.ok(pdf.length > 800, '也不该小到内容丢了');
});

test('文字版 PDF：Ghostscript 能真解析', { skip: GS ? false : '没装 ghostscript' }, () => {
  gsParse(buildTextPDF('房屋租赁合同\n\n出租方（甲方）：张明\n承租方（乙方）：李华\n第一条 甲方将位于本市南京西路 1000 号的房屋出租给乙方居住使用。'), 'cn');
  gsParse(buildTextPDF('Mixed 中英文 test 2026\n' + 'long line '.repeat(200)), 'mix');
});
