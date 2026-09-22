'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseArgs, buildConfig, DEFAULT_OUT_DIR } = require('../lib/args');
const PROJECT_OUT = path.join(path.resolve(__dirname, '..'), 'output');

test('普通命令未显式 --up-top：旧配置缺 upTop 字段时默认关闭（回归）', () => {
  const args = parseArgs(['--oid', '404135596', '--once']);
  assert.strictEqual(args.upTop, null);
  const cfg = buildConfig(args, {});
  assert.strictEqual(cfg.upTop, 0);
  assert.strictEqual(cfg.oid, '404135596');
});

test('buildConfig 无已保存配置且未显式 --up-top：默认关闭', () => {
  const cfg = buildConfig(parseArgs(['--oid', '404135596']));
  assert.strictEqual(cfg.upTop, 0);
});

test('--up-top 不带数字：默认 TOP 10', () => {
  const args = parseArgs(['--oid', '404135596', '--up-top']);
  assert.strictEqual(args.upTop, 10);
  assert.strictEqual(buildConfig(args, {}).upTop, 10);
});

test('--up-top N：使用指定 N，0 也可显式关闭', () => {
  assert.strictEqual(parseArgs(['--up-top', '3']).upTop, 3);
  assert.strictEqual(parseArgs(['--up-top', '0']).upTop, 0);
});

test('已保存的 upTop 配置在未传参数时保留', () => {
  const cfg = buildConfig(parseArgs(['--oid', '404135596']), { upTop: 5 });
  assert.strictEqual(cfg.upTop, 5);
});

test('--version / -V 解析', () => {
  assert.strictEqual(parseArgs(['--version']).version, true);
  assert.strictEqual(parseArgs(['-V']).version, true);
  assert.strictEqual(parseArgs(['--oid', '404135596']).version, false);
});

test('--max-dyns 非法值回退默认（NaN/0/负数不作为上限）', () => {
  assert.strictEqual(parseArgs(['--max-dyns', 'abc']).maxDyns, null);
  assert.strictEqual(parseArgs(['--max-dyns', '0']).maxDyns, null);
  assert.strictEqual(parseArgs(['--max-dyns', '-3']).maxDyns, null);
  assert.strictEqual(parseArgs(['--max-dyns', '50']).maxDyns, 50);
  assert.strictEqual(buildConfig(parseArgs(['--max-dyns', 'abc']), {}).maxDyns, Infinity);
});

test('--scale / --no-emoji 解析与默认值', () => {
  assert.strictEqual(parseArgs(['--scale', '1']).scale, 1);
  assert.strictEqual(parseArgs(['--scale', '3']).scale, 3);
  assert.strictEqual(parseArgs(['--scale', '9']).scale, null, '越界回退默认');
  assert.strictEqual(parseArgs(['--scale', 'x']).scale, null);
  assert.strictEqual(buildConfig(parseArgs(['--scale', 'x']), {}).scale, 2);
  assert.strictEqual(buildConfig(parseArgs(['--scale', '1']), {}).scale, 1);
  assert.strictEqual(parseArgs(['--no-emoji']).noEmoji, true);
  assert.strictEqual(parseArgs([]).noEmoji, false);
});

test('--scale 支持小数倍率（0.5~6）', () => {
  assert.strictEqual(parseArgs(['--scale', '1.5']).scale, 1.5);
  assert.strictEqual(parseArgs(['--scale', '0.5']).scale, 0.5);
  assert.strictEqual(parseArgs(['--scale', '6']).scale, 6);
  assert.strictEqual(parseArgs(['--scale', '0.4']).scale, null);
  assert.strictEqual(parseArgs(['--scale', '6.5']).scale, null);
  assert.strictEqual(buildConfig(parseArgs(['--scale', '1.5']), {}).scale, 1.5);
  assert.strictEqual(buildConfig(parseArgs([]), { scale: 2.5 }).scale, 2.5, '保存的小数倍率有效');
  assert.strictEqual(buildConfig(parseArgs([]), { scale: 99 }).scale, 2, '保存的非法倍率回退 2');
});

test('--width 自定义输出宽度且优先于 --scale', () => {
  assert.strictEqual(parseArgs(['--width', '1360']).width, 1360);
  assert.strictEqual(parseArgs(['--width', '340']).width, 340);
  assert.strictEqual(parseArgs(['--width', '4080']).width, 4080);
  assert.strictEqual(parseArgs(['--width', '339']).width, null);
  assert.strictEqual(parseArgs(['--width', '4081']).width, null);
  assert.strictEqual(parseArgs(['--width', 'abc']).width, null);
  assert.strictEqual(buildConfig(parseArgs(['--width', '2040']), {}).scale, 3);
  assert.strictEqual(buildConfig(parseArgs(['--width', '680']), {}).scale, 1);
  assert.strictEqual(buildConfig(parseArgs(['--width', '1360', '--scale', '1']), {}).scale, 2, '--width 最高优先');
});

// ====== 输出目录：默认跟随项目目录（与 cwd 无关） ======
test('默认输出目录 = 项目目录/output（常量与 buildConfig 一致）', () => {
  assert.strictEqual(DEFAULT_OUT_DIR, PROJECT_OUT);
  assert.strictEqual(buildConfig(parseArgs([]), {}).outDir, PROJECT_OUT);
  assert.strictEqual(buildConfig(parseArgs(['--oid', '404135596']), {}).outDir, PROJECT_OUT);
});

test('旧配置遗留的 <任意目录>/output 默认值自动迁移到项目目录', () => {
  // 历史版本保存的是 cwd/output 绝对路径（未标记自定义）
  assert.strictEqual(buildConfig(parseArgs([]), { outDir: 'C:/projects/legacy-app/output' }).outDir, PROJECT_OUT);
  assert.strictEqual(buildConfig(parseArgs([]), { outDir: '/opt/legacy-app/output' }).outDir, PROJECT_OUT);
});

test('自定义输出目录保留；显式 --out 最高优先', () => {
  // 非 output 结尾 → 视为用户自定义，保留
  assert.strictEqual(buildConfig(parseArgs([]), { outDir: 'D:/cards' }).outDir, 'D:/cards');
  assert.strictEqual(buildConfig(parseArgs([]), { outDir: 'relative-cards' }).outDir, 'relative-cards');
  // 带自定义标记的 output 目录也保留
  assert.strictEqual(buildConfig(parseArgs([]), { outDir: 'D:/cards/output', outDirCustom: true }).outDir, 'D:/cards/output');
  // --out 覆盖一切
  assert.strictEqual(buildConfig(parseArgs(['--out', 'mycards']), { outDir: 'D:/cards', outDirCustom: true }).outDir, 'mycards');
});
