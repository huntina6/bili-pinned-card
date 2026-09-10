'use strict';
/**
 * P1 回归测试：输入行为一致性 & 拉取失败归因（mock 全局 fetch，零网络）
 *
 * 覆盖两个已复现 Bug：
 *  1. resolveCommentOid —— 裸动态 ID 数字与链接输入行为不一致（裸数字不做 oid 转换）
 *  2. getPinnedComment  —— 「无置顶评论」与「拉取失败/对象不存在」不可区分
 *
 * 运行：npm test
 */
const test = require('node:test');
const assert = require('node:assert');
// mock fetch 无真实网络，关闭请求层 1~2s 节流避免拖慢测试
require('../lib/api/client').setThrottle(false);
const { resolveCommentOid, extractReplyParams, getPinnedComment } = require('../lib/api');
const { isBareDynamicId } = require('../lib/api/util');
const { BiliError } = require('../lib/api/client');

const jsonRes = obj => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });

/**
 * apiGet 会先调 anonCookie() 取 buvid（带缓存）——测试前预热一次，
 * 之后业务请求不再触发 SPI；需在 setThrottle(false) 之后、任何业务调用之前执行。
 */
async function primeAnonCookie() {
  const real = globalThis.fetch;
  globalThis.fetch = async () => jsonRes({ code: 0, message: 'OK', data: { b_3: 'test-buvid3', b_4: 'test-buvid4' } });
  try { await require('../lib/api/client').anonCookie(); } finally { globalThis.fetch = real; }
}
// ====== 全局预热：确保 buvid 已缓存，业务请求不再走 SPI ======
test.before(async () => { await primeAnonCookie(); });

/** 构造一个「图文动态」详情响应：dynId ≠ oid（这是 Bug 的核心场景） */
const drawDetail = () => ({
  code: 0, message: 'OK',
  data: { item: { id_str: '1232243387332034584', modules: { module_dynamic: { major: { type: 'MAJOR_TYPE_DRAW', draw: { id: 404135596 } } } } } },
});

// ====== 1. isBareDynamicId：动态 ID 与评论 oid 的长度区分 ======
test('isBareDynamicId：19 位动态 ID 判定为真，评论 oid 判定为假', () => {
  assert.strictEqual(isBareDynamicId('1232243387332034584'), true);  // 19 位动态 ID
  assert.strictEqual(isBareDynamicId('4077509071234567890'), true);  // 19 位
  assert.strictEqual(isBareDynamicId('404135596'), false);           // 9 位评论 oid
  assert.strictEqual(isBareDynamicId('313406396048'), false);        // 12 位评论 oid
  assert.strictEqual(isBareDynamicId('12429974442606592226'), false);// 20 位 App 新 ID（超 int64）
});

test('isBareDynamicId：非数字/空值/带空格边界', () => {
  assert.strictEqual(isBareDynamicId(''), false);
  assert.strictEqual(isBareDynamicId(null), false);
  assert.strictEqual(isBareDynamicId(undefined), false);
  assert.strictEqual(isBareDynamicId('abc'), false);
  assert.strictEqual(isBareDynamicId('https://t.bilibili.com/1232243387332034584'), false);
  assert.strictEqual(isBareDynamicId('  1232243387332034584  '), true); // trim 后判定
});

// ====== 2. 核心回归：裸数字（动态 ID）必须得到与链接相同的结果 ======
test('resolveCommentOid：裸动态 ID 与 opus 链接结果一致（Bug 1 回归）', async t => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes(drawDetail()));
  const viaLink = await resolveCommentOid('https://www.bilibili.com/opus/1232243387332034584');
  const viaBare = await resolveCommentOid('1232243387332034584');
  // 修复前：viaBare = { oid: '1232243387332034584', type: null }（透传 dynId，拉空评论区）
  assert.deepStrictEqual(viaBare, viaLink, '裸数字与链接必须解析出相同 oid/type');
  assert.strictEqual(viaBare.oid, '404135596');
  assert.strictEqual(viaBare.type, 11);
});

test('resolveCommentOid：t.bilibili.com 短链同样转换', async t => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes(drawDetail()));
  const r = await resolveCommentOid('https://t.bilibili.com/1232243387332034584');
  assert.strictEqual(r.oid, '404135596');
  assert.strictEqual(r.type, 11);
});

// ====== 3. 向后兼容：评论 oid 输入零请求透传 ======
test('resolveCommentOid：评论 oid（9-10 位）零请求透传，不触发详情接口', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return jsonRes(drawDetail()); });
  const r = await resolveCommentOid('404135596');
  assert.deepStrictEqual(r, { oid: '404135596', type: null });
  assert.strictEqual(calls, 0, '评论 oid 不应发起任何详情请求');
});

test('resolveCommentOid：空值/非数字原样透传', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return jsonRes(drawDetail()); });
  assert.deepStrictEqual(await resolveCommentOid(''), { oid: '', type: null });
  assert.deepStrictEqual(await resolveCommentOid(null), { oid: '', type: null });
  assert.strictEqual(calls, 0);
});

