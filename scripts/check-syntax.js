'use strict';
/**
 * 全量语法检查（npm run check）
 * 遍历 cli.js + lib/ + test/ + scripts/ 下全部 .js，逐个执行 `node --check`。
 * 取代此前手工维护 40 余条 node --check 的写法 —— 新增文件自动纳入，不会漏检。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENTRIES = ['cli.js', 'lib', 'test', 'scripts'];

/** 递归收集 .js 文件（跳过 node_modules / output 等非源码目录） */
function collect(target) {
  const abs = path.join(ROOT, target);
  const st = fs.statSync(abs);
  if (st.isFile()) return abs.endsWith('.js') ? [abs] : [];
  return fs.readdirSync(abs)
    .filter(name => name !== 'node_modules')
    .flatMap(name => collect(path.join(target, name)));
}

const files = [...new Set(ENTRIES.flatMap(collect))].sort();
let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    process.stdout.write(`✗ ${path.relative(ROOT, file)}\n${r.stderr || ''}`);
  }
}
if (failed) {
  process.stdout.write(`✗ 语法检查失败: ${failed}/${files.length}\n`);
  process.exit(1);
}
process.stdout.write(`✔ 语法检查通过: ${files.length} 个文件\n`);
