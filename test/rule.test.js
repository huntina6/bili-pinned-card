'use strict';
/**
 * 内容规则匹配测试（纯函数，零网络）
 * 覆盖：关键字/正则解析、非法正则报错、去重、any/all 组合、未配置恒命中、g 标志状态隔离
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRule, compileRules, matchRules } = require('../lib/rule');

test('parseRule：关键字子串匹配且忽略大小写', () => {
  const r = parseRule('抽奖');
  assert.strictEqual(r.type, 'keyword');
  assert.strictEqual(r.test('今晚有抽奖活动'), true);
  assert.strictEqual(r.test('无相关词'), false);
  const en = parseRule('Giveaway');
  assert.strictEqual(en.test('free GIVEAWAY now'), true, '英文关键字忽略大小写');
});

test('parseRule：/正则/flags 解析并生效', () => {
  const r = parseRule('/置顶|预告/i');
  assert.strictEqual(r.type, 'regex');
  assert.strictEqual(r.source, '置顶|预告');
  assert.strictEqual(r.test('本次置顶说明'), true);
  assert.strictEqual(r.test('PREVIEW 预告'), true);
  assert.strictEqual(r.test('无关内容'), false);
});

test('parseRule：非法正则与空规则抛出可读异常', () => {
  assert.throws(() => parseRule('/([a-z/'), /正则规则非法/);
  assert.throws(() => parseRule('   '), /规则不能为空/);
});

test('parseRule：已是编译产物时原样返回（幂等）', () => {
  const r = parseRule('测试');
  assert.strictEqual(parseRule(r), r);
});

test('parseRule：带 g 标志的正则多次 test 不串扰（lastIndex 复位）', () => {
  const r = parseRule('/a/g');
  assert.strictEqual(r.test('aaa'), true);
  assert.strictEqual(r.test('aaa'), true, '第二次仍应为 true');
  assert.strictEqual(r.test('bbb'), false);
});

test('compileRules：支持单串/数组，去重且保持顺序', () => {
  assert.deepStrictEqual(compileRules('抽奖').map(r => r.raw), ['抽奖']);
  assert.deepStrictEqual(compileRules(['b', 'a', 'b']).map(r => r.raw), ['b', 'a']);
  assert.deepStrictEqual(compileRules(null), []);
  assert.deepStrictEqual(compileRules(''), []);
});

test('matchRules：未配置规则时恒命中（缺省行为零变化）', () => {
  assert.deepStrictEqual(matchRules([], 'any', '任意文本'), { hit: true, matched: [] });
  assert.deepStrictEqual(matchRules(null, 'any', ''), { hit: true, matched: [] });
});

test('matchRules：any 任一命中即通过', () => {
  const rules = ['抽奖', '/预告/i'];
  assert.deepStrictEqual(matchRules(rules, 'any', '这是一条预告'), { hit: true, matched: ['/预告/i'] });
  assert.strictEqual(matchRules(rules, 'any', '抽奖啦').hit, true);
  assert.strictEqual(matchRules(rules, 'any', '普通评论').hit, false);
});

test('matchRules：all 需全部命中', () => {
  const rules = ['抽奖', '置顶'];
  assert.strictEqual(matchRules(rules, 'all', '抽奖并置顶').hit, true);
  const partial = matchRules(rules, 'all', '仅抽奖');
  assert.strictEqual(partial.hit, false);
  assert.deepStrictEqual(partial.matched, ['抽奖']);
});

test('matchRules：mode 缺省按 any 处理，null 文本安全', () => {
  assert.strictEqual(matchRules(['a'], undefined, 'bab').hit, true);
  assert.strictEqual(matchRules(['a'], undefined, null).hit, false);
  assert.strictEqual(matchRules(['a'], 'all', null).matched.length, 0);
});
