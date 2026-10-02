'use strict';
/**
 * buvid 设备指纹持久化测试（mock fetch，零网络）
 *
 * 背景：风控按 buvid 维度关联请求。cron/--once 每次都是新进程，
 * 若每次重新调 SPI 取新指纹，等于「每次来访换一台设备」——反而更可疑。
 * 覆盖：内存缓存 / 文件跨实例复用 / 过期重取 / 文件损坏回退 /
 *       失败抛错 / 网络失败降级复用过期指纹 / 降级后的 SPI 冷却
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const client = require('../lib/api/client');
client.setThrottle(false); // mock fetch 无真实请求，关闭节流避免拖慢
const { anonCookie, setBuvidDir, _resetBuvidCache, BUVID_DEFAULT_TTL_MS } = client;

const jsonRes = obj => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
const spiOk = (b3, b4) => jsonRes({ code: 0, message: 'OK', data: { b_3: b3, b_4: b4 } });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-buvid-test-'));
const buvidFile = () => path.join(tmpDir, 'buvid.json');

/** 预置一个已过期的指纹文件，用于验证降级与重取分支 */
function writeExpiredBuvid(cookie = 'buvid3=stale3; buvid4=stale4') {
  fs.writeFileSync(buvidFile(), JSON.stringify({ cookie, expireAt: Date.now() - 1000 }), 'utf-8');
}

test.beforeEach(() => {
  setBuvidDir(tmpDir);
  _resetBuvidCache();
});
test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

test('anonCookie：网络获取 + 内存缓存（同一进程内只请求一次 SPI）', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return spiOk('b3-net', 'b4-net'); });
  assert.strictEqual(await anonCookie(), 'buvid3=b3-net; buvid4=b4-net');
  assert.strictEqual(await anonCookie(), 'buvid3=b3-net; buvid4=b4-net');
  assert.strictEqual(calls, 1, '内存缓存命中不应再请求 SPI');
});

test('anonCookie：写盘并落 30 天 TTL（供下次进程复用）', async t => {
  t.mock.method(globalThis, 'fetch', async () => spiOk('b3-t', 'b4-t'));
  await anonCookie();
  const j = JSON.parse(fs.readFileSync(buvidFile(), 'utf-8'));
  assert.strictEqual(j.cookie, 'buvid3=b3-t; buvid4=b4-t');
  const ttl = j.expireAt - Date.now();
  assert.ok(ttl > BUVID_DEFAULT_TTL_MS - 5 * 60 * 1000 && ttl <= BUVID_DEFAULT_TTL_MS,
    `TTL 应接近 30 天，实际 ${Math.round(ttl / 86400000)} 天`);
});

test('anonCookie：文件缓存跨实例复用（cron 每次新进程不再换设备）', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return spiOk('b3-file', 'b4-file'); });
  assert.strictEqual(await anonCookie(), 'buvid3=b3-file; buvid4=b4-file');
  _resetBuvidCache({ keepFile: true }); // 模拟进程重启：内存清空，文件保留
  assert.strictEqual(await anonCookie(), 'buvid3=b3-file; buvid4=b4-file');
  assert.strictEqual(calls, 1, '文件缓存命中不应再请求 SPI');
});

test('anonCookie：文件过期 → 重新请求 SPI 并覆盖', async t => {
  writeExpiredBuvid();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return spiOk('b3-new', 'b4-new'); });
  assert.strictEqual(await anonCookie(), 'buvid3=b3-new; buvid4=b4-new');
  assert.strictEqual(calls, 1, '过期指纹应触发一次 SPI');
  assert.strictEqual(JSON.parse(fs.readFileSync(buvidFile(), 'utf-8')).cookie, 'buvid3=b3-new; buvid4=b4-new');
});

test('anonCookie：文件损坏 → 回退网络', async t => {
  fs.writeFileSync(buvidFile(), '{ not json', 'utf-8');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return spiOk('b3-fix', 'b4-fix'); });
  assert.strictEqual(await anonCookie(), 'buvid3=b3-fix; buvid4=b4-fix');
  assert.strictEqual(calls, 1);
});

test('anonCookie：SPI 失败且无文件缓存 → 抛错', async t => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes({ code: -352, message: '风控' }));
  await assert.rejects(() => anonCookie(), /获取 buvid 失败/);
});

test('anonCookie：SPI 网络失败但有过期指纹 → 降级复用（不让整轮 cron 直接失败）', async t => {
  writeExpiredBuvid('buvid3=stale3; buvid4=stale4');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('fetch failed'); });
  assert.strictEqual(await anonCookie(), 'buvid3=stale3; buvid4=stale4');
  assert.strictEqual(calls, 2, '网络异常本身会重试 1 次（业务层既有行为）');
});

test('anonCookie：降级复用后有冷却，不会连续打 SPI', async t => {
  writeExpiredBuvid('buvid3=cool3; buvid4=cool4');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('fetch failed'); });
  assert.strictEqual(await anonCookie(), 'buvid3=cool3; buvid4=cool4');
  const afterFirst = calls;
  assert.strictEqual(await anonCookie(), 'buvid3=cool3; buvid4=cool4');
  assert.strictEqual(await anonCookie(), 'buvid3=cool3; buvid4=cool4');
  assert.strictEqual(calls, afterFirst, '冷却窗口内不应再次尝试 SPI');
});

test('anonCookie：并发首调只发一次 SPI 请求（in-flight 去重）', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    await new Promise(r => setImmediate(r)); // 拉长窗口制造并发
    return spiOk('b3-conc', 'b4-conc');
  });
  const results = await Promise.all([anonCookie(), anonCookie(), anonCookie()]);
  assert.deepStrictEqual(results, Array(3).fill('buvid3=b3-conc; buvid4=b4-conc'));
  assert.strictEqual(calls, 1, '并发首调应共用同一次 SPI 请求');
});
