'use strict';
/**
 * 卡片渲染纯函数与像素回归测试（node:test，零额外依赖）
 * 运行：npm test（node --test 自动发现 test/ 下全部 *.test.js）
 */
const test = require('node:test');
const assert = require('node:assert');
const card = require('../lib/card');
const { fmtCount, fmtTime, charWpx, measureText, tokenize, wrapTokens, toFileTs, truncateTokensToLines } = card;
const { parsePng } = require('../lib/png');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

test('fmtCount 万级格式化', () => {
  assert.strictEqual(fmtCount(0), '0');
  assert.strictEqual(fmtCount(9999), '9999');
  assert.strictEqual(fmtCount(10000), '1万');
  assert.strictEqual(fmtCount(12000), '1.2万');
  assert.strictEqual(fmtCount(12345), '1.2万');
  assert.strictEqual(fmtCount(100000), '10万');
  assert.strictEqual(fmtCount(null), '0');
  assert.strictEqual(fmtCount(undefined), '0');
});

// ====== fmtTime ======
test('fmtTime 时间格式化', () => {
  // 与本地时区无关：动态构造期望值，验证格式与字段正确
  const ts = 1754985600;
  const d = new Date(ts * 1000);
  const p = n => String(n).padStart(2, '0');
  const expected = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  assert.strictEqual(fmtTime(ts), expected);
  assert.strictEqual(fmtTime(null), '');
  assert.strictEqual(fmtTime(undefined), '');
});

// ====== charWpx / measureText ======
test('charWpx CJK 全角宽度', () => {
  assert.strictEqual(charWpx('中', 10), 10);      // CJK = 1em
  assert.strictEqual(charWpx('a', 10), 5.5);      // ASCII = 0.55em
  assert.strictEqual(charWpx('！', 10), 10);      // 全角符号
  assert.strictEqual(charWpx('\n', 10), 6);       // 控制字符兜底
});

test('measureText 混合文本', () => {
  // 'AB中' = 5.5 + 5.5 + 10 = 21
  assert.strictEqual(measureText('AB中', 10), 21);
  assert.strictEqual(measureText('', 10), 0);
});

// ====== tokenize ======
test('tokenize 无表情 → 纯文本', () => {
  const t = tokenize('你好世界', {});
  assert.deepStrictEqual(t, [{ type: 'text', text: '你好世界' }]);
});

test('tokenize 表情内联拆分', () => {
  const t = tokenize('开心[大笑]了', { '[大笑]': { text: '大笑', url: '//i0.hdslb.com/x.png' } });
  assert.strictEqual(t.length, 3);
  assert.strictEqual(t[0].type, 'text');
  assert.strictEqual(t[0].text, '开心');
  assert.strictEqual(t[1].type, 'emote');
  assert.strictEqual(t[1].key, '[大笑]');
  assert.strictEqual(t[1].url, 'https://i0.hdslb.com/x.png'); // // 归一化
  assert.strictEqual(t[2].text, '了');
});

test('tokenize 表情在开头/结尾/多个', () => {
  const em = { '[a]': { url: '//x/1.png' }, '[b]': { url: '//x/2.png' } };
  const t = tokenize('[a]中间[b]', em);
  assert.deepStrictEqual(t.map(x => x.type), ['emote', 'text', 'emote']);
  const t2 = tokenize('[a][b]', em);
  assert.strictEqual(t2.length, 2);
});

// ====== wrapTokens ======
test('wrapTokens 超宽换行', () => {
  const tokens = [{ type: 'text', text: '一二三四五六七八九十' }];
  // 宽度 30，字号 10 → 每行 3 个字
  const lines = wrapTokens(tokens, 30, 10);
  assert.strictEqual(lines.length, 4);
  assert.strictEqual(lines[0].filter(x => x.type === 'char').length, 3);
});

test('wrapTokens 硬换行', () => {
  const tokens = [{ type: 'text', text: '第一行\n第二行' }];
  const lines = wrapTokens(tokens, 1000, 10);
  assert.strictEqual(lines.length, 2);
});

