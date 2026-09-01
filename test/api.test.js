'use strict';
/**
 * B站 API 层纯函数测试（node:test，零额外依赖）
 * 运行：npm test（node --test 自动发现 test/ 下全部 *.test.js）
 */
const test = require('node:test');
const assert = require('node:assert');
const api = require('../lib/api');
const { extractId, isOpusLink, filterUpInteractions, extractDynamicContent, filterUpComments, buildUpContextItems, pickTopFanReplies, fixWebpUrl } = api;


// ====== extractId（回归：评论分享链接必须提取 rpid 而非 oid） ======
test('extractId 评论分享链接提取 rpid', () => {
  assert.strictEqual(extractId('https://t.bilibili.com/404135596?comment_root_id=313406396048'), '313406396048');
  assert.strictEqual(extractId('https://t.bilibili.com/404135596?comment_id=313406396048'), '313406396048');
  assert.strictEqual(extractId('https://t.bilibili.com/404135596#reply313406396048'), '313406396048');
});

test('extractId 动态链接/裸输入提取 oid', () => {
  assert.strictEqual(extractId('https://t.bilibili.com/404135596'), '404135596');
  assert.strictEqual(extractId('https://www.bilibili.com/dynamic/404135596'), '404135596');
  assert.strictEqual(extractId('404135596'), '404135596');
  assert.strictEqual(extractId('313406396048'), '313406396048');
});

test('extractId 无法识别时原样返回', () => {
  assert.strictEqual(extractId(''), '');
  assert.strictEqual(extractId('随便一句话'), '随便一句话');
  assert.strictEqual(extractId(null), '');
});

test('extractId Opus 链接提取 dynId', () => {
  assert.strictEqual(extractId('https://www.bilibili.com/opus/1232243387332034584'), '1232243387332034584');
  assert.strictEqual(extractId('https://www.bilibili.com/opus/123?from=search'), '123');
  // 固化「评论 ID 优先」：opus 链接带 comment_root_id 时仍提取 rpid（供 --rpid 使用）
  assert.strictEqual(extractId('https://www.bilibili.com/opus/123?comment_root_id=456'), '456');
});

test('isOpusLink 判定', () => {
  assert.strictEqual(isOpusLink('https://www.bilibili.com/opus/1232243387332034584'), true);
  assert.strictEqual(isOpusLink('https://www.bilibili.com/opus/123?from=search'), true);
  assert.strictEqual(isOpusLink('https://t.bilibili.com/404135596'), false);
  assert.strictEqual(isOpusLink('https://www.bilibili.com/dynamic/404135596'), false);
  assert.strictEqual(isOpusLink('404135596'), false);
  assert.strictEqual(isOpusLink(''), false);
  assert.strictEqual(isOpusLink(null), false);
});


// ====== filterUpInteractions ======
const mkReply = (rpid, mid, opts = {}) => ({
  rpid, mid,
  parent: opts.parent || '0',
  up_action: opts.liked ? { like: true } : undefined,
  member: { uname: 'user' + mid, avatar: '//x/a.png' },
  content: { message: '内容' + rpid, emote: {} },
  ctime: 1754985600, like: 3,
});

test('filterUpInteractions UP 回复形成对话链', () => {
  const replies = [
    mkReply('100', 123),                       // 粉丝评论
    mkReply('101', 401315430, { parent: '100' }), // UP 回复该评论
  ];
  const items = filterUpInteractions(replies, 401315430);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].kind, 'reply');
  assert.ok(items[0].parent);                  // 有父评论
  assert.strictEqual(items[0].parent.rpid, '100');
  assert.ok(items[0].upReply);
  assert.strictEqual(items[0].upReply.rpid, '101');
});

test('filterUpInteractions UP 回复无父评论', () => {
  const replies = [mkReply('200', 401315430, { parent: '999' })]; // 父评论不在列表
  const items = filterUpInteractions(replies, 401315430);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].kind, 'reply');
  assert.strictEqual(items[0].parent, null);
});

test('filterUpInteractions UP 点赞（UP 自己的回复不重复计赞）', () => {
  const replies = [
    mkReply('300', 555, { liked: true }),      // 被 UP 点赞的粉丝评论
    mkReply('301', 401315430, { liked: true }), // UP 自己的回复（已被算作 UP 回复，不再重复算点赞）
  ];
  const items = filterUpInteractions(replies, 401315430);
  // 2 条：一条 UP 回复（301），一条 UP 点赞（300）
  assert.strictEqual(items.length, 2);
  const likeItems = items.filter(i => i.kind === 'like');
  assert.strictEqual(likeItems.length, 1);
  assert.strictEqual(likeItems[0].parent.rpid, '300');
});

