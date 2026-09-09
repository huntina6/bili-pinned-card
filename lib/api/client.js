'use strict';
/**
 * B站 API 请求层 —— 零依赖（Node >= 18 内置 fetch）
 * 匿名访问：自动获取 buvid3/buvid4 防风控；
 * 可选 SESSDATA Cookie：解锁「自动识别置顶动态」等需要登录的接口。
 */

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

// ====== 请求节流：业务 API 每次调用前置 1~2s 随机延迟（规避 B站 频率风控 -352/-412） ======
const THROTTLE_MIN = 1000;   // 固定 1s
const THROTTLE_JITTER = 1000; // +0~1s 随机
let throttleEnabled = true;
/** 开关节流（测试中 mock fetch 无真实请求，关闭避免拖慢） */
function setThrottle(enabled) { throttleEnabled = !!enabled; }
async function throttleDelay() {
  if (!throttleEnabled) return;
  await new Promise(r => setTimeout(r, THROTTLE_MIN + Math.random() * THROTTLE_JITTER));
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
  if (throttle) await throttleDelay();
  const headers = { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' };
  if (cookie) headers['Cookie'] = cookie;
  if (referer) headers['Referer'] = referer;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!data) throw new BiliError(`响应不是 JSON（HTTP ${res.status}，可能被风控）: ${text.slice(0, 100)}`, res.status);
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
};
