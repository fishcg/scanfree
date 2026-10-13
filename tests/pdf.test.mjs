/**
 * PDF 生成器测试。
 *
 * 关键点：不只是"能不能跑"，而是产出的 PDF 能不能被真正的 PDF 解析器接受。
 * 如果本机装了 Ghostscript（macOS/Linux 常见），会额外跑一次 gs 校验；
 * 没装就跳过这一步，只做结构断言，测试依然全部可跑。
 *
 * 运行：node --test tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPDF } from '../js/pdf.js';

const jpeg = new Uint8Array(readFileSync(new URL('./fixtures/scan-sample.jpg', import.meta.url)));

/** 把字节转成 latin1 字符串，方便断言 PDF 的文本结构 */
const text = (u8) => Buffer.from(u8).toString('latin1');

test('单页 PDF：结构完整、页数正确', () => {
  const pdf = buildPDF([{ jpeg, width: 64, height: 64 }], { title: '测试文档' });
  const s = text(pdf);

  assert.ok(s.startsWith('%PDF-1.4'), '应以 %PDF-1.4 开头');
  assert.ok(s.trimEnd().endsWith('%%EOF'), '应以 %%EOF 结尾');
  assert.match(s, /\/Type \/Catalog/);
  assert.match(s, /\/Type \/Pages \/Kids \[3 0 R\] \/Count 1/);
  assert.match(s, /\/Filter \/DCTDecode/, '图片应原样内嵌，不做二次编码');
  assert.match(s, /\/Width 64 \/Height 64/);
  assert.ok(s.includes('startxref'), '应有 startxref');
});

test('多页 PDF：每页都有自己的 Page / Contents / Image 对象', () => {
  const pages = Array.from({ length: 5 }, () => ({ jpeg, width: 64, height: 64 }));
  const pdf = buildPDF(pages, { title: '五页文档' });
  const s = text(pdf);

  assert.match(s, /\/Count 5/);
  assert.equal((s.match(/\/Type \/Page[^s]/g) || []).length, 5, '应有 5 个 Page 对象');
  assert.equal((s.match(/\/Subtype \/Image/g) || []).length, 5, '应有 5 个图片对象');
  assert.equal((s.match(/\/Filter \/DCTDecode/g) || []).length, 5);
});

test('交叉引用表与对象偏移量自洽', () => {
  const pdf = buildPDF([{ jpeg, width: 64, height: 64 }], {});
  const s = text(pdf);

  const startxref = Number(s.slice(s.lastIndexOf('startxref') + 9).trim().split(/\s/)[0]);
  assert.ok(startxref > 0 && startxref < pdf.length, 'startxref 应指向文件内部');
  assert.ok(s.slice(startxref, startxref + 4) === 'xref', 'startxref 应指向 xref 表');

  const sizeMatch = s.match(/\/Size (\d+)/);
  const declared = Number(sizeMatch[1]);
  const entries = s.slice(startxref).match(/^\d{10} \d{5} [nf] $/gm) || [];
  assert.equal(entries.length, declared, `xref 条目数(${entries.length})应与 /Size(${declared})一致`);

  // 逐条验证偏移量真的指向 "N 0 obj"
  for (let i = 1; i < declared; i++) {
    const off = Number(entries[i].slice(0, 10));
    assert.match(s.slice(off, off + 24), new RegExp(`^${i} 0 obj`), `第 ${i} 号对象的偏移量应正确`);
  }
});

test('中文标题按 UTF-16BE 编码，不会乱码', () => {
  const s = text(buildPDF([{ jpeg, width: 64, height: 64 }], { title: '体检报告 2026' }));
  assert.match(s, /\/Title <FEFF/, '非 ASCII 标题应使用 UTF-16BE 十六进制串');
  assert.ok(!s.includes('/Title (体检报告'), '不应把中文直接塞进字面量字符串');
});

test('ASCII 标题使用普通字符串并正确转义括号', () => {
  const s = text(buildPDF([{ jpeg, width: 64, height: 64 }], { title: 'Report (final)' }));
  assert.ok(s.includes('/Title (Report \\(final\\))'), '括号应被转义');
});

test('空页列表应直接报错，而不是生成坏文件', () => {
  assert.throws(() => buildPDF([], {}), /至少需要一页/);
});

test('Ghostscript 能解析生成的 PDF（无 gs 时自动跳过）', (t) => {
  let gs = null;
  for (const candidate of ['gs', '/opt/homebrew/bin/gs', '/usr/local/bin/gs', '/usr/bin/gs']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      gs = candidate;
      break;
    } catch {
      /* 继续找 */
    }
  }
  if (!gs) {
    t.skip('本机没有 Ghostscript，跳过真实解析校验');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'scanfree-pdf-'));
  const file = join(dir, 'out.pdf');
  const pages = [
    { jpeg, width: 64, height: 64 },
    { jpeg, width: 64, height: 64 },
  ];
  writeFileSync(file, buildPDF(pages, { title: '解析校验' }));

  // 让 gs 完整解析并渲染成位图：任何结构错误都会在这里暴露
  const out = execFileSync(
    gs,
    ['-dNOPAUSE', '-dBATCH', '-dQUIET', '-sDEVICE=nullpage', '-dPDFSTOPONERROR', file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  assert.ok(true, `gs 解析通过：${out || '无错误输出'}`);
});
