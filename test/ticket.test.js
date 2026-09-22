'use strict';
/**
 * bili_ticket 风控票据测试（mock fetch，零网络）
 * 覆盖：签名固定向量 / 内存与文件缓存 / 失败抛错 / httpJson -352 自动重试 / v_voucher 不重试
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../lib/api/client').setThrottle(false);
const { buildTicketSign, getBiliTicket, setDir, _resetTicketCache } = require('../lib/api/ticket');
const { httpJson } = require('../lib/api/client');

const jsonRes = obj => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-ticket-test-'));

test.beforeEach(() => {
  setDir(tmpDir);
  _resetTicketCache();
});
test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

test('buildTicketSign 固定向量', () => {
  assert.strictEqual(
    buildTicketSign(1700000000),
    'bb79f0d980ffbb51597aa1a3e8b55603025cc1322ac766f4c1a98852e6182514');
});

test('getBiliTicket：网络获取 + 内存缓存（第二次不再请求）', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return jsonRes({ code: 0, message: 'OK', data: { ticket: 'tk-1', ttl: 100 } });
  });
  assert.strictEqual(await getBiliTicket('buvid3=x'), 'tk-1');
  assert.strictEqual(await getBiliTicket('buvid3=x'), 'tk-1');
  assert.strictEqual(calls, 1, '内存缓存命中不应再请求');
});

test('getBiliTicket：文件缓存跨实例复用（keepFile）', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return jsonRes({ code: 0, message: 'OK', data: { ticket: 'tk-file', ttl: 100 } });
  });
  assert.strictEqual(await getBiliTicket('buvid3=x'), 'tk-file');
  _resetTicketCache({ keepFile: true });
  assert.strictEqual(await getBiliTicket('buvid3=x'), 'tk-file');
  assert.strictEqual(calls, 1, '文件缓存命中不应再请求');
});

test('getBiliTicket：接口失败抛错', async t => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes({ code: -352, message: '风控' }));
  await assert.rejects(() => getBiliTicket('buvid3=x'), /获取 bili_ticket 失败/);
});

test('httpJson：-352 自动获取 bili_ticket 并重试一次', async t => {
  const reqs = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    reqs.push({ url: String(url), method: opts.method || 'GET', cookie: opts.headers?.Cookie || '' });
    if (String(url).includes('GenWebTicket')) {
      return jsonRes({ code: 0, message: 'OK', data: { ticket: 'tk-retry', ttl: 100 } });
    }
    const biz = reqs.filter(r => !r.url.includes('GenWebTicket'));
    if (biz.length === 1) return jsonRes({ code: -352, message: '风控校验失败' });
    return jsonRes({ code: 0, message: 'OK', data: { ok: true } });
  });
  const d = await httpJson('https://api.bilibili.com/x/v2/reply?type=11&oid=1', { cookie: 'SESSDATA=s; buvid3=b' });
  assert.strictEqual(d.code, 0);
  assert.strictEqual(reqs.length, 3, '业务请求 → 票据请求 → 业务重试');
  assert.ok(reqs[1].url.includes('GenWebTicket'));
  assert.strictEqual(reqs[1].method, 'POST', 'GenWebTicket 必须用 POST');
  assert.ok(reqs[2].cookie.includes('bili_ticket=tk-retry'), '重试必须携带票据');
});

test('httpJson：v_voucher 验证码风控不触发票据重试', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return jsonRes({ code: -352, message: '风控校验失败', data: { v_voucher: 'voucher_x' } });
  });
  const d = await httpJson('https://api.bilibili.com/x/v2/reply?type=11&oid=1', { cookie: 'buvid3=b' });
  assert.strictEqual(d.code, -352);
  assert.strictEqual(calls, 1, '验证码风控重试无益，不应额外请求');
});

test('httpJson：网络异常自动重试一次', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return jsonRes({ code: 0, message: 'OK', data: { ok: true } });
  });
  const d = await httpJson('https://api.bilibili.com/x/v2/reply?type=11&oid=1', { throttle: false });
  assert.strictEqual(d.code, 0);
  assert.strictEqual(calls, 2);
});
