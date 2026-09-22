'use strict';
/**
 * 图片下载失败日志测试（mock fetch + mock logger，零网络）
 * 覆盖：失败降级返回 null、告警去重、失败不缓存（可重试）、成功不告警、缩略图尺寸计算
 */
const test = require('node:test');
const assert = require('node:assert');
const logger = require('../lib/logger');
const { fetchBuf, bufCache, imgCache, fitSinglePic } = require('../lib/card/image');

function freshUrl() { return 'https://i0.hdslb.com/bfs/test/' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.png'; }

test('下载失败：返回 null、告警一次、不缓存（同 URL 再次可重试且不重复告警）', async (t) => {
  let fetchCalls = 0, warned = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetchCalls++; throw new Error('network down'); });
  t.mock.method(logger, 'warn', () => { warned++; });
  bufCache.clear(); imgCache.clear();

  const url = freshUrl();
  assert.strictEqual(await fetchBuf(url), null, '失败应降级返回 null');
  assert.strictEqual(warned, 1, '首次失败告警一次');

  assert.strictEqual(await fetchBuf(url), null, '再次失败仍返回 null（未缓存，可重试）');
  // 每次下载内置重试 1 次（2 次 fetch），两次调用共 4 次
  assert.strictEqual(fetchCalls, 4, '失败不缓存 → 重新发起下载（含内置重试）');
  assert.strictEqual(warned, 1, '同一 URL 告警去重（不刷屏）');
});

test('HTTP 非 2xx 失败同样降级且告警', async (t) => {
  let warned = 0;
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }));
  t.mock.method(logger, 'warn', () => { warned++; });
  bufCache.clear(); imgCache.clear();

  assert.strictEqual(await fetchBuf(freshUrl()), null);
  assert.strictEqual(warned, 1);
});

test('下载成功：返回 buffer、不告警', async (t) => {
  let warned = 0;
  const buf = Buffer.alloc(200, 1); // 200B，满足 >100 校验
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  }));
  t.mock.method(logger, 'warn', () => { warned++; });
  bufCache.clear(); imgCache.clear();

  const got = await fetchBuf(freshUrl());
  assert.ok(got && got.length === 200, '应返回下载内容');
  assert.strictEqual(warned, 0, '成功路径不告警');
});

test('fitSinglePic：不超过原图宽度（小图不放大）', () => {
  assert.deepStrictEqual(fitSinglePic(100, 50, 576, 480), { w: 100, h: 50 });
  assert.deepStrictEqual(fitSinglePic(200, 100, 576, 480), { w: 200, h: 100 });
});

test('fitSinglePic：大图限宽、超长限高', () => {
  assert.deepStrictEqual(fitSinglePic(4000, 3000, 576, 480), { w: 320, h: 240 });
  assert.deepStrictEqual(fitSinglePic(1000, 4000, 576, 480), { w: 120, h: 480 });
});

test('fitSinglePic：尺寸未知时返回占位比例', () => {
  assert.deepStrictEqual(fitSinglePic(null, null, 576, 480), { w: 320, h: 240 });
});
