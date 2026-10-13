/**
 * ZIP 打包器测试。
 *
 * 这里踩过一个真实的坑，值得记下来：
 * macOS 自带的 unzip 是 2009 年的 Info-ZIP 6.00，**它不认 EFS（UTF-8 文件名）标志位**，
 * 遇到中文名会按 CP437 转换，直接报 "Illegal byte sequence" 解不出来。
 * 我们的 zip 本身是对的（Python zipfile / Finder / 7-Zip 都能正常读），
 * 所以测试分成两路：
 *   1. 用 unzip 校验 CRC 与解压内容 —— 文件名用 ASCII，这是最实际的场景；
 *   2. 中文名只断言头部字节与标志位（EFS 0x0800 + UTF-8 解码一致）——
 *      这正是所有规范读取器判断编码的依据。
 * 结论也影响了产品决策：App 导出的压缩包文件名一律用 ASCII（scan-01.jpg），
 * 避免用户拿到手在旧工具上解不开。
 *
 * 运行：node --test tests/zip.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildZip, crc32 } from '../js/zip.js';

const enc = new TextEncoder();
const hasUnzip = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('crc32 与标准测试向量一致', async () => {
  // "123456789" 的 CRC32 是公开标准值
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(enc.encode('')), 0x00000000);
});

test('头部结构：本地文件头 → 数据 → 中央目录 → 结束记录', async () => {
  const zip = await buildZip([{ name: 'a.txt', data: enc.encode('hello') }]);
  const b = Buffer.from(zip);
  assert.equal(b.readUInt32LE(0), 0x04034b50, '应以本地文件头开始');
  assert.equal(b.readUInt32LE(b.length - 22), 0x06054b50, '应以中央目录结束记录结尾');
  assert.equal(b.readUInt16LE(b.length - 22 + 10), 1, '应记录 1 个条目');
});

test('中央目录偏移与大小自洽，且指向真正的中央目录', async () => {
  const files = ['one.jpg', 'two.jpg', 'three.txt'].map((name) => ({ name, data: enc.encode(name.repeat(3)) }));
  const b = Buffer.from(await buildZip(files));
  const eocd = b.length - 22;
  const count = b.readUInt16LE(eocd + 10);
  const cdSize = b.readUInt32LE(eocd + 12);
  const cdOffset = b.readUInt32LE(eocd + 16);

  assert.equal(count, 3);
  assert.ok(cdOffset > 0 && cdOffset < eocd, '中央目录应在文件内部');
  assert.equal(cdOffset + cdSize, eocd, '中央目录应恰好结束在 EOCD 之前');
  assert.equal(b.readUInt32LE(cdOffset), 0x02014b50, '偏移处应是中央目录头');

  // 顺着中央目录走一遍，条目数应与声明一致
  let p = cdOffset;
  let seen = 0;
  while (b.readUInt32LE(p) === 0x02014b50) {
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    assert.equal(b.subarray(p + 46, p + 46 + nameLen).toString('utf8'), files[seen].name);
    p += 46 + nameLen + extraLen + commentLen;
    seen++;
  }
  assert.equal(seen, 3, '中央目录条目数应与 /Count 一致');
  assert.equal(p, eocd, '应恰好走到 EOCD');
});

test('中文文件名：EFS 标志位置位且名称按 UTF-8 原样存储', async () => {
  const name = '扫描件_01.jpg';
  const b = Buffer.from(await buildZip([{ name, data: enc.encode('X') }]));

  assert.equal(b.readUInt16LE(6) & 0x0800, 0x0800, '本地头应声明 UTF-8 文件名');
  const localNameLen = b.readUInt16LE(26);
  assert.equal(b.subarray(30, 30 + localNameLen).toString('utf8'), name, '本地头名称应为原始中文');

  const cdOffset = b.readUInt32LE(b.length - 22 + 16);
  assert.equal(b.readUInt16LE(cdOffset + 8) & 0x0800, 0x0800, '中央目录同样应置位');
  const cdNameLen = b.readUInt16LE(cdOffset + 28);
  assert.equal(b.subarray(cdOffset + 46, cdOffset + 46 + cdNameLen).toString('utf8'), name);
});

test('能存二进制且内容零改动', async () => {
  // 用 JPEG 真实字节（含 0x00、0xFF），验证不会被当成文本处理
  const jpeg = new Uint8Array(readFileSync(new URL('./fixtures/scan-sample.jpg', import.meta.url)));
  const b = Buffer.from(await buildZip([{ name: 'scan-01.jpg', data: jpeg }]));
  const crcAt = b.readUInt32LE(14);
  assert.equal(crcAt, crc32(jpeg), '存储的 CRC 应与源数据一致');
  assert.equal(b.readUInt32LE(18), jpeg.length, '压缩后大小应等于原始大小（store 模式）');
  const dataOffset = 30 + b.readUInt16LE(26) + b.readUInt16LE(28);
  assert.deepEqual(new Uint8Array(b.subarray(dataOffset, dataOffset + jpeg.length)), jpeg);
});

test('系统 unzip 能校验 CRC 并原样解出（ASCII 文件名）', async (t) => {
  if (!hasUnzip) {
    t.skip('本机没有 unzip');
    return;
  }
  const files = [
    { name: 'scan-01.jpg', data: enc.encode('JPEG-DATA-1') },
    { name: 'scan-02.jpg', data: enc.encode('JPEG-DATA-2') },
    { name: 'readme.txt', data: enc.encode('hello world') },
  ];

  const dir = mkdtempSync(join(tmpdir(), 'scanfree-zip-'));
  try {
    const zipPath = join(dir, 'out.zip');
    writeFileSync(zipPath, await buildZip(files));

    // -t 会逐个文件校验 CRC，任何字节错误都会以非 0 退出
    assert.match(execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' }), /No errors detected/);

    execFileSync('unzip', ['-q', '-o', zipPath, '-d', join(dir, 'out')]);
    for (const f of files) {
      assert.deepEqual(new Uint8Array(readFileSync(join(dir, 'out', f.name))), f.data, `${f.name} 内容应一致`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('用 Python zipfile 交叉验证中文名（无 python3 时跳过）', async (t) => {
  let py = null;
  for (const c of ['python3', '/usr/bin/python3']) {
    try {
      execFileSync(c, ['-c', 'pass'], { stdio: 'ignore' });
      py = c;
      break;
    } catch {
      /* 继续找 */
    }
  }
  if (!py) {
    t.skip('本机没有 python3');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'scanfree-zip-py-'));
  try {
    const zipPath = join(dir, 't.zip');
    writeFileSync(zipPath, await buildZip([{ name: '体检报告_第1页.jpg', data: enc.encode('CONTENT') }]));
    const out = execFileSync(
      py,
      [
        '-c',
        'import sys,zipfile;' +
          'z=zipfile.ZipFile(sys.argv[1]);' +
          'print(z.namelist()[0]);print(z.testzip());print(z.read(z.namelist()[0]).decode())',
        zipPath,
      ],
      { encoding: 'utf8' }
    ).trim().split('\n');
    assert.equal(out[0], '体检报告_第1页.jpg', 'Python 能正确读出中文名');
    assert.equal(out[1], 'None', 'testzip() 返回 None 表示所有 CRC 校验通过');
    assert.equal(out[2], 'CONTENT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空文件列表也能生成合法的空 zip', async () => {
  const b = Buffer.from(await buildZip([]));
  assert.equal(b.length, 22, '空 zip 就是一条 22 字节的结束记录');
  assert.equal(b.readUInt32LE(0), 0x06054b50);
});