// ====== 4. 裸数字转换失败 → 安全回退透传（不抛错） ======
test('resolveCommentOid：裸数字详情接口失败（-400）安全回退透传', async t => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes({ code: -400, message: '请求错误' }));
  const r = await resolveCommentOid('1232243387332034584');
  assert.deepStrictEqual(r, { oid: '1232243387332034584', type: null }, '失败时回退原值，保持可用');
});

test('resolveCommentOid：裸数字遇到风控（-352）安全回退透传', async t => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes({ code: -352, message: '风控校验失败' }));
  const r = await resolveCommentOid('1232243387332034584');
  assert.deepStrictEqual(r, { oid: '1232243387332034584', type: null });
});

test('resolveCommentOid：裸数字详情无 item 时安全回退透传', async t => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes({ code: 0, message: 'OK', data: {} }));
  const r = await resolveCommentOid('1232243387332034584');
  assert.deepStrictEqual(r, { oid: '1232243387332034584', type: null });
});

// ====== 5. 链接输入转换失败仍抛错（保持原有严格语义） ======
test('resolveCommentOid：链接输入 -400 抛友好错误', async t => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes({ code: -400, message: '请求错误' }));
  await assert.rejects(
    () => resolveCommentOid('https://www.bilibili.com/opus/12429974442606592226'),
    /无法被 B站 接口解析/);
});

test('resolveCommentOid：链接输入无 item 抛详情获取失败', async t => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes({ code: 0, message: 'OK', data: {} }));
  await assert.rejects(
    () => resolveCommentOid('https://t.bilibili.com/1232243387332034584'),
    /详情获取失败/);
});

// ====== 6. extractReplyParams：20 位 App 新 ID 超 int64 的既有行为 ======
test('extractReplyParams：MAJOR_TYPE_NONE 回退 dynId/type=11', () => {
  const r = extractReplyParams({ id_str: '123', modules: { module_dynamic: {} } });
  assert.deepStrictEqual(r, { oid: '123', type: 11 });
});

// ====== 7. getPinnedComment 归因（Bug 2 核心） ======
const topReplyRes = () => jsonRes({
  code: 0, message: 'OK',
  data: {
    top_replies: [{ rpid: 313406396048, mid: 401315430, ctime: 1754985600, like: 9, rcount: 2, member: { uname: 'UP', avatar: '//i0.hdslb.com/a.jpg' }, content: { message: '置顶内容', emote: {}, pictures: [] } }],
    replies: [{ rpid: 313406396048 }],
  },
});

test('getPinnedComment：正常取到 → reason=ok', async t => {
  t.mock.method(globalThis, 'fetch', async () => topReplyRes());
  const { comment, reason } = await getPinnedComment('404135596', 11, '', { withReason: true });
  assert.strictEqual(reason, 'ok');
  assert.strictEqual(comment.rpid, '313406396048');
  assert.strictEqual(comment.author, 'UP');
});

test('getPinnedComment：接口正常但无置顶 → reason=none（可判定为已取消置顶）', async t => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes({
    code: 0, message: 'OK',
    data: { top_replies: [], replies: [{ rpid: 1 }, { rpid: 2 }] },
  }));
  const { comment, reason } = await getPinnedComment('404135596', 11, '', { withReason: true });
  assert.strictEqual(comment, null);
  assert.strictEqual(reason, 'none');
});

test('getPinnedComment：评论区为空 → reason=empty（同样视为无置顶）', async t => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes({
    code: 0, message: 'OK', data: { top_replies: [], replies: [] },
  }));
  const { comment, reason } = await getPinnedComment('404135596', 11, '', { withReason: true });
  assert.strictEqual(comment, null);
  assert.strictEqual(reason, 'empty');
});

test('getPinnedComment：对象不存在 -404 → reason=notfound（不可判为取消置顶）', async t => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes({ code: -404, message: '啥都木有' }));
  const { comment, reason } = await getPinnedComment('404135596', 11, '', { withReason: true });
  assert.strictEqual(comment, null);
  assert.strictEqual(reason, 'notfound');
});

test('getPinnedComment：风控 -352 必须抛错（不可静默当作无置顶）', async t => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes({ code: -352, message: '风控校验失败' }));
  await assert.rejects(
    () => getPinnedComment('404135596', 11, '', { withReason: true }),
    err => err instanceof BiliError && err.code === -352);
});

test('getPinnedComment：不带 withReason 时保持旧签名（直接返回 comment）', async t => {
  t.mock.method(globalThis, 'fetch', async () => topReplyRes());
  const comment = await getPinnedComment('404135596', 11, '');
  assert.strictEqual(comment.rpid, '313406396048', '旧调用方拿到裸 comment，不受新选项影响');
});

test('getPinnedComment：不带 withReason 且 -404 → 仍返回 null（向后兼容）', async t => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes({ code: -404, message: '啥都木有' }));
  assert.strictEqual(await getPinnedComment('404135596', 11, ''), null);
});
