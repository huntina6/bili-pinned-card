'use strict';
/**
 * WBI 签名 —— B站 2023+ 接口签名风控方案
 * nav 接口获取 img_key/sub_key → MIXIN_TAB 混淆取前 32 为 mixinKey →
 * 参数按 key 字母序拼串（值 URL 编码）+ wts 时间戳 → md5(串 + mixinKey) 得 w_rid
 * 依赖方向：comment → wbi → client（无环）
 * 缓存：内存 1h + 文件 12h（跨进程复用，减少 nav 请求暴露；文件丢失/损坏自动回退 nav）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { BiliError, httpJson } = require('./client');

/** 标准混淆表（公开资料一致，勿改顺序） */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const MEM_TTL = 3600 * 1000;        // 内存缓存 1 小时
const FILE_TTL = 12 * 3600 * 1000;  // 文件缓存 12 小时（跨进程）
let _cache = null; // { mixinKey, expireAt }
let _dir = process.env.BILI_WBI_DIR || path.join(os.homedir(), '.bili-pinned-card');

/** 测试钩子：重定向缓存目录（隔离真实 ~/.bili-pinned-card） */
function setDir(dir) { _dir = dir; }
function cacheFile() { return path.join(_dir, 'wbi.json'); }

/** 读文件缓存；命中回填内存（取内存与文件过期时间的较小者） */
function loadFromFile() {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(), 'utf-8'));
    if (j && j.mixinKey && j.expireAt > Date.now()) {
      _cache = { mixinKey: j.mixinKey, expireAt: Math.min(j.expireAt, Date.now() + MEM_TTL) };
      return _cache.mixinKey;
    }
  } catch { /* 文件不存在/损坏 → 回退 nav */ }
  return null;
}

/** 写文件缓存（失败静默：缓存丢失仅多一次 nav 请求） */
function saveToFile(mixinKey) {
  try {
    fs.mkdirSync(_dir, { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify({ mixinKey, expireAt: Date.now() + FILE_TTL }), 'utf-8');
  } catch { /* 忽略 */ }
}

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

/** 获取 mixinKey：内存(1h) → 文件(12h) → nav 拉取（并写回两级缓存） */
async function getWbiKey(cookie) {
  if (_cache && _cache.expireAt > Date.now()) return _cache.mixinKey;
  const fromFile = loadFromFile();
  if (fromFile) return fromFile;
  const d = await httpJson('https://api.bilibili.com/x/web-interface/nav', {
    cookie,
    referer: 'https://www.bilibili.com/',
    throttle: false, // 签名密钥需即时获取（缓存命中时不发请求），实际评论请求仍在 comment.js 走节流
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
  _cache = { mixinKey, expireAt: Date.now() + MEM_TTL };
  saveToFile(mixinKey);
  return mixinKey;
}

/** 测试钩子：清空密钥缓存（默认清内存+文件；keepFile=true 仅清内存，用于验证文件命中） */
function _resetWbiCache({ keepFile = false } = {}) {
  _cache = null;
  if (!keepFile) { try { fs.unlinkSync(cacheFile()); } catch { /* 不存在即忽略 */ } }
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
  setDir,
  _resetWbiCache,
};
