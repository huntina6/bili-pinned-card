'use strict';
/**
 * 请求节流测试：URL 档位匹配（细粒度优先）、正态分布边界与截断、开关语义
 */
const test = require('node:test');
const assert = require('node:assert');
const { pickProfile, computeDelay, setRng, setThrottle, _throttleDelay } = require('../lib/api/client');

test.afterEach(() => {
  setRng(null);
  setThrottle(true);
});

test('pickProfile 按 URL 分档（细粒度优先）', () => {
  const sub = pickProfile('https://api.bilibili.com/x/v2/reply/reply?type=11&root=1');
  const list = pickProfile('https://api.bilibili.com/x/v2/reply/wbi/main?mode=3');
  const dyn = pickProfile('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=1');
  const other = pickProfile('https://api.bilibili.com/x/web-interface/nav');
  assert.strictEqual(sub.mean, 2000, '子回复翻页走保守档');
  assert.strictEqual(list.mean, 1500, '评论列表（含 wbi/main）');
  assert.strictEqual(dyn.mean, 3000, '动态检索最保守');
  assert.strictEqual(other.mean, 1500, '默认档');
  // 细粒度优先：reply/reply 不应被 reply 前缀截走
  assert.ok(sub.mean > list.mean, '子回复档必须比评论列表更保守');
});

test('computeDelay 截断到区间边界（固定 RNG）', () => {
  setRng(() => 0.5); // Box-Muller → 标准正态 = ±1 方向（u=v=0.5 → cos(π)=-1）
  const d = computeDelay('https://api.bilibili.com/x/v2/reply?type=11');
  assert.ok(d >= 1000 && d <= 2500, `应落在 [1000,2500]，实际 ${d}`);
  assert.strictEqual(d, 1000, '均值-标准差=1050 应被截断到 1000 下界');
});

test('computeDelay 采样均值逼近配置均值、不越界', () => {
  const N = 5000;
  let sum = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < N; i++) {
    const d = computeDelay('https://api.bilibili.com/x/v2/reply/wbi/main?oid=1');
    sum += d; min = Math.min(min, d); max = Math.max(max, d);
  }
  const avg = sum / N;
  assert.ok(Math.abs(avg - 1500) < 150, `均值 ${avg.toFixed(0)} 应接近 1500`);
  assert.ok(min >= 1000 && max <= 2500, `范围 [${min.toFixed(0)},${max.toFixed(0)}] 越界`);
});

test('setThrottle(false) 语义：_throttleDelay 立即返回', async () => {
  setThrottle(false);
  const t0 = Date.now();
  await _throttleDelay('https://api.bilibili.com/x/v2/reply');
  assert.ok(Date.now() - t0 < 50, '关闭后不应等待');
});

test('setThrottle(true) + 固定 RNG：_throttleDelay 按下界等待', async () => {
  setThrottle(true);
  setRng(() => 0.5); // 评论档下界 1000ms
  const t0 = Date.now();
  await _throttleDelay('https://api.bilibili.com/x/v2/reply?type=11');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 950, `应等待约 1000ms，实际 ${elapsed}ms`);
});
