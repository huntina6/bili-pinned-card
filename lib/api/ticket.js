'use strict';
/**
 * bili_ticket —— B站 Web 端风控票据
 * 携带于 Cookie 中可降低 -352 限流概率（公开资料：bilibili-API-collect docs/misc/sign/bili_ticket.md）
 * 签名：hmac_sha256("XgwSnGZ1p", "ts"+timestamp) → POST GenWebTicket（必须 POST）
 * 缓存：内存 + 文件（默认 ~/.bili-pinned-card/ticket.json，TTL 以响应 data.ttl 为准，约 3 天）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { BiliError, httpJson } = require('./client');

const HC_KEY = 'XgwSnGZ1p';
const TICKET_URL = 'https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket';
const DEFAULT_TTL = 259200; // 响应未给 ttl 时的兜底：3 天（秒）
const EXPIRE_MARGIN = 300;  // 提前 5 分钟过期，避免边界失效

let _cache = null; // { value, expireAt }
let _inflight = null;
let _dir = process.env.BILI_TICKET_DIR || path.join(os.homedir(), '.bili-pinned-card');

/** 测试钩子：重定向缓存目录（隔离真实 ~/.bili-pinned-card） */
function setDir(dir) {
  _dir = dir;
  _cache = null;
  _inflight = null;
}
function cacheFile() { return path.join(_dir, 'ticket.json'); }

/** 生成 GenWebTicket 的 hexsign（纯函数，便于测试固定向量） */
function buildTicketSign(ts) {
  return crypto.createHmac('sha256', HC_KEY).update(`ts${ts}`).digest('hex');
}

/** 读文件缓存；命中回填内存（取内存与文件过期时间的较小者） */
function loadFromFile() {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(), 'utf-8'));
    if (j && j.ticket && j.expireAt > Date.now()) {
      _cache = { value: j.ticket, expireAt: Math.min(j.expireAt, Date.now() + DEFAULT_TTL * 1000) };
      return _cache.value;
    }
  } catch { /* 文件不存在/损坏 → 回退网络 */ }
  return null;
}

/** 写文件缓存（失败静默：缓存丢失仅多一次票据请求） */
function saveToFile(ticket, expireAt) {
  try {
    fs.mkdirSync(_dir, { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify({ ticket, expireAt }), 'utf-8');
  } catch { /* 忽略 */ }
}

/**
 * 获取 bili_ticket（内存 → 文件 → GenWebTicket 网络请求）
 * @param {string} cookie 需含 buvid3（匿名亦可）
 * @returns {Promise<string>} ticket 字符串
 */
async function getBiliTicket(cookie) {
  if (_cache && _cache.expireAt > Date.now()) return _cache.value;
  const fromFile = loadFromFile();
  if (fromFile) return fromFile;
  if (_inflight) return _inflight; // in-flight 去重：并发只发一次
  _inflight = (async () => {
    const ts = Math.floor(Date.now() / 1000);
    const qs = new URLSearchParams({
      key_id: 'ec02',
      hexsign: buildTicketSign(ts),
      'context[ts]': String(ts),
      csrf: '',
    }).toString();
    const d = await httpJson(`${TICKET_URL}?${qs}`, {
      cookie,
      referer: 'https://www.bilibili.com/',
      throttle: false,
      method: 'POST',
      ticketRetried: true, // 票据请求自身不再触发票据重试，避免递归
    });
    const ticket = d?.data?.ticket;
    if (d?.code !== 0 || !ticket) {
      throw new BiliError(`获取 bili_ticket 失败（code=${d?.code ?? '?'}: ${d?.message || '无 ticket'}）`, d?.code);
    }
    const ttl = Number(d.data?.ttl) > 0 ? Number(d.data.ttl) : DEFAULT_TTL;
    const expireAt = Date.now() + Math.max(60, ttl - EXPIRE_MARGIN) * 1000;
    _cache = { value: ticket, expireAt };
    saveToFile(ticket, expireAt);
    return ticket;
  })().finally(() => { _inflight = null; });
  return _inflight;
}

/** 测试钩子：清空票据缓存（keepFile=true 仅清内存，用于验证文件命中） */
function _resetTicketCache({ keepFile = false } = {}) {
  _cache = null;
  _inflight = null;
  if (!keepFile) { try { fs.unlinkSync(cacheFile()); } catch { /* 不存在即忽略 */ } }
}

module.exports = {
  HC_KEY,
  DEFAULT_TTL,
  buildTicketSign,
  getBiliTicket,
  setDir,
  _resetTicketCache,
};
