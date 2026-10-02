'use strict';
/**
 * B站 API 请求层 —— 零依赖（Node >= 18 内置 fetch）
 * 匿名访问：自动获取 buvid3/buvid4 防风控；
 * 可选 SESSDATA Cookie：解锁「自动识别置顶动态」等需要登录的接口。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
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

// ====== buvid 设备指纹持久化：内存 → 文件 → SPI 网络请求 ======
// 风控按 buvid 维度关联请求。--watch 长驻进程内复用一份指纹没问题，但 cron/--once
// 每次都是新进程：若每次都重新调 SPI 取一对新 buvid3/buvid4，等于「每次来访都换一台
// 设备」，反而是典型的机器人特征，也抵消了扫码登录换来的干净设备身份。
// 故与 ticket.json / wbi.json 一致落盘复用。
const BUVID_DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天（SPI 不返回 ttl，取保守值）
const BUVID_EXPIRE_MARGIN_MS = 60 * 1000;           // 提前 1 分钟过期，避免边界失效
const BUVID_STALE_RETRY_MS = 10 * 60 * 1000;        // 降级复用过期指纹后，多久才再试一次 SPI
let _buvidDir = process.env.BILI_BUVID_DIR || path.join(os.homedir(), '.bili-pinned-card');
let _buvidExpireAt = 0; // 当前内存指纹的过期时刻（0 = 无有效内存缓存）

function buvidCacheFile() { return path.join(_buvidDir, 'buvid.json'); }

/** 测试钩子：重定向缓存目录（隔离真实 ~/.bili-pinned-card） */
function setBuvidDir(dir) {
  _buvidDir = dir;
  _anonCookie = null;
  _anonCookiePromise = null;
  _buvidExpireAt = 0;
}

/**
 * 读文件缓存。返回 { cookie, expireAt, expired } 或 null（不存在/损坏）。
 * 不过滤过期项：调用方需要过期值做网络失败时的降级复用。
 */
function readBuvidFile() {
  try {
    const j = JSON.parse(fs.readFileSync(buvidCacheFile(), 'utf-8'));
    if (j && typeof j.cookie === 'string' && j.cookie) {
      const expireAt = Number(j.expireAt) || 0;
      return { cookie: j.cookie, expireAt, expired: expireAt <= Date.now() };
    }
  } catch { /* 文件不存在/损坏 → 回退网络 */ }
  return null;
}

/** 写文件缓存（失败静默：缓存丢失仅多一次 SPI 请求） */
function saveBuvidFile(cookie, expireAt) {
  try {
    fs.mkdirSync(_buvidDir, { recursive: true });
    fs.writeFileSync(buvidCacheFile(), JSON.stringify({ cookie, expireAt }), 'utf-8');
  } catch { /* 忽略 */ }
}

/** 测试钩子：清空指纹缓存（keepFile=true 仅清内存，用于验证文件命中） */
function _resetBuvidCache({ keepFile = false } = {}) {
  _anonCookie = null;
  _anonCookiePromise = null;
  _buvidExpireAt = 0;
  if (!keepFile) { try { fs.unlinkSync(buvidCacheFile()); } catch { /* 不存在即忽略 */ } }
}

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

/**
 * 匿名获取 buvid（内存 → 文件 → SPI 网络请求；无需登录）
 *
 * 文件缓存让 cron/--once 的每次运行复用同一设备指纹，避免「每次来访换设备」的机器人特征；
 * 扫码登录（login.js）也走这里，因此登录与后续轮询共用同一设备身份。
 * 网络失败但存在过期指纹时降级复用，并以 BUVID_STALE_RETRY_MS 为冷却避免反复打 SPI。
 */
