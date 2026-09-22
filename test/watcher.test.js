'use strict';
/**
 * 监控错误分类测试（纯函数，零网络）
 * 覆盖：-101 登录态 / -352·-403·-412·-509·-799 风控与签名 / -658 Token 过期 / 其他错误通用分支
 */
const test = require('node:test');
const assert = require('node:assert');
const { classifyError, computeBackoffMs, MAX_BACKOFF_MS } = require('../lib/watcher');
const { BiliError, RISK_CODES } = require('../lib/api');

test('classifyError：Cookie 失效 (-101) → auth', () => {
  assert.strictEqual(classifyError(new BiliError('Cookie 已失效', -101)), 'auth');
});

test('classifyError：风控码 (-352 / -412 / -799) → risk', () => {
  assert.strictEqual(classifyError(new BiliError('风控', -352)), 'risk');
  assert.strictEqual(classifyError(new BiliError('banned', -412)), 'risk');
  assert.strictEqual(classifyError(new BiliError('频繁', -799)), 'risk');
});

test('classifyError：-403（WBI 签名缺失/错误或权限不足）→ risk', () => {
  assert.strictEqual(classifyError(new BiliError('访问权限不足', -403)), 'risk');
});

test('classifyError：-509（熔断）→ risk', () => {
  assert.strictEqual(classifyError(new BiliError('熔断', -509)), 'risk');
});

test('classifyError：-658（Token 过期）→ expired', () => {
  assert.strictEqual(classifyError(new BiliError('Token 过期', -658)), 'expired');
});

test('RISK_CODES 与 classifyError 判定保持一致', () => {
  for (const code of RISK_CODES) {
    assert.strictEqual(classifyError(new BiliError('x', code)), 'risk', `code ${code} 应为 risk`);
  }
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

// ====== 风控自适应退避（computeBackoffMs） ======
test('computeBackoffMs：指数退避 1x/2x/4x/8x（rng=0.5 无抖动）', () => {
  const r = () => 0.5;
  assert.strictEqual(computeBackoffMs(60, 1, r), 60000);
  assert.strictEqual(computeBackoffMs(60, 2, r), 120000);
  assert.strictEqual(computeBackoffMs(60, 3, r), 240000);
  assert.strictEqual(computeBackoffMs(60, 4, r), 480000);
  assert.strictEqual(computeBackoffMs(60, 9, r), 480000, '指数封顶 8x');
});

test('computeBackoffMs：10 分钟上限 + ±20% 抖动边界', () => {
  assert.strictEqual(computeBackoffMs(300, 2, () => 0.5), MAX_BACKOFF_MS, '300s×2=600s 恰好封顶');
  assert.strictEqual(computeBackoffMs(300, 5, () => 0.5), MAX_BACKOFF_MS);
  assert.strictEqual(computeBackoffMs(60, 1, () => 0), 48000);
  assert.strictEqual(computeBackoffMs(60, 1, () => 1), 72000);
});
