'use strict';
/**
 * WBI 签名 —— B站 2023+ 接口签名风控方案
 * nav 接口获取 img_key/sub_key → MIXIN_TAB 混淆取前 32 为 mixinKey →
 * 参数按 key 字母序拼串（值 URL 编码）+ wts 时间戳 → md5(串 + mixinKey) 得 w_rid
 * 依赖方向：comment → wbi → client（无环）
 */
const crypto = require('crypto');
const { BiliError, httpJson } = require('./client');

/** 标准混淆表（公开资料一致，勿改顺序） */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const CACHE_TTL = 3600 * 1000; // 1 小时
let _cache = null; // { mixinKey, expireAt }

/** img_key + sub_key → mixinKey（取混淆表前 32 位） */
function getMixinKey(imgKey, subKey) {
  const s = String(imgKey || '') + String(subKey || '');
  let out = '';
  for (let i = 0; i < 32; i++) {
    const idx = MIXIN_TAB[i];
    if (idx >= s.length) break;
    out += s[idx];
  }
  return out;
}

/** 获取（缓存 1h）mixinKey */
async function getWbiKey(cookie) {
  if (_cache && _cache.expireAt > Date.now()) return _cache.mixinKey;
  const d = await httpJson('https://api.bilibili.com/x/web-interface/nav', {
    cookie,
    referer: 'https://www.bilibili.com/',
  });
  const img = d?.data?.wbi_img?.img_url;
  const sub = d?.data?.wbi_img?.sub_url;
  if (!img || !sub) {
    throw new BiliError(`获取 WBI 密钥失败（nav code=${d?.code}: ${d?.message || '无 wbi_img'}）`, d?.code);
  }
  const mixinKey = getMixinKey(
    img.split('/').pop().split('.')[0],
    sub.split('/').pop().split('.')[0]
  );
  _cache = { mixinKey, expireAt: Date.now() + CACHE_TTL };
  return mixinKey;
}

/** 测试钩子：清空密钥缓存 */
function _resetWbiCache() {
  _cache = null;
}

/**
 * 生成带 wbi 签名的查询串
 * @param {object} params 业务参数（不含 wts/w_rid）
 * @param {string} cookie 请求 Cookie（用于拉取密钥）
 * @param {object} [opts] { wts, mixinKey } 可注入（测试用）
 * @returns {Promise<string>} 如 `mode=3&oid=1&wts=...&w_rid=...`（含签名）
 */
async function wbiQuery(params, cookie, { wts, mixinKey } = {}) {
  const key = mixinKey || await getWbiKey(cookie);
  const ts = wts ?? Math.floor(Date.now() / 1000);
  const entries = Object.entries({ ...params, wts: ts });
  // 按 key 字母序（签名与 URL 参数必须同一编码）
  const sorted = entries
    .map(([k, v]) => [k, v == null ? '' : String(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = sorted.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const w_rid = crypto.createHash('md5').update(qs + key).digest('hex');
  return `${qs}&w_rid=${w_rid}`;
}

module.exports = {
  MIXIN_TAB,
  getMixinKey,
  getWbiKey,
  wbiQuery,
  _resetWbiCache,
};
