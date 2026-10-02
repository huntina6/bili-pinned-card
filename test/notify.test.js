'use strict';
/**
 * 通知推送测试（纯函数 + 本地 HTTP 服务器回环，零外部网络）
 * 覆盖：事件映射、消息体模板、订阅过滤、未配置空操作、best-effort 失败不抛错
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../lib/logger');
const {
  NOTIFY_EVENTS, FORMATS, toNotifyEvent, buildMessage, buildPayload,
  isSubscribed, resolveFormat, checkChannelBody, sendNotify, notifyResult,
} = require('../lib/notify');

// 日志重定向到临时目录，避免污染真实用户日志
logger.setDir(fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-notify-')));

test('toNotifyEvent：monitor 事件映射，无需通知的事件返回 null', () => {
  assert.strictEqual(toNotifyEvent({ event: 'new' }), 'new');
  assert.strictEqual(toNotifyEvent({ event: 'manual' }), 'new');
  assert.strictEqual(toNotifyEvent({ event: 'context' }), 'new');
  assert.strictEqual(toNotifyEvent({ event: 'unpinned' }), 'unpinned');
  assert.strictEqual(toNotifyEvent({ event: 'dyn-update' }), 'dyn-update');
  assert.strictEqual(toNotifyEvent({ event: 'up-top' }), 'up-top');
  assert.strictEqual(toNotifyEvent({ event: 'error' }), 'error');
  assert.strictEqual(toNotifyEvent({ event: 'fetch-error' }), 'error');
  assert.strictEqual(toNotifyEvent({ event: 'same' }), null);
  assert.strictEqual(toNotifyEvent({ event: 'filtered' }), null);
  assert.strictEqual(toNotifyEvent(null), null);
});

test('buildMessage：置顶评论变化包含作者/正文/链接/图片', () => {
  const msg = buildMessage('new', {
    comment: { author: 'UP主', message: '置顶了' },
    oid: '404135596',
    file: '/tmp/card.png',
  }, '【测试】');
  assert.strictEqual(msg.event, 'new');
  assert.strictEqual(msg.title, '【测试】置顶评论变化');
  assert.match(msg.text, /UP主/);
  assert.match(msg.text, /置顶了/);
  assert.match(msg.text, /https:\/\/t\.bilibili\.com\/404135596/);
  assert.match(msg.text, /\/tmp\/card\.png/);
  assert.strictEqual(msg.file, '/tmp/card.png');
});

test('buildMessage：超长正文截断到 200 字，缺字段不报错', () => {
  const long = 'x'.repeat(500);
  const msg = buildMessage('new', { comment: { message: long } });
  assert.strictEqual(msg.text.includes('x'.repeat(200)), true);
  assert.strictEqual(msg.text.includes('x'.repeat(201)), false);
  assert.doesNotThrow(() => buildMessage('dyn-update', {}));
  assert.doesNotThrow(() => buildMessage('unknown', {}));
});

test('buildMessage：up-top / error / unpinned 文案', () => {
  assert.match(buildMessage('up-top', { cards: 3, skipped: 1 }).text, /本次生成 3 张.*跳过已存在 1 张/);
  assert.match(buildMessage('error', { message: 'Cookie 已失效' }).title, /监测异常/);
  assert.match(buildMessage('error', { message: 'Cookie 已失效' }).text, /Cookie 已失效/);
  assert.match(buildMessage('unpinned', {}).title, /置顶评论已取消/);
});

test('buildPayload：generic/feishu/dingtalk/telegram 模板与非法值回退', () => {
  const msg = { event: 'new', title: '标题', text: '正文', file: null };
  const g = buildPayload('generic', msg);
  assert.strictEqual(g.event, 'new');
  assert.strictEqual(g.title, '标题');
  assert.deepStrictEqual(buildPayload('feishu', msg).content.text, '标题\n正文');
  assert.strictEqual(buildPayload('feishu', msg).msg_type, 'text');
  assert.strictEqual(buildPayload('dingtalk', msg).msgtype, 'text');
  assert.strictEqual(buildPayload('telegram', msg).chat_id, '');
  assert.strictEqual(buildPayload('telegram', msg, { notifyChatId: '123' }).chat_id, '123');
  assert.ok(buildPayload('bogus', msg).event, '未知模板回退 generic');
});

test('isSubscribed / resolveFormat：默认全订阅，非法格式回退 generic', () => {
  for (const e of NOTIFY_EVENTS) assert.strictEqual(isSubscribed({}, e), true);
  for (const e of NOTIFY_EVENTS) assert.strictEqual(isSubscribed({ notifyEvents: null }, e), true, '未指定=全订阅');
  assert.strictEqual(isSubscribed({ notifyEvents: ['new'] }, 'new'), true);
  assert.strictEqual(isSubscribed({ notifyEvents: ['new'] }, 'error'), false);
  assert.strictEqual(resolveFormat({ notifyFormat: 'feishu' }), 'feishu');
  assert.strictEqual(resolveFormat({ notifyFormat: 'weird' }), 'generic');
  assert.strictEqual(resolveFormat({}), 'generic');
  assert.strictEqual(FORMATS.includes('telegram'), true);
});

test('sendNotify / notifyResult：未配置 Webhook 时零操作（默认关闭）', async () => {
  assert.deepStrictEqual(await sendNotify({}, { event: 'new', title: 't', text: 'x', file: null }), { ok: false, skipped: true });
  assert.deepStrictEqual(await notifyResult({}, { event: 'new' }), { ok: false, skipped: true });
});

test('notifyResult：事件不可映射或未订阅时跳过', async () => {
  const cfg = { notifyWebhook: 'http://127.0.0.1:1/hook' };
  assert.deepStrictEqual(await notifyResult(cfg, { event: 'same' }), { ok: false, skipped: true });
  assert.deepStrictEqual(
    await notifyResult({ ...cfg, notifyEvents: ['error'] }, { event: 'new' }),
    { ok: false, skipped: true },
  );
});

test('isSubscribed：显式空数组=不订阅任何事件（向导「全不选」的语义，此前被当成全选）', () => {
  for (const e of NOTIFY_EVENTS) assert.strictEqual(isSubscribed({ notifyEvents: [] }, e), false, e);
  assert.strictEqual(isSubscribed({ notifyEvents: ['new'] }, 'new'), true);
  assert.strictEqual(isSubscribed({ notifyEvents: 'new' }, 'new'), true, '非数组脏值回退全订阅，不误判为关闭');
});

test('notifyResult：事件订阅为空数组时不推送（即使配置了 Webhook）', async () => {
  const cfg = { notifyWebhook: 'http://127.0.0.1:1/hook', notifyEvents: [] };
  assert.deepStrictEqual(await notifyResult(cfg, { event: 'new' }), { ok: false, skipped: true });
});

test('sendNotify：本地服务器回环，POST JSON 且成功返回 ok', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      received.push({ method: req.method, type: req.headers['content-type'], body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"code":0}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await sendNotify({ notifyWebhook: `http://127.0.0.1:${port}/hook`, notifyFormat: 'generic' },
      { event: 'new', title: '标题', text: '正文', file: '/tmp/a.png' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].method, 'POST');
    assert.match(received[0].type, /application\/json/);
    assert.strictEqual(received[0].body.event, 'new');
    assert.strictEqual(received[0].body.text, '正文');
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('sendNotify：HTTP 非 2xx 与网络异常返回 ok=false 且不抛错（best-effort）', async () => {
  const server = http.createServer((req, res) => { res.writeHead(500); res.end('boom'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await sendNotify({ notifyWebhook: `http://127.0.0.1:${port}/hook` },
      { event: 'new', title: 't', text: 'x', file: null });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 500);
  } finally {
    await new Promise(r => server.close(r));
  }
  const fail = await sendNotify({ notifyWebhook: 'http://127.0.0.1:1/hook' },
    { event: 'new', title: 't', text: 'x', file: null });
  assert.strictEqual(fail.ok, false);
  assert.ok(fail.error, '网络异常应返回 error 而非抛出');
});

// ====== 诚实回执：HTTP 200 但 body 报业务错误（飞书/钉钉的静默失败） ======

test('checkChannelBody：飞书/钉钉/Telegram 业务错误码判定', () => {
  // 飞书：新版 code，老版 StatusCode；0 为成功
  assert.deepStrictEqual(checkChannelBody('feishu', '{"code":0,"msg":"success"}'), { ok: true, detail: '' });
  assert.deepStrictEqual(checkChannelBody('feishu', '{"StatusCode":0,"StatusMessage":"success"}'), { ok: true, detail: '' });
  const fs1 = checkChannelBody('feishu', '{"code":19024,"msg":"Key Words Not Found"}');
  assert.strictEqual(fs1.ok, false);
  assert.match(fs1.detail, /code=19024 Key Words Not Found/);
  assert.strictEqual(checkChannelBody('feishu', '{"code":19021,"msg":"sign match fail"}').ok, false);
  // 钉钉：errcode
  assert.strictEqual(checkChannelBody('dingtalk', '{"errcode":0,"errmsg":"ok"}').ok, true);
  const dt = checkChannelBody('dingtalk', '{"errcode":310000,"errmsg":"keywords not in content"}');
  assert.strictEqual(dt.ok, false);
  assert.match(dt.detail, /errcode=310000 keywords not in content/);
  // Telegram
  assert.strictEqual(checkChannelBody('telegram', '{"ok":true,"result":{}}').ok, true);
  const tg = checkChannelBody('telegram', '{"ok":false,"error_code":400,"description":"chat not found"}');
  assert.strictEqual(tg.ok, false);
  assert.match(tg.detail, /400 chat not found/);
});

test('checkChannelBody：保守策略——generic/非 JSON/缺字段一律视为成功', () => {
  assert.strictEqual(checkChannelBody('generic', '{"code":19024}').ok, true, 'generic 无业务码约定');
  assert.strictEqual(checkChannelBody('feishu', 'ok').ok, true, '非 JSON 不判定');
  assert.strictEqual(checkChannelBody('feishu', '').ok, true);
  assert.strictEqual(checkChannelBody('feishu', '{"msg":"无 code 字段"}').ok, true, '缺字段不判定');
  assert.strictEqual(checkChannelBody('dingtalk', '{"errcode":"310000"}').ok, true, '字符串码不判定，避免误报');
});

test('sendNotify：HTTP 200 但飞书返回业务错误码 → 不得记成推送成功', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"code":19024,"msg":"Key Words Not Found"}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await sendNotify(
      { notifyWebhook: `http://127.0.0.1:${port}/hook`, notifyFormat: 'feishu' },
      { event: 'new', title: 't', text: 'x', file: null });
    assert.strictEqual(res.ok, false, '业务级失败必须暴露为失败');
    assert.strictEqual(res.status, 200);
    assert.match(res.error, /19024/);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('sendNotify：HTTP 200 且钉钉 errcode=0 → 正常成功', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"errcode":0,"errmsg":"ok"}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await sendNotify(
      { notifyWebhook: `http://127.0.0.1:${port}/hook`, notifyFormat: 'dingtalk' },
      { event: 'new', title: 't', text: 'x', file: null });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 200);
  } finally {
    await new Promise(r => server.close(r));
  }
});
