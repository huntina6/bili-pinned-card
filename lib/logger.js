'use strict';
/**
 * 文件日志 —— 按天滚动写 ~/.bili-pinned-card/logs/YYYY-MM-DD.log
 * 设计约束：
 *  - 零依赖、同步追加（低频写入，简单可靠不丢行）
 *  - 终端输出照旧（颜色在文件层剥离），本模块只管落盘 + 终端旁路由调用方负责
 *  - 敏感信息消毒：URL 记录只保留 host+path+选择性 query；Cookie/ticket 绝不入日志
 *  - 自动清理 30 天前的日志；写盘失败静默（日志不能影响主流程）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = process.env.BILI_LOG_DIR || path.join(os.homedir(), '.bili-pinned-card', 'logs');
const KEEP_DAYS = 30;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_NAMES = ['debug', 'info', 'warn', 'error'];

let _dir = LOG_DIR;
let _level = LEVELS[String(process.env.BILI_LOG_LEVEL || '').toLowerCase()] ?? LEVELS.info; // 文件通道默认 info（debug 需 --verbose / BILI_LOG_LEVEL=debug）
let _file = null;              // 当日文件路径
let _lastClean = '';           // 上次清理日期（每天一次）

// ====== 内部工具 ======
/** 剥离 ANSI 颜色码（终端字符串入文件前必须剥离） */
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/** 敏感值打码：超长值/疑似凭据值截断 */
function mask(v) {
  const s = String(v);
  if (s.length > 32) return s.slice(0, 12) + '…(' + s.length + '字符)';
  return s;
}

const SENSITIVE_KEYS = /^(sessdata|bili_jct|dedeuserid|dedeuserid__ckmd5|ticket|url|gourl|cookie|token|access_key|qrcode_key|key|w_rid)$/i;

/**
 * URL 消毒：仅保留 scheme+host+pathname 与安全的 query 键值，用于请求摘要日志
 * （query 里可能带评论 ID/分页游标等排障信息，但绝不能带凭据类参数）
 */
function sanitizeUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    const safe = [];
    for (const [k, v] of u.searchParams) {
      if (SENSITIVE_KEYS.test(k)) { safe.push(`${k}=***`); continue; }
      safe.push(`${k}=${mask(v)}`);
    }
    return u.protocol + '//' + u.host + u.pathname + (safe.length ? '?' + safe.join('&') : '');
  } catch {
    return mask(rawUrl); // 非法 URL：整体打码
  }
}

// ====== 文件写入 ======
function todayFile() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return path.join(_dir, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
}

function cleanOld() {
  const today = todayFile().split(path.sep).pop();
  if (_lastClean === today) return;
  _lastClean = today;
  try {
    const files = fs.readdirSync(_dir);
    const cutoff = Date.now() - KEEP_DAYS * 86400e3;
    for (const f of files) {
      if (!f.endsWith('.log')) continue;
      const p = path.join(_dir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch { /* 单个文件失败忽略 */ }
    }
  } catch { /* 目录不存在等：忽略 */ }
}

function writeLine(levelName, msg) {
  try {
    if (_level > LEVELS[levelName]) return;
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    if (!_file || _file !== todayFile()) {
      _file = todayFile();
      fs.mkdirSync(_dir, { recursive: true });
      cleanOld();
    }
    fs.appendFileSync(_file, `[${ts}] [${levelName.toUpperCase().padEnd(5)}] ${stripAnsi(msg)}\n`, 'utf-8');
  } catch { /* 写盘失败绝不影响主流程 */ }
}

// ====== 对外 API ======
function debug(msg) { writeLine('debug', msg); }
function info(msg) { writeLine('info', msg); }
function warn(msg) { writeLine('warn', msg); }
function error(msg) { writeLine('error', msg); }

/** 设置文件日志级别：'debug' | 'info' | 'warn' | 'error' */
function setLevel(name) {
  const lv = LEVELS[String(name || '').toLowerCase()];
  if (lv !== undefined) _level = lv;
}

/** 读取当前文件日志级别名 */
function getLevel() {
  return LEVEL_NAMES.find(n => LEVELS[n] === _level) || 'info';
}

/** 当日日志文件路径（未写入过则为 null） */
function currentFile() { return _file; }

/** 日志目录（便于 CLI 提示用户位置） */
function logDir() { return _dir; }

/** 测试钩子：重定向目录并重置内部状态 */
function setDir(dir) {
  _dir = dir;
  _file = null;
  _lastClean = '';
}

/** 默认目录（即真实用户目录，setDir 前有效） */
function defaultDir() { return LOG_DIR; }

module.exports = {
  LEVELS, LEVEL_NAMES,
  stripAnsi, sanitizeUrl, mask,
  debug, info, warn, error,
  setLevel, getLevel, currentFile, logDir, setDir, defaultDir,
};
