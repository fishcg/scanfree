/**
 * 模块连线检查：确认"谁 import 了什么"和"谁 export 了什么"对得上。
 *
 * 为什么需要这个：浏览器里 ES 模块是靠静态图一次性加载的，
 * 任何一个 import 的名字在原模块里不存在，**整张图都会加载失败**——
 * 用户看到的是一个全白的页面和一行控制台报错，连"哪里错了"都很难猜。
 * 而单元测试只 import 了少数几个纯函数模块，覆盖不到这条线。
 * 这个脚本把整张图扫一遍，把这类错误在打开浏览器之前就挡掉。
 *
 * 检查项：
 *  1. import 的每个名字在目标模块里真的有 export（含 `export { a as b }` 与默认导出）
 *  2. import 的目标文件真的存在
 *  3. 有没有重复的导出名
 *  4. 每个模块能否被解析（语法层面由 node --check 负责，这里只管连线）
 *
 * 运行：node tools/check-imports.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = path.join(root, 'js');

/** 取出一个模块所有导出的名字 */
function exportedNames(code) {
  const names = new Set();
  // export function foo / export async function foo / export class Foo / export const foo / export let
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // export { a, b as c }
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      names.add(as ? as[1] : t);
    }
  }
  // export default
  if (/^export\s+default\b/m.test(code)) names.add('default');
  // export * from './x.js' → 把对方的导出也搬过来（本项目没用，但顺手支持）
  for (const m of code.matchAll(/^export\s*\*\s*from\s*['"]([^'"]+)['"]/gm)) {
    names.add(`*${m[1]}`);
  }
  return names;
}

/** 取出一个模块所有 import 的名字与目标 */
function importsOf(code) {
  const out = [];
  const re = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(code))) {
    const clause = m[1].trim();
    const target = m[2];
    if (!target.startsWith('.')) continue; // 裸模块名（浏览器里不会出现）
    const names = [];
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        // `a as b` → 真正要导入的名字是 a
        const as = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+/);
        names.push(as ? as[1] : t);
      }
    }
    const beforeBrace = clause.replace(/\{[\s\S]*\}/, '').replace(/,\s*$/, '').trim();
    if (beforeBrace && !beforeBrace.startsWith('*')) names.push('default'); // import Foo from
    if (/^\*\s+as\s+/.test(clause)) names.push('*');
    out.push({ target, names, raw: clause });
  }
  return out;
}

const files = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'));
const codes = new Map(files.map((f) => [f, fs.readFileSync(path.join(jsDir, f), 'utf8')]));
const exportsOf = new Map(files.map((f) => [f, exportedNames(codes.get(f))]));

const problems = [];

// 3. 重复导出名（同一个名字导出两次，浏览器会报 duplicate export）
for (const [file, code] of codes) {
  const seen = new Map();
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  }
  for (const [name, n] of seen) {
    if (n > 1) problems.push(`${file}: 导出了两次 ${name}`);
  }
}

// 1 & 2. import 的名字与目标是否存在
let checked = 0;
for (const [file, code] of codes) {
  for (const imp of importsOf(code)) {
    const target = path.basename(imp.target);
    if (!target.endsWith('.js')) continue; // 只查 js 模块
    if (!codes.has(target)) {
      problems.push(`${file}: import 的 ${imp.target} 不存在`);
      continue;
    }
    const avail = exportsOf.get(target);
    for (const name of imp.names) {
      checked++;
      if (name === '*') continue;
      if (!avail.has(name)) {
        problems.push(`${file}: 从 ${target} 导入的 ${name} 并不存在（该模块导出：${[...avail].filter((x) => !x.startsWith('*')).join(', ') || '无'}）`);
      }
    }
  }
}

// 反向检查：导出了但从没被任何模块 import 的名字（多数是死代码，只提示不报错）
const unusedExports = [];
for (const [file, names] of exportsOf) {
  for (const name of names) {
    if (name === 'default' || name.startsWith('*')) continue;
    let used = false;
    for (const [other, code] of codes) {
      if (other === file) continue;
      if (importsOf(code).some((i) => path.basename(i.target) === file && i.names.includes(name))) used = true;
    }
    // 测试文件也会 import
    for (const t of fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.mjs'))) {
      const tc = fs.readFileSync(path.join(root, 'tests', t), 'utf8');
      if (importsOf(tc).some((i) => path.basename(i.target) === file && i.names.includes(name))) used = true;
    }
    if (!used) unusedExports.push(`${file}: ${name}`);
  }
}

console.log(`检查了 ${files.length} 个模块、${checked} 处 import。`);
if (problems.length) {
  console.error(`\n✖ 发现 ${problems.length} 个问题：`);
  for (const p of problems) console.error('  - ' + p);
  process.exitCode = 1;
} else {
  console.log('✔ import / export 全部对得上。');
}
if (unusedExports.length) {
  console.log(`\n提示：${unusedExports.length} 个导出没有任何模块使用（可能是死代码）：`);
  for (const u of unusedExports) console.log('  · ' + u);
}
