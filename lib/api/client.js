'use strict';
/**
 * B站 API 请求层 —— 零依赖（Node >= 18 内置 fetch）
 * 匿名访问：自动获取 buvid3/buvid4 防风控；
 * 可选 SESSDATA Cookie：解锁「自动识别置顶动态」等需要登录的接口。
 */
const logger = require('../logger'); // 请求摘要/错误落盘（debug 级需 --verbose）

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

class BiliError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = 'BiliError';
  }
}

let _anonCookie = null;
let _anonCookiePromise = null; // in-flight 去重：并发首调只发一次 SPI 请求

// ====== 请求节流：业务 API 每次调用前置随机延迟（正态分布，规避 B站 频率风控 -352/-412） ======
// 按接口差异化：动态检索最保守（近期 -412 触发点）> 子回复翻页 > 评论列表 > 默认
const THROTTLE_PROFILES = [
  { re: /\/x\/v2\/reply\/reply/, mean: 2000, std: 500, min: 1500, max: 3500 },              // 子回复翻页
  { re: /\/x\/v2\/reply/, mean: 1500, std: 450, min: 1000, max: 2500 },                    // 评论列表（含 wbi/main）
  { re: /web-dynamic\/v1\/feed\/space/, mean: 3000, std: 800, min: 2000, max: 5000 },      // 动态检索（最保守）
];
const THROTTLE_DEFAULT = { mean: 1500, std: 450, min: 1000, max: 2500 };
let throttleEnabled = true;
let _rng = Math.random; // 可注入（测试用）

/** 开关节流（测试中 mock fetch 无真实请求，关闭避免拖慢） */
function setThrottle(enabled) { throttleEnabled = !!enabled; }
/** 测试钩子：注入随机源（返回 [0,1)）；传 null 恢复 Math.random */
function setRng(fn) { _rng = typeof fn === 'function' ? fn : Math.random; }

/** 按 URL 选择节流档位（细粒度优先） */
function pickProfile(url) {
  const u = String(url);
  for (const p of THROTTLE_PROFILES) if (p.re.test(u)) return p;
  return THROTTLE_DEFAULT;
}
/** Box-Muller 标准正态采样 */
function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = _rng();
  while (v === 0) v = _rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** 计算某 URL 的节流延迟（毫秒；纯计算，供测试断言） */
function computeDelay(url) {
  const p = pickProfile(url);
  return Math.min(p.max, Math.max(p.min, p.mean + gaussian() * p.std));
}
async function throttleDelay(url) {
  if (!throttleEnabled) return;
  await new Promise(r => setTimeout(r, computeDelay(url)));
}

/** 匿名获取 buvid（SPI 接口，无需登录） */
async function anonCookie() {
  if (_anonCookie) return _anonCookie;
  if (_anonCookiePromise) return _anonCookiePromise;
  _anonCookiePromise = (async () => {
    // SPI 一次性请求：跳过前置节流（自身仅首调一次）
    const d = await httpJson('https://api.bilibili.com/x/frontend/finger/spi', { throttle: false });
    const b3 = d?.data?.b_3;
    const b4 = d?.data?.b_4;
    if (!b3) throw new BiliError('获取 buvid 失败');
    _anonCookie = `buvid3=${b3}; buvid4=${b4 || ''}`;
    return _anonCookie;
  })().finally(() => { _anonCookiePromise = null; });
  return _anonCookiePromise;
}

/** 合并多段 Cookie（后者覆盖前者同名键） */
function mergeCookie(...parts) {
  const map = new Map();
  for (const p of parts) {
    if (!p) continue;
    for (const kv of String(p).split(';')) {
      const i = kv.indexOf('=');
      if (i < 0) continue;
      map.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * 底层 JSON 请求。throttle=true 时每次调用前置 1~2s 随机延迟——
 * 评论/动态等业务接口默认开启；自有节奏的请求（登录轮询、SPI、wbi 密钥等）显式传 false
 */
async function httpJson(url, { cookie, referer, throttle = true } = {}) {
  if (throttle) await throttleDelay(url);
  const headers = { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' };
  if (cookie) headers['Cookie'] = cookie;
  if (referer) headers['Referer'] = referer;
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    logger.error(`HTTP ${logger.sanitizeUrl(url)} 网络失败: ${e.message}（${Date.now() - t0}ms）`);
    throw e;
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  const ms = Date.now() - t0;
  if (!data) {
    // 常见于被 WAF/CDN 拦回 HTML（风控特征：feed/space 高频后返回 <!DOCTYPE）
    logger.warn(`HTTP ${logger.sanitizeUrl(url)} 响应非 JSON（HTTP ${res.status}，可能被风控）: ${text.slice(0, 60).replace(/\s+/g, ' ')}（${ms}ms）`);
    throw new BiliError(`响应不是 JSON（HTTP ${res.status}，可能被风控）: ${text.slice(0, 100)}`, res.status);
  }
  const code = data.code;
  logger.debug(`HTTP ${logger.sanitizeUrl(url)} → HTTP ${res.status} code=${code} ${(data.message || '').slice(0, 40)}（${ms}ms）`);
  if (code === -352 || code === -412 || code === -799) {
    logger.warn(`风控 code=${code}: ${data.message || ''} @ ${logger.sanitizeUrl(url)}（${ms}ms）`);
  } else if (code === -101) {
    logger.error(`Cookie 失效 (-101): ${data.message || ''} @ ${logger.sanitizeUrl(url)}`);
  }
  return data;
}

/** B站标准 API 请求（自动带 buvid，统一处理风控/错误码） */
async function apiGet(urlPath, { cookie, referer } = {}) {
  const full = mergeCookie(await anonCookie(), cookie);
  const data = await httpJson('https://api.bilibili.com' + urlPath, { cookie: full, referer });
  if (data.code === -352 || data.code === -412 || data.code === -799) {
    throw new BiliError(`风控 code=${data.code}: ${data.message || '请求被拦截'}`, data.code);
  }
  if (data.code === -101) throw new BiliError('Cookie 已失效 (-101)，请更新 SESSDATA', -101);
  if (data.code !== 0) throw new BiliError(`API code=${data.code}: ${data.message || ''}`, data.code);
  return data;
}

module.exports = {
  BiliError,
  UA,
  anonCookie,
  mergeCookie,
  httpJson,
  apiGet,
  setThrottle,
  setRng,
  pickProfile,
  computeDelay,
  _throttleDelay: throttleDelay, // 测试钩子：验证开关语义（不经过 fetch）
};
