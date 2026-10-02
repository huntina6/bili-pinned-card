'use strict';
/**
 * 内容规则匹配（借鉴 goban 的关键字/正则过滤）
 * 用途：置顶监测模式下，仅当置顶评论正文（及普通动态正文）命中规则时才出图与推送通知。
 * 未配置规则时 matchRules 恒命中，v1.5.0 缺省行为零变化。
 * 语法：纯关键字（子串匹配，忽略大小写）或 /正则/flags（如 /置顶|抽奖/i）。
 * 模式：any = 任一命中（默认）/ all = 全部命中。
 * 纯函数、零依赖，便于单测；正则编译失败会抛出可读异常而不是静默失效。
 */

/**
 * @typedef {object} RuleMatcher
 * @property {string} raw 原始规则串
 * @property {'keyword'|'regex'} type 规则类型
 * @property {string} source 关键字内容 / 正则体
 * @property {(text: string) => boolean} test 匹配函数
 */

/**
 * 解析并编译单条规则
 * @param {string|RuleMatcher} raw 规则串（已是 RuleMatcher 时原样返回）
 * @returns {RuleMatcher}
 */
function parseRule(raw) {
  if (raw && typeof raw === 'object' && typeof raw.test === 'function') return raw;
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('规则不能为空');
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(text);
  if (m) {
    const body = m[1];
    const flags = m[2];
    /** @type {RegExp} */
    let re;
    try {
      re = new RegExp(body, flags);
    } catch (e) {
      throw new Error(`正则规则非法 ${text}：${e.message}`);
    }
    return {
      raw: text, type: 'regex', source: body,
      // 每次匹配前复位 lastIndex，避免带 g 标志的 RegExp 在多次 test 间产生状态串扰
      test: s => { re.lastIndex = 0; return re.test(s); },
    };
  }
  const lower = text.toLowerCase();
  return { raw: text, type: 'keyword', source: text, test: s => String(s).toLowerCase().includes(lower) };
}

/**
 * 编译规则列表（去重并保持顺序）
 * @param {Array<string|RuleMatcher>|string|null|undefined} list
 * @returns {RuleMatcher[]}
 */
function compileRules(list) {
  const arr = Array.isArray(list) ? list : (list == null || list === '' ? [] : [list]);
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const r = parseRule(raw);
    if (seen.has(r.raw)) continue;
    seen.add(r.raw);
    out.push(r);
  }
  return out;
}

/**
 * 文本命中判定；未配置规则时恒命中（保持既有行为）
 * @param {Array<string|RuleMatcher>|null|undefined} rules
 * @param {'any'|'all'|string|undefined} mode 组合方式（any=任一命中，默认）
 * @param {string} text
 * @returns {{hit: boolean, matched: string[]}}
 */
function matchRules(rules, mode, text) {
  const list = compileRules(rules);
  if (!list.length) return { hit: true, matched: [] };
  const s = String(text == null ? '' : text);
  const matched = list.filter(r => r.test(s)).map(r => r.raw);
  const hit = mode === 'all' ? matched.length === list.length : matched.length > 0;
  return { hit, matched };
}

module.exports = { parseRule, compileRules, matchRules };