test('wrapTokens 表情参与换行', () => {
  const tokens = [
    { type: 'text', text: '哈哈哈哈' },
    { type: 'emote', key: '[a]', text: 'a', url: '', w: 40 },
    { type: 'text', text: '呵呵' },
  ];
  const lines = wrapTokens(tokens, 60, 10); // 40(字) + 44(表情) > 60 → 表情换行
  assert.ok(lines.length >= 2);
});

// ====== wrapTokens 禁则（行首/行尾禁排） ======
test('禁则：收尾标点不出现在行首（宁超宽不断开）', () => {
  const tokens = [{ type: 'text', text: '你好世界，新的一天' }];
  const lineText = line => line.map(t => (t.type === 'char' ? t.ch : t.text)).join('');
  const lines = wrapTokens(tokens, 45, 10); // 4 字(40px) + 逗号(10px) 超宽 → 逗号仍需随前行
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lineText(lines[0]), '你好世界，');
  assert.strictEqual(lineText(lines[1]), '新的一天');
});

test('禁则：开头标点不孤立在行尾（与后随字符同线）', () => {
  const tokens = [{ type: 'text', text: '看（大图' }];
  const lineText = line => line.map(t => (t.type === 'char' ? t.ch : t.text)).join('');
  const lines = wrapTokens(tokens, 25, 10); // 「看（」放不下「大」时不断开，「（大」同行
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lineText(lines[0]), '看（大');
  assert.strictEqual(lineText(lines[1]), '图');
});

test('禁则：截断函数与换行函数规则一致（含标点文本）', () => {
  const tokens = [{ type: 'text', text: '他说：“今天很高兴，明天见！”然后再聊几句' }];
  const maxW = 80, fontSize = 10;
  const full = wrapTokens(tokens, maxW, fontSize);
  const lineText = line => line.map(t => (t.type === 'char' ? t.ch : t.text)).join('');
  for (const maxLines of [1, 2]) {
    const cut = wrapTokens(truncateTokensToLines(tokens, maxW, fontSize, maxLines), maxW, fontSize);
    assert.ok(cut.length <= maxLines, `不应超过 ${maxLines} 行，实际 ${cut.length}`);
  }
  const cutFull = wrapTokens(truncateTokensToLines(tokens, maxW, fontSize, full.length), maxW, fontSize);
  assert.deepStrictEqual(cutFull.map(lineText), full.map(lineText));
});

