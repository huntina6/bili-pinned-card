'use strict';
/**
 * 通知推送抽象（借鉴 goban 的多渠道封装）
 * - 事件：new / unpinned / dyn-update / up-top / error
 *   订阅语义：未配置（缺省）= 全部订阅；显式空列表 = 不订阅任何事件
 * - 渠道：通用 Webhook（原样 JSON）+ 飞书 / 钉钉 / Telegram 消息体模板
 * - 默认关闭：仅在显式配置 notifyWebhook（--notify-webhook）后启用，缺省行为与旧版一致
 * - best-effort：超时/网络/HTTP 异常只写日志，绝不中断监测主流程
 * - 诚实回执：HTTP 2xx 后仍校验响应体业务码（飞书/钉钉失败时返回 200 + 错误码），
 *   避免把「关键词不匹配 / 签名错误」静默记成推送成功
 * 零额外依赖（Node ≥18 内置 fetch）。
 */
const logger = require('./logger');

/** 可订阅的事件（默认全订阅） */
const NOTIFY_EVENTS = ['new', 'unpinned', 'dyn-update', 'up-top', 'error'];
/** 支持的 Webhook 消息体模板 */
const FORMATS = ['generic', 'feishu', 'dingtalk', 'telegram'];
const TIMEOUT_MS = 8000;

/**
 * monitor 事件 → 可订阅通知事件（无需通知的事件返回 null）
 * @param {{event?: string}} res
 * @returns {'new'|'unpinned'|'dyn-update'|'up-top'|'error'|null}
 */
function toNotifyEvent(res) {
  switch (res && res.event) {
    case 'new': case 'manual': case 'context': return 'new';
    case 'unpinned': return 'unpinned';
    case 'dyn-update': return 'dyn-update';
    case 'up-top': return 'up-top';
    case 'error': case 'fetch-error': return 'error';
    default: return null;
  }
}

/**
 * 事件 → 通知标题与正文（纯函数）
 * @param {string} event
 * @param {any} [res] monitor 事件对象
 * @param {string} [prefix] 标题前缀（如 UP 名）
 * @returns {{event: string, title: string, text: string, file: string|null}}
 */
