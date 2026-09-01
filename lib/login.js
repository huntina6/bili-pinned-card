'use strict';
/**
 * B站 扫码登录 —— 纯 HTTP 实现（零浏览器依赖）
 * 流程：qrcode/generate 生成二维码 → 终端半块字符渲染 → poll 轮询（手机 App 扫码）
 *       → 从回调 URL 提取认证 Cookie → spi 补设备指纹 → nav 验证登录态
 * 接口与 UX 参考：huntina6/bilibili-login（Python 版）与 bilibili-API-collect 文档
 */
const QR = require('qrcode');
const { BiliError, httpJson, mergeCookie, anonCookie } = require('./api/client');

const PASS_HOST = 'https://passport.bilibili.com';
const POLL_INTERVAL = 2500;        // 轮询间隔（ms）
const DEFAULT_TIMEOUT = 360000;    // 默认扫码等待 6 分钟
const MAX_RETRY = 3;               // 网络失败重试次数
const QR_BORDER = 2;               // 二维码白边（模块数）

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 轮询响应状态 → 行为分类
 * 注意：2026 新版 poll 响应中真实状态在内层 data.code（外层 code 恒为 0），
 * 且语义与旧版相反：86101=未扫码、86090=已扫码待确认、86038=已失效
 * （对齐 huntina6/bilibili-login 实测行为）
 */
function classifyPoll(code) {
  switch (code) {
    case 0: return 'success';          // 已确认登录（url 含 Cookie）
    case 86101: return 'waiting';      // 未扫码
    case 86090: return 'scanned';      // 已扫码，待 App 确认
    case 86038: return 'expired';      // 二维码已失效
    case -352:
    case -412: return 'risk';          // 风控，重试即可
    default: return 'waiting';         // 未知状态码继续等待（容错，不中断登录）
  }
}

/** 从登录回调 URL 提取认证 Cookie（URLSearchParams 自动解码 %XX） */
function extractCookiesFromUrl(url) {
  const q = String(url || '').split('?')[1] || '';
  const params = new URLSearchParams(q);
  const ck = {};
  for (const k of ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'bili_ticket', 'bili_ticket_expires']) {
    const v = params.get(k);
    if (v) ck[k] = v;
  }
  return ck;
}

/** 生成登录二维码 */
async function generateQr() {
  let lastErr = null;
  for (let i = 0; i < MAX_RETRY; i++) {
    try {
      const d = await httpJson(`${PASS_HOST}/x/passport-login/web/qrcode/generate`, {
        referer: 'https://www.bilibili.com/',
      });
      if (d.code !== 0 || !d.data?.qrcode_key) {
        throw new BiliError(`二维码生成失败 code=${d.code}: ${d.message || ''}`, d.code);
      }
      return { qrcode_key: d.data.qrcode_key, url: d.data.url };
    } catch (e) {
      lastErr = e;
      if (i < MAX_RETRY - 1) await sleep(1000 * (i + 1)); // 退避
    }
  }
  throw lastErr;
}

/**
 * 二维码 → 终端 Unicode 半块字符渲染（每 2 行矩阵合并 1 行：█ 全黑 / ▀ 上黑 / ▄ 下黑 / 空格 全白）
 * 浅色终端直接显示；深色终端可传 invert 反转（ANSI 反显）。
 * @returns {boolean} 渲染成功与否（宽度超出终端列数时 false）
 */
function renderQrTerminal(url, out = console, { invert = false } = {}) {
  const qr = QR.create(String(url), { errorCorrectionLevel: 'M', margin: QR_BORDER });
  const n = qr.modules.size;
  const cols = out.columns || 80;
  if (n > cols - 2) return false;
  const rev = s => (invert ? `\x1b[7m${s}\x1b[0m` : s);
  for (let i = 0; i < n; i += 2) {
    let line = '';
    for (let c = 0; c < n; c++) {
      const t = qr.modules.get(i, c);
      const b = i + 1 < n && qr.modules.get(i + 1, c);
      line += t && b ? rev('█') : t ? rev('▀') : b ? rev('▄') : ' ';
    }
    out.log(line);
  }
  return true;
}

/**
 * 轮询扫码状态直到登录成功
 * @returns {Promise<{cookies: object}>} cookies 为认证 Cookie 键值对
 */
async function pollLogin(qrcodeKey, { timeoutMs = DEFAULT_TIMEOUT, onStatus } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const d = await httpJson(
        `${PASS_HOST}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}&source=main-fe-header`,
        { referer: 'https://www.bilibili.com/' }
      );
      // 2026 新版：真实状态在内层 data.code（外层 code 恒为 0）
      const inner = d.data && typeof d.data.code === 'number' ? d.data.code : d.code;
      switch (classifyPoll(inner)) {
        case 'success': {
          const ck = extractCookiesFromUrl(d.data?.url || '');
          if (!ck.SESSDATA) throw new BiliError('扫码成功但未能提取 SESSDATA（回调 URL 异常）');
          return { cookies: ck };
        }
        case 'waiting':
        case 'scanned':
          onStatus?.(inner, d.data?.message || d.message || '');
          break;
        case 'expired':
          throw new BiliError('二维码已失效，请重新运行 --login');
        case 'risk':
          lastErr = new BiliError(`风控 code=${inner}`, inner);
          break;
      }
    } catch (e) {
      // 网络/风控类错误继续轮询；明确的业务错误（失效/成功异常）直接抛
      if (e instanceof BiliError && ![undefined, -352, -412].includes(e.code)) throw e;
      lastErr = e;
    }
    await sleep(POLL_INTERVAL);
  }
  throw lastErr || new BiliError(`扫码等待超时（${Math.round(timeoutMs / 60000)} 分钟），请重新运行 --login`);
}

/** nav 接口验证登录态 */
async function verifyLogin(cookieStr) {
  const d = await httpJson('https://api.bilibili.com/x/web-interface/nav', {
    cookie: cookieStr,
    referer: 'https://www.bilibili.com/',
  });
  if (d.code !== 0 || !d.data?.isLogin) throw new BiliError('登录验证失败（Cookie 无效或已过期）', d.code);
  return { uname: d.data.uname || '', mid: String(d.data.mid ?? '') };
}

/**
 * 完整登录流程：生成二维码 → 终端渲染 → 轮询扫码 → 组 Cookie → 验证
 * @returns {Promise<{cookieStr: string, uname: string, mid: string}>}
 */
async function loginFlow({ timeoutMs, onStatus, log } = {}) {
  const { qrcode_key, url } = await generateQr();
  log?.('二维码已生成，请用 B站 App「扫一扫」扫码登录（二维码约 3 分钟失效，超时自动重新生成）');
  log?.('');
  const ok = renderQrTerminal(url);
  log?.('');
  if (!ok) log?.('⚠ 二维码宽度超出终端列数，请全屏终端或使用支持更宽显示的终端');
  log?.('[URL] ' + url);
  log?.('');
  const { cookies } = await pollLogin(qrcode_key, { timeoutMs, onStatus });
  const device = await anonCookie().catch(() => ''); // buvid3/buvid4 设备指纹
  const parts = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const cookieStr = mergeCookie(device, parts);
  const info = await verifyLogin(cookieStr);
  return { cookieStr, ...info };
}

module.exports = {
  classifyPoll,
  extractCookiesFromUrl,
  generateQr,
  renderQrTerminal,
  pollLogin,
  verifyLogin,
  loginFlow,
  PASS_HOST,
  POLL_INTERVAL,
  DEFAULT_TIMEOUT,
};
