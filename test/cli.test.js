'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, buildConfig } = require('../cli');

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