function buildMessage(event, res = {}, prefix = '') {
  const c = res.comment || {};
  const lines = [];
  let title = 'B站置顶评论监测';
  switch (event) {
    case 'new':
      title = '置顶评论变化';
      if (c.author) lines.push(`评论者: ${c.author}`);
      if (c.message) lines.push(`内容: ${String(c.message).slice(0, 200)}`);
      break;
    case 'unpinned':
      title = '置顶评论已取消';
      break;
    case 'dyn-update':
      title = '普通动态更新';
      if (res.latestDesc) lines.push(`内容: ${String(res.latestDesc).slice(0, 200)}`);
      break;
    case 'up-top':
      title = 'UP 热评卡出图完成';
      lines.push(`本次生成 ${res.cards ?? 0} 张${res.skipped ? `，跳过已存在 ${res.skipped} 张` : ''}`);
      break;
    case 'error':
      title = '监测异常';
      lines.push(String(res.message || res.reason || '未知错误'));
      break;
    default:
      break;
  }
  if (res.oid) lines.push(`动态: https://t.bilibili.com/${res.oid}`);
  if (res.file) lines.push(`图片: ${res.file}`);
  lines.push(`时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  return { event, title: `${prefix}${title}`, text: lines.join('\n'), file: res.file || null };
}

/**
 * 按渠道模板构造 Webhook 请求体（纯函数）
 * @param {string} format
 * @param {{event: string, title: string, text: string, file: string|null}} msg
 * @param {{notifyChatId?: string}} [cfg]
 */
function buildPayload(format, msg, cfg = {}) {
  const merged = `${msg.title}\n${msg.text}`;
  switch (format) {
    case 'feishu': return { msg_type: 'text', content: { text: merged } };
    case 'dingtalk': return { msgtype: 'text', text: { content: merged } };
    case 'telegram': return { chat_id: cfg.notifyChatId || '', text: merged, disable_web_page_preview: true };
    default:
      return { event: msg.event, title: msg.title, text: msg.text, file: msg.file, time: new Date().toISOString() };
  }
}

/**
 * 事件是否被订阅
 * 语义：notifyEvents 未指定（null/undefined/非数组）= 全订阅（缺省行为不变）；
 *       显式空数组 = 不订阅任何事件——向导里把事件全部取消勾选即该语义，
 *       此前被当成「全选」，与界面显示相反（用户以为不推送，实际全推）。
 * @param {any} cfg
 * @param {string} event
 * @returns {boolean}
 */
function isSubscribed(cfg, event) {
  const raw = cfg && cfg.notifyEvents;
  const list = Array.isArray(raw) ? raw : NOTIFY_EVENTS;
  return list.includes(event);
}

/** 解析渠道模板（非法值回退 generic） */
function resolveFormat(cfg) {
  return FORMATS.includes(cfg && cfg.notifyFormat) ? cfg.notifyFormat : 'generic';
}

/**
 * 渠道业务级结果校验（纯函数）
 *
 * 飞书与钉钉在**业务失败时仍返回 HTTP 200**，错误只体现在响应体：
 *   飞书  {"code":19024,"msg":"Key Words Not Found"}
 *   钉钉  {"errcode":310000,"errmsg":"keywords not in content"}
 *   Telegram 失败时返回非 2xx，但也可能带 {"ok":false,...}
 * 只检查 HTTP 状态会把「关键词不匹配 / 签名错误 / 被限流」记成推送成功——
 * 这是同类项目（seek 等）记录过的静默失败。
 *
 * 保守策略：响应体非 JSON、缺字段或类型不符时一律视为成功，避免误报噪音。
 *
 * @param {string} format 渠道模板
 * @param {string} rawText 响应体原文
 * @returns {{ok: boolean, detail: string}} detail 为失败原因摘要（成功时为空串）
 */
function checkChannelBody(format, rawText) {
  if (format !== 'feishu' && format !== 'dingtalk' && format !== 'telegram') {
    return { ok: true, detail: '' }; // generic：任意 webhook，无法判定业务码
  }
  const text = String(rawText == null ? '' : rawText).trim();
  if (!text) return { ok: true, detail: '' };
  let body;
  try { body = JSON.parse(text); } catch { return { ok: true, detail: '' }; } // 非 JSON 不判定
  if (!body || typeof body !== 'object') return { ok: true, detail: '' };

  if (format === 'feishu') {
    // 新版 {"code":0,"msg":"success"}；老版 {"StatusCode":0,"StatusMessage":"success"}
    const code = body.code ?? body.StatusCode;
    if (typeof code === 'number' && code !== 0) {
      const msg = body.msg || body.StatusMessage || '';
      return { ok: false, detail: `code=${code}${msg ? ` ${msg}` : ''}` };
    }
    return { ok: true, detail: '' };
  }
  if (format === 'dingtalk') {
    const code = body.errcode;
    if (typeof code === 'number' && code !== 0) {
      const msg = body.errmsg || '';
      return { ok: false, detail: `errcode=${code}${msg ? ` ${msg}` : ''}` };
    }
    return { ok: true, detail: '' };
  }
  // telegram: {"ok":true,"result":{…}} / {"ok":false,"description":"…"}
  if (body.ok === false) {
    const code = body.error_code == null ? '' : String(body.error_code);
    const desc = body.description || '';
    return { ok: false, detail: [code, desc].filter(Boolean).join(' ') };
  }
  return { ok: true, detail: '' };
}

/**
 * POST 到 Webhook（best-effort，返回结果但不抛错）
 * HTTP 2xx 后仍按渠道校验响应体，避免把业务级失败记成成功。
 * @returns {Promise<{ok: boolean, skipped?: boolean, status?: number, error?: string}>}
 */
async function sendNotify(cfg, msg) {
  const url = cfg && cfg.notifyWebhook;
  if (!url) return { ok: false, skipped: true };
  const format = resolveFormat(cfg);
  const body = JSON.stringify(buildPayload(format, msg, cfg));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ac.signal,
    });
    const text = await resp.text().catch(() => '');
    if (!resp.ok) {
      logger.warn(`通知推送失败 HTTP ${resp.status}: ${String(text).slice(0, 200)}`);
      return { ok: false, status: resp.status };
    }
    const verdict = checkChannelBody(format, text);
    if (!verdict.ok) {
      logger.warn(`通知推送被拒绝（HTTP ${resp.status} 但 ${format} 返回业务错误）: ${verdict.detail}`);
      return { ok: false, status: resp.status, error: verdict.detail };
    }
    return { ok: true, status: resp.status };
  } catch (err) {
    logger.warn(`通知推送异常: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 通知分发入口：未配置 / 事件不可映射 / 未订阅 → 空操作
 * @param {any} cfg 运行配置（需含 notifyWebhook / notifyFormat / notifyEvents）
 * @param {any} res monitor 事件对象
 * @param {any} [extra] 附加到消息里的字段（如 latestDesc）
 */
async function notifyResult(cfg, res, extra = {}) {
  if (!cfg || !cfg.notifyWebhook) return { ok: false, skipped: true };
  const event = toNotifyEvent(res);
  if (!event || !isSubscribed(cfg, event)) return { ok: false, skipped: true };
  const msg = buildMessage(event, { ...res, ...extra }, cfg.notifyPrefix || '');
  logger.info(`通知推送: ${event} → ${msg.title}`);
  return sendNotify(cfg, msg);
}

module.exports = {
  NOTIFY_EVENTS, FORMATS, TIMEOUT_MS,
  toNotifyEvent, buildMessage, buildPayload, isSubscribed, resolveFormat,
  checkChannelBody, sendNotify, notifyResult,
};
