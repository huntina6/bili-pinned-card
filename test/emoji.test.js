'use strict';
/**
 * emoji 模块测试（零网络）：grapheme 切分 / twemoji 映射 / 熔断 / 与分词渲染集成
 */
const test = require('node:test');
const assert = require('node:assert');
const emoji = require('../lib/card/emoji');
const { tokenize, lineToSvg, wrapTokens } = require('../lib/card/text');

test.beforeEach(() => { emoji.setEnabled(true); });

test('isEmoji：表情/肤色/ZWJ/旗帜判定为真，汉字数字为假', () => {
  assert.strictEqual(emoji.isEmoji('😀'), true);
  assert.strictEqual(emoji.isEmoji('👍🏻'), true);
  assert.strictEqual(emoji.isEmoji('👨‍👩‍👧'), true);
  assert.strictEqual(emoji.isEmoji('🇨🇳'), true);
  assert.strictEqual(emoji.isEmoji('中'), false);
  assert.strictEqual(emoji.isEmoji('A'), false);
  assert.strictEqual(emoji.isEmoji('1'), false);
  assert.strictEqual(emoji.isEmoji(''), false);
});

test('emojiKey：单个/肤色/ZWJ 序列/变体选择符/旗帜', () => {
  assert.strictEqual(emoji.emojiKey('😀'), '1f600');
  assert.strictEqual(emoji.emojiKey('👍🏻'), '1f44d-1f3fb');
  assert.strictEqual(emoji.emojiKey('👨‍👩‍👧'), '1f468-200d-1f469-200d-1f467');
  assert.strictEqual(emoji.emojiKey('❤️'), '2764'); // FE0F 去掉
  assert.strictEqual(emoji.emojiKey('🇨🇳'), '1f1e8-1f1f3');
});

test('segmentText：中英混排 + emoji 分段', () => {
  const segs = emoji.segmentText('hi😀中');
  assert.deepStrictEqual(segs.map(s => s.text), ['h', 'i', '😀', '中']);
  assert.strictEqual(segs[2].emoji, true);
  assert.ok(segs[2].url.includes('1f600.png'));
});

test('tokenize：unicode emoji 变成 emote token（unicode 标记）', () => {
  const t = tokenize('hi😀!', {});
  assert.deepStrictEqual(t.map(x => x.type), ['text', 'emote', 'text']);
  assert.strictEqual(t[1].unicode, true);
  assert.strictEqual(t[1].text, '😀');
  assert.ok(t[1].url.includes('1f600.png'));
  assert.deepStrictEqual([t[0].text, t[2].text], ['hi', '!']);
});

test('tokenize：B站表情 [xx] 与 unicode emoji 可混排', () => {
  const t = tokenize('😀[大笑]🎉', { '[大笑]': { text: '大笑', url: '//i0.hdslb.com/x.png' } });
  const types = t.map(x => x.type);
  assert.deepStrictEqual(types, ['emote', 'emote', 'emote']);
  assert.strictEqual(t[0].unicode, true);
  assert.strictEqual(t[1].unicode, undefined);
  assert.strictEqual(t[2].unicode, true);
});

test('熔断：setEnabled(false) 后 tokenize 保留原文，不生成图片 token', () => {
  emoji.setEnabled(false);
  const t = tokenize('hi😀!', {});
  assert.deepStrictEqual(t, [{ type: 'text', text: 'hi😀!' }]);
  assert.strictEqual(emoji.emojiUrl('😀'), '');
});

test('lineToSvg：emoji 图片存在时输出 <image>，缺失时回退原字符（非 [占位]）', () => {
  const t = tokenize('😀', {});
  const line = wrapTokens(t, 200, 15)[0];
  const withImg = lineToSvg(line, 15, 0, 20, { '😀': 'data:image/png;base64,xx' });
  assert.ok(withImg.includes('<image'));
  const noImg = lineToSvg(line, 15, 0, 20, {});
  assert.ok(noImg.includes('😀'), '回退应输出原始 emoji 字符');
  assert.ok(!noImg.includes('[😀]'), '不应输出 [占位]');
});

test('wrapTokens：unicode emoji 按字号宽度参与换行（不按 36px 表情块）', () => {
  const tokens = tokenize('😀😀😀😀😀', {});
  const lines = wrapTokens(tokens, 60, 15); // 每个约 20px → 每行约 3 个
  assert.ok(lines.length >= 2, `应换行，实际 ${lines.length} 行`);
});