async function anonCookie() {
  if (_anonCookie && _buvidExpireAt > Date.now()) return _anonCookie;
  if (_anonCookiePromise) return _anonCookiePromise;
  _anonCookiePromise = (async () => {
    // 1) 文件缓存（未过期）
    const cached = readBuvidFile();
    if (cached && !cached.expired) {
      _anonCookie = cached.cookie;
      _buvidExpireAt = cached.expireAt;
      logger.debug(`buvid 命中文件缓存（${Math.round((cached.expireAt - Date.now()) / 86400000)} 天后过期）`);
      return _anonCookie;
    }
    // 2) SPI 一次性请求：跳过前置节流（正常路径下整个 TTL 内只调一次）
    try {
      const d = await httpJson('https://api.bilibili.com/x/frontend/finger/spi', { throttle: false });
      const b3 = d?.data?.b_3;
      const b4 = d?.data?.b_4;
      if (!b3) throw new BiliError('获取 buvid 失败');
      _anonCookie = `buvid3=${b3}; buvid4=${b4 || ''}`;
      _buvidExpireAt = Date.now() + BUVID_DEFAULT_TTL_MS - BUVID_EXPIRE_MARGIN_MS;
      saveBuvidFile(_anonCookie, _buvidExpireAt);
      return _anonCookie;
    } catch (err) {
      // 3) 网络失败但存在过期指纹 → 降级复用（指纹连续优于整轮失败）
      if (cached) {
        logger.warn(`SPI 获取 buvid 失败（${err.message}），降级复用过期指纹`);
        _anonCookie = cached.cookie;
        _buvidExpireAt = Date.now() + BUVID_STALE_RETRY_MS; // 冷却内不再重试 SPI
        return _anonCookie;
      }
      throw err;
    }
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
 * 网络异常自动重试 1 次；-352 且未携带 bili_ticket 时附加风控票据重试 1 次（best-effort）
 * @param {string} url
 * @param {{cookie?: string, referer?: string, throttle?: boolean, method?: string, ticketRetried?: boolean, retried?: boolean}} [opts]
 */
async function httpJson(url, { cookie, referer, throttle = true, method = 'GET', ticketRetried = false, retried = false } = {}) {
  if (throttle) await throttleDelay(url);
  // 尽量贴近真实浏览器（www.bilibili.com 跨域调 api.bilibili.com 的请求头特征）
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
  };
  if (String(url).startsWith('https://api.bilibili.com')) headers['Origin'] = 'https://www.bilibili.com';
  if (cookie) headers['Cookie'] = cookie;
  if (referer) headers['Referer'] = referer;
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { method, headers, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    // 瞬时网络故障（超时/连接重置）重试 1 次；仍失败则抛原错误
    if (!retried) {
      logger.warn(`HTTP ${logger.sanitizeUrl(url)} 网络失败，1s 后重试: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
      return httpJson(url, { cookie, referer, throttle: false, method, ticketRetried, retried: true });
    }
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
  // -352（限流/签名校验失败）：附加 bili_ticket 风控票据重试一次；v_voucher 为验证码风控，重试无益
  const vVoucher = data.data?.v_voucher;
  if (code === -352 && !ticketRetried && !vVoucher && cookie && !/bili_ticket=/.test(cookie)) {
    const ticket = await require('./ticket').getBiliTicket(cookie).catch(() => null);
    if (ticket) {
      logger.warn(`attached bili_ticket，重试一次: ${logger.sanitizeUrl(url)}`);
      return httpJson(url, { cookie: mergeCookie(cookie, `bili_ticket=${ticket}`), referer, throttle: false, method, ticketRetried: true });
    }
  }
  if (code === -352 || code === -403 || code === -412 || code === -509 || code === -799) {
    // -403：WBI 签名缺失/错误或权限不足（2026-09-10 实测：无签名请求 wbi/main 返回 -403 访问权限不足）
    const extra = vVoucher ? '（已触发验证码风控 v_voucher，需稍后重试并降低频率）' : '';
    logger.warn(`风控/签名 code=${code}: ${data.message || ''}${extra} @ ${logger.sanitizeUrl(url)}（${ms}ms）`);
  } else if (code === -101) {
    logger.error(`Cookie 失效 (-101): ${data.message || ''} @ ${logger.sanitizeUrl(url)}`);
  } else if (code === -658) {
    logger.error(`Token 过期 (-658): ${data.message || ''} @ ${logger.sanitizeUrl(url)}`);
  }
  return data;
}

/** 风控/签名类错误码集合（-403 = WBI 签名失败或权限不足，与限流同类处置） */
const RISK_CODES = [-352, -403, -412, -509, -799];

/**
 * B站标准 API 请求（自动带 buvid，统一处理风控/错误码）
 * @param {string} urlPath
 * @param {{cookie?: string, referer?: string}} [opts]
 */
async function apiGet(urlPath, { cookie, referer } = {}) {
  const full = mergeCookie(await anonCookie(), cookie);
  const data = await httpJson('https://api.bilibili.com' + urlPath, { cookie: full, referer });
  if (RISK_CODES.includes(data.code)) {
    // -403 优先给签名类提示（WBI 失效时让用户知道刷新 Cookie/重试即可恢复）
    const hint = data.code === -403
      ? '接口签名/权限校验失败'
      : (data.data?.v_voucher ? '已触发验证码风控（v_voucher），请稍后冷却重试并降低频率' : '请求被拦截');
    throw new BiliError(`风控 code=${data.code}: ${data.message || hint}`, data.code);
  }
  if (data.code === -101) throw new BiliError('Cookie 已失效 (-101)，请更新 SESSDATA', -101);
  if (data.code === -658) throw new BiliError('Token 已过期 (-658)，请重新登录', -658);
  if (data.code !== 0) throw new BiliError(`API code=${data.code}: ${data.message || ''}`, data.code);
  return data;
}

module.exports = {
  BiliError,
  UA,
  RISK_CODES,
  anonCookie,
  mergeCookie,
  httpJson,
  apiGet,
  setThrottle,
  setRng,
  pickProfile,
  computeDelay,
  BUVID_DEFAULT_TTL_MS,
  setBuvidDir,       // 测试钩子：重定向 buvid 缓存目录
  _resetBuvidCache,  // 测试钩子：清空指纹缓存
  _throttleDelay: throttleDelay, // 测试钩子：验证开关语义（不经过 fetch）
};
