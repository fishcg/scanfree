/**
 * markdown.js 的测试：模型返回的 Markdown → 结构化文档块。
 *
 * 这个文件是"保排版导出"的地基：解析错了，导出的 Word 和 PDF 就跟着错，
 * 而用户看到的是"AI 把我好好的合同排乱了"。所以这里既测正常情况，
 * 也测那些**在真实文档里一定会遇到、但标准 Markdown 测试不会覆盖**的坑
 * （打码的身份证号、表格里的竖线转义、代码块里的 #、\f 分页）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMarkdown,
  parseInline,
  inlineToPlain,
  blocksToPlain,
  looksStructured,
} from '../js/markdown.js';

test('标题按 # 的个数分级，文字里的 # 不算标题', () => {
  const b = parseMarkdown('# 一级\n## 二级\n### 三级\n#### 四级\n\n编号 #123 的说明');
  assert.deepEqual(
    b.filter((x) => x.type === 'heading').map((x) => x.level),
    [1, 2, 3, 4]
  );
  assert.equal(inlineToPlain(b[0].inline), '一级');
  // 行中间的 # 不能触发标题（否则"编号 #123"会变成标题）
  assert.equal(b[b.length - 1].type, 'para');
  assert.equal(inlineToPlain(b[b.length - 1].inline), '编号 #123 的说明');
});

test('连续的行合成一个段落，空行才是分段', () => {
  const b = parseMarkdown('第一行\n第二行\n\n另起一段');
  assert.equal(b.length, 2);
  assert.equal(b[0].type, 'para');
  // 软换行保留成换行：中文文档里"一行没写完"与"故意换行"很难区分，保守地都留着
  assert.equal(inlineToPlain(b[0].inline), '第一行\n第二行');
  assert.equal(inlineToPlain(b[1].inline), '另起一段');
});

test('行内格式：加粗、斜体、加粗斜体、行内代码、链接', () => {
  assert.deepEqual(parseInline('**粗**'), [{ type: 'bold', text: '粗' }]);
  assert.deepEqual(parseInline('*斜*'), [{ type: 'italic', text: '斜' }]);
  assert.deepEqual(parseInline('***都有***'), [{ type: 'bolditalic', text: '都有' }]);
  assert.deepEqual(parseInline('`code`'), [{ type: 'code', text: 'code' }]);
  assert.deepEqual(parseInline('[名字](http://a.b)'), [{ type: 'link', text: '名字', href: 'http://a.b' }]);

  const mixed = parseInline('**重要：**请在 *三个工作日* 内补齐，联系 `hr@x.com`');
  assert.deepEqual(
    mixed.map((s) => s.type),
    ['bold', 'text', 'italic', 'text', 'code']
  );
  assert.equal(inlineToPlain(mixed), '重要：请在 三个工作日 内补齐，联系 hr@x.com');
});

test('打码的身份证号不会被当成加粗（这是真实的回归）', () => {
  // 中文文档里 "3101***********1234" 这种打码到处都是。
  // 早先的正则把连续的 * 当成强调记号，结果整段号码被解析成 bolditalic，
  // 导出 Word 时一段数字中间突然变粗变斜。规则改成：只认 1~3 个记号。
  const src = '身份证号：3101***********1234';
  const segs = parseInline(src);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'text');
  assert.equal(segs[0].text, src);
  assert.equal(inlineToPlain(parseMarkdown(src)[0].inline), src);
});

test('单个星号没配成对时原样保留', () => {
  assert.deepEqual(parseInline('3 * 4 = 12'), [{ type: 'text', text: '3 * 4 = 12' }]);
  assert.deepEqual(parseInline('**开头没结尾'), [{ type: 'text', text: '**开头没结尾' }]);
  // 记号内侧是空白，不算强调（CommonMark 的规矩，照抄是对的）
  assert.deepEqual(parseInline('** 不是粗体 **'), [{ type: 'text', text: '** 不是粗体 **' }]);
});

test('表格：表头、行、对齐标记，以及单元格里的竖线转义', () => {
  const md = ['| 项目 | 金额 | 备注 |', '| :--- | ---: | :---: |', '| 月租金 | 6500 | 押一付三 |', '| 押金 | 6500 | 退租时结算 |'].join('\n');
  const t = parseMarkdown(md)[0];
  assert.equal(t.type, 'table');
  assert.equal(t.header.length, 3);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.aligns, ['left', 'right', 'center']);
  assert.equal(inlineToPlain(t.header[0]), '项目');
  assert.equal(inlineToPlain(t.rows[1][2]), '退租时结算');

  // 单元格里写 \| 表示一个真正的竖线，不能被切开（合同里"甲方\|乙方"很常见）
  const esc = parseMarkdown('| A | B |\n| --- | --- |\n| x \\| y | z |')[0];
  assert.equal(esc.rows[0].length, 2);
  assert.equal(inlineToPlain(esc.rows[0][0]), 'x | y');
});

test('表格里的加粗、以及表格后面还能接正文', () => {
  const b = parseMarkdown('| 项目 | 金额 |\n| --- | --- |\n| **合计** | **6500** |\n\n以上金额含税。');
  assert.equal(b[0].type, 'table');
  assert.equal(b[0].rows[0][0][0].type, 'bold');
  assert.equal(b[1].type, 'para');
  assert.equal(inlineToPlain(b[1].inline), '以上金额含税。');
});

test('列表：有序 / 无序 / 缩进，序号是数字还是圆点由列表自己决定', () => {
  const b = parseMarkdown('- 甲\n- 乙\n\n1. 一\n2. 二\n  - 缩进的子项');
  const lists = b.filter((x) => x.type === 'list');
  assert.equal(lists.length, 2);
  assert.equal(lists[0].ordered, false);
  assert.deepEqual(
    lists[0].items.map((i) => inlineToPlain(i.inline)),
    ['甲', '乙']
  );
  assert.equal(lists[1].ordered, true);
  assert.equal(lists[1].items.length, 3);
  assert.equal(lists[1].items[2].level, 1, '缩进两格要记成一级子项');
  assert.equal(inlineToPlain(lists[1].items[1].inline), '二');
});

test('代码块里的 # 和 | 不会被当成标题或表格', () => {
  const b = parseMarkdown('```json\n{"a": 1}\n# 这是注释\n```\n\n普通段落');
  assert.equal(b[0].type, 'code');
  assert.equal(b[0].text, '{"a": 1}\n# 这是注释');
  assert.equal(b[1].type, 'para');
});

test('--- 是分隔线，不是二级标题的下划线', () => {
  const b = parseMarkdown('正文\n\n---\n\n更多正文');
  assert.deepEqual(
    b.map((x) => x.type),
    ['para', 'hr', 'para']
  );
});

test('\\f 强制翻页：多页扫描件要保持一页对一页', () => {
  const b = parseMarkdown('第一页内容\n\f第二页内容');
  assert.deepEqual(
    b.map((x) => x.type),
    ['para', 'pagebreak', 'para']
  );
  // 纯文字里 \f 也要留着，导出 TXT / 纯文字 PDF 靠它分页
  assert.equal(blocksToPlain(b), '第一页内容\n\n\f\n\n第二页内容');
});

test('blocksToPlain 出来的纯文字不带任何 Markdown 记号', () => {
  const md = '# 标题\n\n**加粗**和*斜体*\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- 甲\n- 乙';
  const plain = blocksToPlain(parseMarkdown(md));
  // 注意：表格在纯文字里**故意**用 " | " 分隔单元格（读起来还是张表），
  // 所以这里不比 "|"，比的是那些会让人以为"Markdown 没解析"的记号
  for (const mark of ['#', '**', '---', '- ']) {
    assert.ok(!plain.includes(mark), `纯文字里不该出现 ${mark}：${JSON.stringify(plain)}`);
  }
  assert.ok(plain.includes('A | B'), '表格在纯文字里保留 | 分隔');
  assert.ok(plain.includes('标题') && plain.includes('加粗') && plain.includes('甲'));
});

test('空输入不报错，返回空数组', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('   \n\n  '), []);
  assert.deepEqual(parseMarkdown(null), []);
  assert.deepEqual(parseInline(''), []);
  assert.equal(blocksToPlain([]), '');
});

test('looksStructured 用来判断"要不要走保排版这条路"', () => {
  assert.equal(looksStructured('# 标题\n正文'), true);
  assert.equal(looksStructured('| A | B |\n| --- | --- |'), true);
  assert.equal(looksStructured('- 甲\n- 乙'), true);
  assert.equal(looksStructured('这里是**重点**'), true);
  // 手写便条、收据：没有结构，Markdown 那套只会添乱
  assert.equal(looksStructured('今收到货款五千元整'), false);
  assert.equal(looksStructured('2026年1月1日\n张三'), false);
});

test('真实模型输出（合同）能解析出标题 + 表格', () => {
  // 这是线上 deepseek-flash 对 preview/fake-photo.jpg 的真实返回，去掉首尾空白
  const md = [
    '# 房屋租赁合同',
    '',
    '合同编号：2026-ZL-0088',
    '',
    '出租方（甲方）：张明  身份证号：3101***********1234',
    '',
    '| 项目 | 金额 | 备注 |',
    '| --- | --- | --- |',
    '| 月租金 | 人民币6500元 | 押一付三 |',
    '| 押金 | 人民币6500元 | 退租时结算 |',
    '',
    '甲方签字：__________  日期：2026年1月1日',
  ].join('\n');
  const b = parseMarkdown(md);
  assert.equal(b[0].type, 'heading');
  assert.equal(b[0].level, 1);
  const table = b.find((x) => x.type === 'table');
  assert.equal(table.rows.length, 2);
  const plain = blocksToPlain(b);
  assert.ok(plain.includes('房屋租赁合同') && plain.includes('押一付三'));
  // 打码号码里的星号是**原文**（3101***********1234），必须原样留着；
  // 要断言的是它没被解析成加粗——那一段只有一个 text 片段
  const idPara = b.find((x) => x.type === 'para' && inlineToPlain(x.inline).includes('3101'));
  assert.equal(idPara.inline.length, 1);
  assert.equal(idPara.inline[0].type, 'text');
});