// ====== 渲染管线 ======
test('renderPng 输出有效 PNG', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <rect width="100" height="100" fill="#2b2140"/>
  </svg>`;
  const png = card.renderPng(svg, 1);
  assert.ok(Buffer.isBuffer(png));
  // PNG 魔数
  assert.strictEqual(png[0], 0x89);
  assert.strictEqual(png[1], 0x50);
  assert.strictEqual(png[2], 0x4e);
  assert.strictEqual(png[3], 0x47);
});

// ====== 回归测试：卡片渲染布局（issue: 头像不显示 / 正文偏移） ======

/** 构造最小 comment（可指定 avatar data URI 与正文） */
function mkComment(extra = {}) {
  return {
    rpid: '313472209520', author: '测试UP', ctime: 1754985600,
    like: 42, rcount: 7, message: '一二三四五六七八九十一二三四五六七八九十',
    emote: {}, pictures: [], avatar: '',
    _tokens: [{ type: 'text', text: '一二三四五六七八九十一二三四五六七八九十' }],
    _emoteImgs: {}, _picImgs: [],
    ...extra,
  };
}

/** 区域统计：返回 [平均R, 平均G, 平均B]（忽略透明像素） */
function regionAvg(img, x0, y0, w, h) {
  let n = 0, r = 0, g = 0, b = 0;
  for (let y = y0; y < Math.min(y0 + h, img.height); y++)
    for (let x = Math.max(0, x0); x < Math.min(x0 + w, img.width); x++) {
      const i = (y * img.width + x) * 4;
      if (img.px[i + 3] < 128) continue;
      n++; r += img.px[i]; g += img.px[i + 1]; b += img.px[i + 2];
    }
  return n ? [r / n, g / n, b / n] : null;
}

test('回归：clipPath 使用 objectBoundingBox（头像不被裁剪）', async () => {
  const svg = await card.buildSvg(mkComment(), [], {});
  assert.ok(svg.includes('clipPathUnits="objectBoundingBox"'));
  // 正文首个 <text> 应从 INNER_X=52 开始（修复前会右移整行宽度）
  assert.ok(/<text x="52" y="[0-9.]+" font-size="15"/.test(svg),
    `正文 text 起点应为 52，实际 SVG: ${svg.match(/<text x="[^"]+" y="[^"]+" font-size="15"/)?.[0] || '未找到'}`);
});

test('回归：UP主 徽标仅在评论作者为目标 UP 时显示（P1 无条件徽标修复）', async () => {
  // 粉丝发的置顶评论：不应显示 UP主 徽标
  const fan = await card.buildSvg(mkComment({ mid: 999999 }), [], { upMid: 401315430 });
  assert.ok(!fan.includes('>UP主</text>'), '粉丝评论不应出现 UP主 徽标');
  // 目标 UP 自己的评论：应显示 UP主 徽标
  const up = await card.buildSvg(mkComment({ mid: 401315430 }), [], { upMid: 401315430 });
  assert.ok(up.includes('>UP主</text>'), 'UP 自己的评论应显示 UP主 徽标');
  // 未提供 upMid 时：不显示徽标（无判断依据）
  const noUp = await card.buildSvg(mkComment({ mid: 401315430 }), [], {});
  assert.ok(!noUp.includes('>UP主</text>'), '未提供 upMid 时不应显示 UP主 徽标');
  // 字符串 upMid 与数字 mid 也能匹配（类型一致性）
  const strUp = await card.buildSvg(mkComment({ mid: 401315430 }), [], { upMid: '401315430' });
  assert.ok(strUp.includes('>UP主</text>'), '字符串 upMid 应匹配数字 mid');
});

test('回归：渲染后头像区域可见且正文起点对齐', async () => {
  // 用 resvg 自己生成 8x8 红色小图作为头像 data URI（无网络依赖）
  const tiny = card.renderPng('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#ff0000"/></svg>', 1);
  const avatarUri = `data:image/png;base64,${tiny.toString('base64')}`;
  const svg = await card.buildSvg(mkComment({ avatar: avatarUri }), [], {});
  const png = card.renderPng(svg);
  const img = parsePng(png);
  const scale = img.width / card.W; // 2x
  const s = v => Math.round(v * scale);
  const INNER_X = 52, avatarY = 94, avatarR = 20, bodyBaseline = 161; // 头像 40px、顶部 22px、正文 15px（基线 94+40+15×1.8）

  // 1) 头像圆心处应为红色（圆形裁剪区域内），修复前整个头像被裁掉
  const center = regionAvg(img, s(INNER_X + avatarR) - 2, s(avatarY + avatarR) - 2, 4, 4);
  assert.ok(center, '头像圆心区域应有像素');
  assert.ok(center[0] > 150 && center[1] < 100, `头像圆心应为红色，实际 ${center.map(v => v.toFixed(0))}`);

  // 2) 正文首行最左亮像素应贴近 INNER_X（修复前右移整行宽度）
  let firstX = -1;
  outer:
  for (let x = s(40); x < s(200); x++)
    for (let y = s(bodyBaseline - 6); y <= s(bodyBaseline + 2); y++) {
      const i = (y * img.width + x) * 4;
      if (img.px[i] + img.px[i + 1] + img.px[i + 2] > 500) { firstX = x; break outer; }
    }
  assert.ok(firstX >= 0, '首行应有文字像素');
  assert.ok(firstX <= s(INNER_X) + 6, `首行文字起点应贴近 ${s(INNER_X)}，实际 ${firstX}`);
});

test('toFileTs Unix 秒 → yyyyMMddHHmmss', () => {
  // 与本地时区无关：动态构造期望值
  const ts = 1754985600;
  const d = new Date(ts * 1000);
  const p = n => String(n).padStart(2, '0');
  const expected = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  assert.strictEqual(toFileTs(ts), expected);
  assert.strictEqual(toFileTs(null), '');
  assert.strictEqual(toFileTs(undefined), '');
});

// ====== 高度预算：防超长卡片 OOM（MAX_CARD_H） ======
test('buildUpTopSvg 高度预算：超长互动截断并给出提示', async () => {
  const mk = i => ({
    rpid: String(i), author: 'u' + i, mid: i, ctime: 1754985600, like: 1, message: 'x',
    emote: {}, pictures: [], avatar: '',
    _tokens: [{ type: 'text', text: '测试内容' }], _emoteImgs: {}, _picImgs: [],
  });
  const items = Array.from({ length: 200 }, (_, i) => ({ kind: 'reply', parent: null, upReply: mk(i) }));
  const svg = await card.buildUpTopSvg(mk('top'), items, [], { topN: 10 });
  assert.ok(svg.includes('卡片高度上限'), '应出现截断提示');
  const rendered = (svg.match(/>UP回复<\/text>/g) || []).length; // 每块的角标
  assert.ok(rendered < 200, `截断后不应渲染全部 200 块，实际 ${rendered}`);
  assert.ok(rendered > 0, '至少渲染一块');
});

// ====== 自定义分辨率（--scale / --width） ======
test('renderPng：自定义倍率输出对应像素宽度', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="680" height="100"><rect width="680" height="100" fill="#2b2140"/></svg>';
  assert.strictEqual(parsePng(card.renderPng(svg, 0.5)).width, 340);
  assert.strictEqual(parsePng(card.renderPng(svg, 1.5)).width, 1020);
  assert.strictEqual(parsePng(card.renderPng(svg, 2.5)).width, 1700);
  assert.strictEqual(parsePng(card.renderPng(svg, 6)).width, 4080);
});

test('maxCardHForScale：高度预算随倍率收紧（防高分辨率 OOM）', () => {
  assert.strictEqual(card.maxCardHForScale(2), 12000);
  assert.strictEqual(card.maxCardHForScale(1), 40000);
  assert.strictEqual(card.maxCardHForScale(4), 3000);
  assert.strictEqual(card.maxCardHForScale(6), 1333);
  assert.strictEqual(card.maxCardHForScale(undefined), 12000);
});

// ====== 四类卡片模板：SVG 结构不变量（渲染层重构保护网） ======

/** 构造互动项（kind='reply' 单 UP 回复，最简形态） */
function mkItem(i) {
  return { kind: 'reply', parent: null, upReply: mkComment({ rpid: `r${i}`, message: `互动内容 ${i}` }) };
}

test('结构：四类模板 SVG 外壳一致（尺寸与 viewBox 同步 / defs / 闭合）', async () => {
  const c = mkComment({ mid: 401315430 });
  const dyn = {
    latestId: 555, latestAuthor: '测试UP', latestDesc: '动态正文内容', latestTs: 1754985600,
    latestFace: '', latestImages: [], _picImgs: [], _picSizes: [],
  };
  const svgs = {
    '置顶评论卡': await card.buildSvg(c, [], {}),
    '互动回顾图': await card.buildUnpinnedSvg(c, [mkItem(1)], {}),
    'UP热评卡': await card.buildUpTopSvg(c, [mkItem(2)], [mkComment({ rpid: 'f1' })], { topN: 3 }),
    '动态更新卡': await card.buildDynamicSvg(dyn, {}),
  };
  for (const [name, svg] of Object.entries(svgs)) {
    const m = svg.match(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="([0-9]+)" height="([0-9]+)" viewBox="0 0 ([0-9]+) ([0-9]+)"/);
    assert.ok(m, `${name} 应以标准 svg 外壳开头，实际：${svg.slice(0, 90)}`);
    const [w, h, vw, vh] = m.slice(1).map(Number);
    assert.strictEqual(w, card.W, `${name} 宽度应为设计宽度`);
    assert.ok(h > 0, `${name} 高度应为正`);
    assert.strictEqual(vw, w, `${name} viewBox 宽应与 width 一致`);
    assert.strictEqual(vh, h, `${name} viewBox 高应与 height 一致`);
    assert.ok(svg.includes('<defs>') && svg.includes('fill="url(#bg)"'), `${name} 应含 defs 与背景`);
    assert.ok(svg.trimEnd().endsWith('</svg>'), `${name} 应正确闭合`);
  }
});

test('结构：区块顺序与数量徽标（UP 热评卡 / 置顶评论卡）', async () => {
  const c = mkComment({ rcount: 12345 });
  const upTop = await card.buildUpTopSvg(c, [mkItem(1)], [mkComment({ rpid: 'f1' })], { topN: 5 });
  const i1 = upTop.indexOf('UP回复上下文');
  const i2 = upTop.indexOf('高赞回复 TOP5');
  assert.ok(i1 >= 0 && i2 > i1, '「UP回复上下文」应排在「高赞回复 TOPN」之前');
  assert.ok(upTop.includes('1 条互动'), '区域一徽标应显示互动条数');
  // 置顶评论卡：徽标为「已出图回复数/该评论总回复数」
  const pinned = await card.buildSvg(c, [mkComment({ rpid: 'c1' })], { showReplies: true, upMid: 0 });
  assert.ok(pinned.includes('精彩回复'));
  assert.ok(pinned.includes('1/1.2万'), `徽标应为 1/1.2万，实际 SVG 片段：${pinned.match(/精彩回复[\s\S]{0,240}/)?.[0]}`);
});

test('结构：空态分支文案与其互斥性', async () => {
  const c = mkComment();
  const unpinned = await card.buildUnpinnedSvg(c, [], {});
  assert.ok(unpinned.includes('该评论区暂无 UP 互动'), '无互动时应渲染空态块');
  assert.ok(!unpinned.includes('>被UP回复</text>'), '空态时不应渲染互动块');

  const upTop = await card.buildUpTopSvg(c, [], [], { topN: 7 });
  assert.ok(upTop.includes('暂无 UP 互动') && upTop.includes('暂无高赞回复'), '两个区域都应渲染空态块');

  const pinned = await card.buildSvg(c, [], { showReplies: true });
  assert.ok(!pinned.includes('精彩回复'), 'showReplies 但无回复时不应渲染回复区');
});

test('结构：互动链超长截断（回顾图与热评卡共用同一截断规则）', async () => {
  const items = Array.from({ length: 200 }, (_, i) => mkItem(i));
  const unpinned = await card.buildUnpinnedSvg(mkComment(), items, {});
  assert.ok(unpinned.includes('卡片高度上限'), '应出现截断提示');
  const rendered = (unpinned.match(/>UP回复<\/text>/g) || []).length;
  assert.ok(rendered > 0 && rendered < 200, `应截断渲染而非全量，实际 ${rendered}`);
  assert.ok(/…还有 \d+ 条互动未展示/.test(unpinned), '截断提示文案应为「互动」');

  const fans = Array.from({ length: 200 }, (_, i) => mkComment({ rpid: `f${i}` }));
  const upTop = await card.buildUpTopSvg(mkComment(), [], fans, { topN: 200 });
  assert.ok(/…还有 \d+ 条高赞回复未展示/.test(upTop), '截断提示文案应为「高赞回复」');
});

test('结构：图片网格按三列排布且缺图补占位矩形', async () => {
  const pics = [1, 2, 3, 4].map(i => ({ url: 'u' + i }));
  const svg = await card.buildSvg(mkComment({ pictures: pics, _picImgs: ['d', '', '', ''], _picSizes: [] }), [], {});
  const imgs = [...svg.matchAll(/<image href="[^"]*" x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="[0-9.]+" clip-path="url\(#imgClip\)"/g)];
  assert.strictEqual(imgs.length, 4, '4 张图都应产出网格元素（缺图以空 href 占位）');
  const rects = [...svg.matchAll(/<rect x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="[0-9.]+" fill="rgba\(255,255,255,0\.06\)"/g)];
  assert.strictEqual(rects.length, 3, '缺图的 3 张应补占位矩形');
  const [x0, y0, w0] = imgs[0].slice(1).map(Number);
  const [x1, y1] = imgs[1].slice(1).map(Number);
  const [x3, y3] = imgs[3].slice(1).map(Number);
  assert.strictEqual(x0, card.INNER_X, '网格起始 x 应为正文左边距');
  assert.strictEqual(y1, y0, '首行两图 y 应相同');
  assert.ok(x1 > x0, '同行下一张应右移');
  assert.ok(y3 > y0, '第 4 张应换行到下一行');
  assert.strictEqual(x3, x0, '换行后应回到首列 x');
  assert.ok(x1 + w0 <= card.INNER_X + card.INNER_W + 0.01, '三列应能在一行内排下');
});

test('saveCard：文件名规则与 latest 副本落盘', () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bpc-save-'));
  try {
    const png = Buffer.from('fake-png-bytes');
    const file = card.saveCard(png, { outDir: dir, prefix: 'pinned-card', id: '123', latest: 'latest.png', ts: '20250925010101' });
    assert.strictEqual(nodePath.basename(file), 'pinned-card_20250925010101_123.png');
    assert.strictEqual(nodePath.dirname(file), dir);
    assert.deepStrictEqual(fs.readFileSync(file), png);
    assert.deepStrictEqual(fs.readFileSync(nodePath.join(dir, 'latest.png')), png);
    // ts 缺失 → 用 14 位生成时间戳兜底（文件名仍合法）
    const fb = card.saveCard(png, { outDir: dir, prefix: 'up-top', id: '456', latest: 'latest-up-top.png', ts: '' });
    assert.ok(/^up-top_\d{14}_456\.png$/.test(nodePath.basename(fb)), `实际 ${nodePath.basename(fb)}`);
    assert.deepStrictEqual(fs.readFileSync(nodePath.join(dir, 'latest-up-top.png')), png);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ====== 文本换行规则一致性（防 wrapTokens / truncateTokensToLines 规则漂移） ======
test('文本：truncateTokensToLines 与 wrapTokens 换行规则一致', () => {
  const tokens = [{ type: 'text', text: '这是一段用于验证换行规则一致性的长正文内容'.repeat(4) }];
  const maxW = 200, fontSize = 13.5;
  const full = wrapTokens(tokens, maxW, fontSize);
  const lineText = line => line.map(t => (t.type === 'char' ? t.ch : `[${t.text}]`)).join('');

  for (const maxLines of [1, 2, 3, 5, 20]) {
    const cutLines = wrapTokens(truncateTokensToLines(tokens, maxW, fontSize, maxLines), maxW, fontSize);
    assert.ok(cutLines.length <= maxLines, `不应超过 ${maxLines} 行，实际 ${cutLines.length}`);
    const n = Math.min(cutLines.length, full.length);
    let diffIdx = -1;
    for (let i = 0; i < n; i++) if (lineText(cutLines[i]) !== lineText(full[i])) { diffIdx = i; break; }
    if (full.length > maxLines) {
      assert.ok(diffIdx >= 0, `超限时应发生截断（maxLines=${maxLines}）`);
      assert.ok(lineText(cutLines[diffIdx]).includes('…'), '发生差异的行应为省略号截断行');
    } else {
      assert.strictEqual(cutLines.length, full.length, `未超限时行数不应变化（maxLines=${maxLines}）`);
      assert.strictEqual(diffIdx, -1, `未超限时内容不应改动（maxLines=${maxLines}）`);
    }
  }
});
