'use strict';
/**
 * 监控错误分类测试（纯函数，零网络）
 * 覆盖：-101 登录态 / -352·-412·-799 风控 / 其他错误通用分支
 */
const test = require('node:test');
const assert = require('node:assert');
const { classifyError } = require('../lib/watcher');
const { BiliError } = require('../lib/api');

test('classifyError：Cookie 失效 (-101) → auth', () => {
  assert.strictEqual(classifyError(new BiliError('Cookie 已失效', -101)), 'auth');
});

test('classifyError：风控码 (-352 / -412 / -799) → risk', () => {
  assert.strictEqual(classifyError(new BiliError('风控', -352)), 'risk');
  assert.strictEqual(classifyError(new BiliError('banned', -412)), 'risk');
  assert.strictEqual(classifyError(new BiliError('频繁', -799)), 'risk');
});

test('classifyError：其他 BiliError 码 → other', () => {
  assert.strictEqual(classifyError(new BiliError('未找到', -404)), 'other');
  assert.strictEqual(classifyError(new BiliError('无 code')), 'other');
});

test('classifyError：非 BiliError 错误 → other', () => {
  assert.strictEqual(classifyError(new Error('网络超时')), 'other');
  assert.strictEqual(classifyError('字符串错误'), 'other');
  assert.strictEqual(classifyError(null), 'other');
});
