'use strict';
/**
 * 机器可读输出（--json / --机器可读）：给 AI 与脚本用的稳定接口
 * 契约：stdout 只输出 NDJSON（每行一个 JSON 对象，type 字段区分），人类日志全部改道 stderr + 日志文件。
 * 这样调用方可以直接按行 JSON.parse，不会被横幅、进度、颜色污染。
 *
 * 事件类型（jsonContract: 1）
 *   {"type":"start",  "version","action","target":{...},"mode","outDir","dryRun"}
 *   {"type":"card",   "kind":"pinned|unpinned|up-top|dynamic","file","rpid","oid", "index","total"}
 *   {"type":"result", "event","ok","oid","file","cards","skipped","comment":{...},"plan":{...},"durationMs"}
 *   {"type":"error",  "ok":false,"error":{"kind","code","message"},"hint"}
 *   {"type":"end",    "ok","exitCode","cards","durationMs"}
 * 零依赖；默认关闭，只有显式 --json 才启用（不改变既有行为）。
 */

let _on = false;
let _wrote = false;

/**
 * 启用机器可读模式
 * - 禁用终端颜色（AI 解析不需要 ANSI）
 * - 把 console.log 改道到 stderr：既有的人类可读输出保持不变，但不再污染 stdout
 */
function enable() {
  if (_on) return;
  _on = true;
  process.env.NO_COLOR = '1';
  console.log = (...a) => console.error(...a);
}

/** 是否处于机器可读模式 */
function enabled() { return _on; }

/** 输出一行 JSON（未启用时零开销） */
function emit(obj) {
  if (!_on) return;
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
    _wrote = true;
  } catch { /* stdout 关闭等：忽略，绝不因输出失败影响主流程 */ }
}

/** 是否已经输出过内容（供端到端自检） */
function wrote() { return _wrote; }

/** 评论对象 → 精简结构（避免把 emote/pictures 全量塞进 JSON 流） */
function pickComment(c) {
  if (!c) return null;
  return {
    rpid: String(c.rpid),
    author: c.author || '',
    mid: c.mid == null ? null : String(c.mid),
    ctime: c.ctime || 0,
    message: String(c.message || '').slice(0, 500),
    like: c.like ?? 0,
    rcount: c.rcount ?? 0,
    pictures: (c.pictures || []).length,
  };
}

/** 错误 → 分类 + 修复建议（AI 可据此决定下一步动作） */
function describeError(err) {
  const code = err && err.code;
  const message = String((err && err.message) || err || '未知错误');
  const kind = code === -101 ? 'auth'
    : code === -658 ? 'expired'
      : ([-352, -403, -412, -509, -799].includes(code) ? 'risk' : (code == null ? 'other' : 'api'));
  const hint = kind === 'auth' || kind === 'expired'
    ? '运行 node cli.js 登录 重新扫码获取 Cookie（约 30 天有效）'
    : kind === 'risk'
      ? '被风控/限流：等几分钟再试，或降低频率；匿名场景建议先 登录'
      : '检查目标链接是否有效、网络是否可用；加 -v 后看日志文件排障';
  return { error: { kind, code: code == null ? null : code, message }, hint };
}

module.exports = { enable, enabled, emit, wrote, pickComment, describeError };
