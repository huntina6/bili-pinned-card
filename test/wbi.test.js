'use strict';
/**
 * WBI 签名 + 评论拉取升级测试（mock 全局 fetch，零网络）
 * 覆盖：getMixinKey 固定向量 / wbiQuery 排序与 md5 / pagination_str / isDegraded /
 *      getWbiKey 缓存 / wbi 翻页 / 降级回退 legacy / wbi 失败回退 / 子回复参数与重试
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { getMixinKey, getWbiKey, wbiQuery, _resetWbiCache } = require('../lib/api/wbi');
const {
  isDegraded,
  buildPaginationStr,
  getAllTopComments,
  getAllSubReplies,
} = require('../lib/api/comment');

const jsonRes = obj => ({ text: async () => JSON.stringify(obj) });
const navRes = () => jsonRes({
  code: 0,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
});
const FIXED_MIXIN = 'ea1db124af3c7062474693fa704f4ff8';

// ====== getMixinKey 固定向量 ======
test('getMixinKey 固定向量（公开资料校验值）', () => {
  assert.strictEqual(getMixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45'), FIXED_MIXIN);
  assert.strictEqual(getMixinKey('', ''), '');
  // 短 key：MIXIN_TAB[0]=46 超出长度直接终止（返回空串，不抛错）
  assert.strictEqual(getMixinKey('abc', 'def'), '');
});

// ====== wbiQuery 签名 ======
test('wbiQuery 参数排序 + 值编码 + w_rid 正确', async () => {
  const qs = await wbiQuery({ mode: '3', oid: '404135596', pagination_str: '{"offset":""}', plat: '1', web_location: '1315875', seek_rpid: '' }, '', {
    wts: 1750000000,
    mixinKey: FIXED_MIXIN,
  });
  // 字母序：mode < oid < pagination_str < plat < seek_rpid < web_location < wts
  const keys = qs.split('&').map(kv => kv.split('=')[0]);
  assert.deepStrictEqual(keys, ['mode', 'oid', 'pagination_str', 'plat', 'seek_rpid', 'web_location', 'wts', 'w_rid']);
  // pagination_str 值被 URL 编码
  assert.ok(qs.includes('pagination_str=%7B%22offset%22%3A%22%22%7D'), qs);
  // w_rid === md5(串 + mixinKey)
  const body = qs.replace(/&w_rid=[a-f0-9]{32}$/, '');
  assert.strictEqual(qs.split('w_rid=')[1], crypto.createHash('md5').update(body + FIXED_MIXIN).digest('hex'));
});

// ====== pagination_str ======
test('buildPaginationStr 首页与翻页', () => {
  assert.strictEqual(buildPaginationStr(''), '{"offset":""}');
  assert.strictEqual(buildPaginationStr('CAEiAggC'), '{"offset":"CAEiAggC"}');
});

// ====== isDegraded ======
test('isDegraded 降级判定', () => {
  assert.strictEqual(isDegraded(3, 8809), true);   // 3 条但总量巨大 → 降级
  assert.strictEqual(isDegraded(20, 8809), false); // 满页正常
  assert.strictEqual(isDegraded(3, 50), false);    // 总量小不判降级
  assert.strictEqual(isDegraded(0, 0), false);
});

// ====== getWbiKey 缓存 ======
test('getWbiKey 拉取并缓存（1h 内复用）', async (t) => {
  _resetWbiCache();
  let navCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/x/web-interface/nav')) { navCalls++; return navRes(); }
    return jsonRes({ code: -404 });
  });
  const k1 = await getWbiKey('cookie1');
  const k2 = await getWbiKey('cookie1');
  assert.strictEqual(k1, FIXED_MIXIN);
  assert.strictEqual(k2, FIXED_MIXIN);
  assert.strictEqual(navCalls, 1, '缓存应避免重复请求 nav');
  _resetWbiCache();
});

test('getWbiKey nav 失败抛错', async (t) => {
  _resetWbiCache();
  t.mock.method(globalThis, 'fetch', async () => jsonRes({ code: -101 }));
  await assert.rejects(() => getWbiKey('cookie'), /WBI 密钥失败/);
  _resetWbiCache();
});

// ====== getAllTopComments 编排：wbi 翻页 ======
test('getAllTopComments 优先 wbi：两页翻页 + total', async (t) => {
  _resetWbiCache();
  const mkReply = (rpid, mid) => ({ rpid, oid: '1', type: 11, mid, root: 0, parent: 0, count: 0, rcount: 0, ctime: 1750000000, like: 1, content: { message: 'c' + rpid }, member: { uname: 'u' + mid, avatar: '//x/a.png' } });
  const page1 = Array.from({ length: 20 }, (_, i) => mkReply(100 + i, 1000 + i));
  const page2 = Array.from({ length: 5 }, (_, i) => mkReply(200 + i, 2000 + i));
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u.includes('/x/frontend/finger/spi')) return jsonRes({ code: 0, data: { b_3: 'B3', b_4: 'B4' } });
    if (u.includes('/x/web-interface/nav')) return navRes();
    if (u.includes('/x/v2/reply/wbi/main')) {
      const isPage2 = u.includes('CAEiAggC');
      return jsonRes({
        code: 0,
        data: {
          replies: isPage2 ? page2 : page1,
          cursor: {
            all_count: 8809,
            is_end: isPage2,
            pagination_reply: isPage2 ? {} : { next_offset: 'CAEiAggC' },
          },
        },
      });
    }
    return jsonRes({ code: -404 });
  });
  const { replies, total, degraded } = await getAllTopComments('404135596', 11, 'cookie');
  assert.strictEqual(replies.length, 25);
  assert.strictEqual(total, 8809);
  assert.strictEqual(degraded, false);
  assert.strictEqual(replies[0].rpid, '100'); // 映射结构
  _resetWbiCache();
});

// ====== 降级回退 ======
test('wbi 结果降级 → 回退 legacy 并保留标记', async (t) => {
  _resetWbiCache();
  const mkReply = (rpid, mid) => ({ rpid, mid, root: 0, parent: 0, ctime: 1, like: 0, content: { message: 'x' }, member: { uname: 'u', avatar: '' } });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u.includes('/x/frontend/finger/spi')) return jsonRes({ code: 0, data: { b_3: 'B3', b_4: 'B4' } });
    if (u.includes('/x/web-interface/nav')) return navRes();
    if (u.includes('/x/v2/reply/wbi/main')) {
      // wbi 被降级：3 条 + 巨大总量
      return jsonRes({ code: 0, data: { replies: [mkReply(1, 1), mkReply(2, 1), mkReply(3, 1)], cursor: { all_count: 8809, is_end: true, pagination_reply: {} } } });
    }
    if (u.includes('/x/v2/reply?')) {
      // legacy 也降级：3 条（page.count 大）
      return jsonRes({ code: 0, data: { replies: [mkReply(11, 1), mkReply(12, 1), mkReply(13, 1)], page: { count: 8809 } } });
    }
    return jsonRes({ code: -404 });
  });
  const { replies, degraded, total } = await getAllTopComments('404135596', 11, 'cookie');
  assert.strictEqual(degraded, true);
  assert.strictEqual(replies.length, 3);
  assert.strictEqual(total, 8809);
  _resetWbiCache();
});

// ====== wbi 失败回退 ======
test('wbi 请求抛错（-352）→ 回退 legacy', async (t) => {
  _resetWbiCache();
  const mkReply = (rpid) => ({ rpid, mid: 1, root: 0, parent: 0, ctime: 1, like: 0, content: { message: 'x' }, member: { uname: 'u', avatar: '' } });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u.includes('/x/frontend/finger/spi')) return jsonRes({ code: 0, data: { b_3: 'B3', b_4: 'B4' } });
    if (u.includes('/x/web-interface/nav')) return navRes();
    if (u.includes('/x/v2/reply/wbi/main')) return jsonRes({ code: -352, message: '风控' });
    if (u.includes('/x/v2/reply?')) return jsonRes({ code: 0, data: { replies: [mkReply(11), mkReply(12)], page: { count: 2 } } });
    return jsonRes({ code: -404 });
  });
  const { replies, degraded } = await getAllTopComments('404135596', 11, 'cookie');
  assert.strictEqual(degraded, false);
  assert.strictEqual(replies.length, 2);
  _resetWbiCache();
});

// ====== 子回复参数与重试 ======
test('getAllSubReplies URL 含 web_location=333.788 且失败重试', async (t) => {
  const urls = [];
  let failFirst = true;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('/x/frontend/finger/spi')) return jsonRes({ code: 0, data: { b_3: 'B3', b_4: 'B4' } });
    if (u.includes('/x/v2/reply/reply')) {
      if (failFirst) { failFirst = false; return jsonRes({ code: -412, message: '风控' }); }
      return jsonRes({ code: 0, data: { replies: [{ rpid: 1, mid: 1, root: 5, parent: 5, ctime: 1, like: 0, content: { message: 'r' }, member: { uname: 'u', avatar: '' } }] } });
    }
    return jsonRes({ code: -404 });
  });
  const replies = await getAllSubReplies('404135596', 11, '5', 'cookie', 1);
  assert.strictEqual(replies.length, 1);
  assert.ok(urls[0].includes('web_location=333.788'), '应带 web_location: ' + urls[0]);
  assert.ok(urls.length >= 2, '失败后应重试');
});