test('filterUpInteractions 无互动', () => {
  assert.deepStrictEqual(filterUpInteractions([], 401315430), []);
});

test('回归：uid 为字符串时 UP 互动也能匹配（P0 类型不匹配修复）', () => {
  // cli.js 传入的 uid 是字符串（如 '401315430'），而 API 返回的 mid 是 number；
  // 修复前 `r.mid === uid` 恒为 false，UP 互动永远识别不到
  const replies = [
    mkReply('400', 401315430),                        // UP 自己的回复（number mid）
    mkReply('401', 123456, { liked: true }),          // 被 UP 点赞的粉丝评论
    mkReply('402', 401315430, { liked: true }),       // UP 自己的回复被点赞 → 只计 reply，不重复计 like
  ];
  const items = filterUpInteractions(replies, '401315430'); // 字符串 uid
  // 期望：reply×2（400、402）+ like×1（401）= 3 项
  assert.strictEqual(items.length, 3, '字符串 uid 应识别出 UP 回复与 UP 点赞');
  const replyItems = items.filter(i => i.kind === 'reply');
  const likeItems = items.filter(i => i.kind === 'like');
  assert.strictEqual(replyItems.length, 2, 'UP 回复应为 2 条（400、402）');
  assert.ok(replyItems.every(i => i.upReply && i.upReply.rpid !== undefined));
  assert.strictEqual(likeItems.length, 1, 'UP 点赞应为 1 条（401，UP 自己的 402 不重复计）');
  assert.strictEqual(likeItems[0].parent.rpid, '401');
});

test('回归：uid 为数字时行为不变', () => {
  const replies = [mkReply('500', 401315430)];
  const items = filterUpInteractions(replies, 401315430);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].kind, 'reply');
});

// ====== extractDynamicContent ======
test('extractDynamicContent DRAW 图片动态', () => {
  const item = {
    modules: {
      module_dynamic: {
        desc: { text: '晒图' },
        major: { type: 'MAJOR_TYPE_DRAW', draw: { items: [{ src: '//i0.hdslb.com/1.jpg' }, { src: '//i0.hdslb.com/2.jpg' }] } },
      },
    },
  };
  const r = extractDynamicContent(item);
  assert.strictEqual(r.desc, '晒图');
  assert.strictEqual(r.images.length, 2);
  assert.ok(r.images[0].startsWith('https://'));
});

test('extractDynamicContent ARCHIVE 视频动态', () => {
  const item = {
    modules: {
      module_dynamic: {
        desc: { text: '' },
        major: { type: 'MAJOR_TYPE_ARCHIVE', archive: { title: '新视频', cover: '//i0.hdslb.com/c.jpg' } },
      },
    },
  };
  const r = extractDynamicContent(item);
  assert.strictEqual(r.desc, '新视频');
  assert.strictEqual(r.images.length, 1);
});

test('extractDynamicContent 纯文本动态', () => {
  const item = { modules: { module_dynamic: { desc: { text: '纯文本' } } } };
  const r = extractDynamicContent(item);
  assert.strictEqual(r.desc, '纯文本');
  assert.strictEqual(r.images.length, 0);
});

// ====== --up-top 功能：filterUpComments / buildUpContextItems / pickTopFanReplies / toFileTs ======

// mkReply 变体：可指定 like/ctime/up_action
const mkTopReply = (rpid, mid, opts = {}) => ({
  rpid, mid,
  parent: opts.parent || '0',
  up_action: opts.liked ? { like: true } : undefined,
  member: { uname: 'user' + mid, avatar: '//x/a.png' },
  content: { message: '内容' + rpid, emote: {} },
  ctime: opts.ctime ?? 1754985600, like: opts.like ?? 3,
});

test('filterUpComments 仅保留 UP 自己发的评论（number/string 混用）', () => {
  const replies = [
    mkTopReply('1', 401315430),
    mkTopReply('2', 999),
    mkTopReply('3', '401315430'), // 字符串 mid
  ];
  const ups = filterUpComments(replies, 401315430);
  assert.strictEqual(ups.length, 2);
  assert.deepStrictEqual(ups.map(r => r.rpid), ['1', '3']);
});

test('filterUpComments 空输入', () => {
  assert.deepStrictEqual(filterUpComments([], 401315430), []);
});

test('buildUpContextItems UP 回复形成对话对 + 仅点赞未回复', () => {
  const replies = [
    mkTopReply('100', 123, { ctime: 1000 }),                     // 粉丝评论
    mkTopReply('101', 401315430, { parent: '100', ctime: 1001 }), // UP 回复该评论
    mkTopReply('102', 555, { liked: true, ctime: 1002 }),         // 仅被 UP 点赞未回复
    mkTopReply('103', 401315430, { liked: true, ctime: 1003 }),   // UP 自己的回复被点赞 → 只算 reply，不重复 like
  ];
  const items = buildUpContextItems(replies, 401315430);
  // reply（101、103）+ like（102）= 3 项
  assert.strictEqual(items.length, 3, '应包含 UP 回复与仅点赞项');
  const replyItems = items.filter(i => i.kind === 'reply');
  const likeItems = items.filter(i => i.kind === 'like');
  assert.strictEqual(replyItems.length, 2);
  assert.strictEqual(likeItems.length, 1);
  // 对话对：parent 为被回复的粉丝评论
  const withParent = replyItems.find(i => i.upReply.rpid === '101');
  assert.ok(withParent.parent, 'UP 回复应有被回复的粉丝评论上下文');
  assert.strictEqual(withParent.parent.rpid, '100');
  assert.strictEqual(withParent.parent.author, 'user123');
  // 仅点赞项
  assert.strictEqual(likeItems[0].parent.rpid, '102');
  assert.strictEqual(likeItems[0].upReply, null);
});

test('buildUpContextItems UP 回复无父评论时保留本体', () => {
  const replies = [mkTopReply('200', 401315430, { parent: '999' })];
  const items = buildUpContextItems(replies, 401315430);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].kind, 'reply');
  assert.strictEqual(items[0].parent, null);
  assert.strictEqual(items[0].upReply.rpid, '200');
});

test('buildUpContextItems 按时间升序排列（reply/like 混合）', () => {
  const replies = [
    mkTopReply('300', 123, { ctime: 3000 }),
    mkTopReply('301', 401315430, { parent: '300', ctime: 3002 }),
    mkTopReply('302', 456, { liked: true, ctime: 3001 }),
    mkTopReply('303', 401315430, { ctime: 3003 }),
    mkTopReply('304', 789, { liked: true, ctime: 3004 }),
  ];
  const items = buildUpContextItems(replies, 401315430);
  // 排序键 = parent.ctime ?? upReply.ctime
  const keys = items.map(i => i.parent?.ctime ?? i.upReply.ctime);
  assert.deepStrictEqual(keys, [...keys].sort((a, b) => a - b), '应按时间升序');
  // 时间相同按 rpid 稳定
  const tied = [
    mkTopReply('400', 401315430, { ctime: 5000 }),
    mkTopReply('401', 401315430, { ctime: 5000 }),
  ];
  const tItems = buildUpContextItems(tied, 401315430);
  assert.deepStrictEqual(tItems.map(i => i.upReply.rpid), ['400', '401']);
});

test('buildUpContextItems 全量返回不截断 + 空数组', () => {
  const replies = [];
  for (let i = 0; i < 25; i++) replies.push(mkTopReply(String(i), 401315430));
  const items = buildUpContextItems(replies, 401315430);
  assert.strictEqual(items.length, 25, '应全量返回（无前 N 截断）');
  assert.deepStrictEqual(buildUpContextItems([], 401315430), []);
});

test('buildUpContextItems uid 为字符串也能匹配（类型统一回归）', () => {
  const replies = [
    mkTopReply('500', 401315430),                  // number mid
    mkTopReply('501', 123, { liked: true }),
  ];
  const items = buildUpContextItems(replies, '401315430'); // 字符串 uid
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items.filter(i => i.kind === 'reply').length, 1);
  assert.strictEqual(items.filter(i => i.kind === 'like').length, 1);
});

test('pickTopFanReplies 仅粉丝回复 + 点赞降序', () => {
  const replies = [
    mkTopReply('600', 401315430, { like: 999 }),  // UP 自己的回复：不进入点赞区
    mkTopReply('601', 111, { like: 5 }),
    mkTopReply('602', 222, { like: 50 }),
    mkTopReply('603', 333, { like: 50 }),
    mkTopReply('604', 444, { like: 1 }),
  ];
  const fans = pickTopFanReplies(replies, 401315430, 10);
  assert.deepStrictEqual(fans.map(r => r.rpid), ['602', '603', '601', '604'], '点赞降序且不含 UP 回复');
});

test('回归：pickTopFanReplies 输出映射结构（P1 高赞区头像/用户名/内容空白修复）', () => {
  // 输入为 B站 API 原始结构（member/content 包裹）；修复前直接透传导致
  // 下游 prepareImages/renderChainBlock 读取 r.message/r.avatar/r.author 全为 undefined
  const replies = [
    mkTopReply('610', 111, { like: 9 }),
    mkTopReply('611', 401315430, { like: 999 }), // UP 回复：被过滤
  ];
  const fans = pickTopFanReplies(replies, 401315430, 10);
  assert.strictEqual(fans.length, 1, '仅保留粉丝回复');
  const fan = fans[0];
  // 映射字段必须存在且与原始数据一致
  assert.strictEqual(fan.author, 'user111', 'author 应映射自 member.uname');
  assert.ok(fan.avatar.startsWith('https://'), `avatar 应归一化为 https，实际 ${fan.avatar}`);
  assert.strictEqual(fan.message, '内容610', 'message 应映射自 content.message');
  assert.strictEqual(fan.mid, 111, 'mid 必须保留（供过滤比对）');
  assert.ok(Array.isArray(fan.pictures), 'pictures 应为数组');
  assert.strictEqual(fan.like, 9);
});

test('回归：pickTopFanReplies 评论自带图片归一化', () => {
  const replies = [mkTopReply('620', 222, { like: 3 })];
  replies[0].content.pictures = [{ img_src: '//i0.hdslb.com/1.jpg' }, { img_src: 'https://i0.hdslb.com/2.jpg' }];
  const fans = pickTopFanReplies(replies, 401315430, 10);
  assert.deepStrictEqual(fans[0].pictures, ['https://i0.hdslb.com/1.jpg', 'https://i0.hdslb.com/2.jpg'], 'pictures URL 应归一化为 https');
});

test('pickTopFanReplies 截断 n / 不足 n / 空数组', () => {
  const replies = [
    mkTopReply('700', 111, { like: 3 }),
    mkTopReply('701', 222, { like: 2 }),
    mkTopReply('702', 333, { like: 1 }),
  ];
  assert.strictEqual(pickTopFanReplies(replies, 401315430, 2).length, 2);
  assert.strictEqual(pickTopFanReplies(replies, 401315430, 10).length, 3);
  assert.deepStrictEqual(pickTopFanReplies([], 401315430, 10), []);
});

test('fixWebpUrl .webp 追加 @1e_1c.jpg', () => {
  assert.strictEqual(
    fixWebpUrl('https://i1.hdslb.com/bfs/face/abc.webp'),
    'https://i1.hdslb.com/bfs/face/abc.webp@1e_1c.jpg');
});

test('fixWebpUrl 其他格式不变', () => {
  assert.strictEqual(fixWebpUrl('https://i0.hdslb.com/bfs/face/a.jpg'), 'https://i0.hdslb.com/bfs/face/a.jpg');
  assert.strictEqual(fixWebpUrl('https://i0.hdslb.com/bfs/face/a.png'), 'https://i0.hdslb.com/bfs/face/a.png');
  assert.strictEqual(fixWebpUrl('https://i0.hdslb.com/bfs/face/a.gif'), 'https://i0.hdslb.com/bfs/face/a.gif');
  assert.strictEqual(fixWebpUrl('https://i0.hdslb.com/bfs/face/noext'), 'https://i0.hdslb.com/bfs/face/noext');
});

test('fixWebpUrl 带 query 时参数插在 path 后 query 前', () => {
  assert.strictEqual(
    fixWebpUrl('https://i1.hdslb.com/bfs/face/abc.webp?x=1&y=2'),
    'https://i1.hdslb.com/bfs/face/abc.webp@1e_1c.jpg?x=1&y=2');
  assert.strictEqual(fixWebpUrl('https://i0.hdslb.com/bfs/face/a.jpg?x=1'), 'https://i0.hdslb.com/bfs/face/a.jpg?x=1');
});

test('fixWebpUrl 大小写不敏感', () => {
  assert.strictEqual(
    fixWebpUrl('https://i1.hdslb.com/bfs/face/abc.WEBP'),
    'https://i1.hdslb.com/bfs/face/abc.WEBP@1e_1c.jpg');
});

test('fixWebpUrl 空/null/undefined 原样返回', () => {
  assert.strictEqual(fixWebpUrl(''), '');
  assert.strictEqual(fixWebpUrl(null), '');
  assert.strictEqual(fixWebpUrl(undefined), '');
});

