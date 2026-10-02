#!/usr/bin/env node
'use strict';
/**
 * bili-pinned-card v1.6.0 —— B站置顶评论监测 + 自动出图
 * 全平台独立版：无需浏览器、无需登录（匿名可读评论；提供 SESSDATA 可自动识别置顶动态）
 *
 * 用法（中文名 / 英文名 / 旧参数名三种写法完全等价，完整说明见 node cli.js --帮助）：
 *   node cli.js                                     # 配置向导（第一次用推荐）
 *   node cli.js 登录                                 # 扫码登录并保存 Cookie
 *   node cli.js 查看 <动态链接>                       # 看这条动态的置顶评论并出图
 *   node cli.js 监控 <动态链接|UP空间链接> 60         # 每 60 秒检查一次
 *   node cli.js 热评 <动态链接> 10                    # UP 热评 TOP 卡（高赞区 10 条）
 *   node cli.js 出图 <评论链接>                       # 指定评论出图
 *   node cli.js 回顾 <评论链接>                       # 该评论的 UP 互动回顾图
 *   node cli.js --帮助
 *
 * 模块结构：lib/args（参数解析）/ lib/interactive（交互引导）/ lib/watcher（监控循环）
 *          lib/ui（终端样式）/ lib/state（配置持久化）/ lib/monitor（核心检查）/ lib/api（B站 API）/ lib/card（卡片渲染）
 */

// 启动加速：Node >= 22.8 的编译缓存（旧版本静默跳过；仅直接运行 cli.js 时启用，避免被 require 时产生副作用）
if (require.main === module) {
  try { require('node:module').enableCompileCache?.(); } catch { /* 忽略 */ }
}

// 机器可读模式（--json）必须在加载 UI、解析参数之前确定：终端颜色在 ui 模块加载期计算，
// 且要尽早在加载期把 stdout 让给 NDJSON（console.log 改道 stderr）。
const JSON_MODE = require.main === module
  && process.argv.slice(2).some(a => ['--json', '-j', '--机器可读'].includes(a));
const jsonout = require('./lib/jsonout');
if (JSON_MODE) jsonout.enable();

const { C, makeBanner, log } = require('./lib/ui');
const emoji = require('./lib/card/emoji');
const logger = require('./lib/logger');
const { parseArgs, buildConfig, isNumericUid, HELP, SHORT_HELP } = require('./lib/args');
const { qrLogin, runInteractive } = require('./lib/interactive');
const { runWatcher } = require('./lib/watcher');
const { resolveCommentOid, extractId } = require('./lib/api');
const { extractUid } = require('./lib/args');
const { loadConfig } = require('./lib/state');

const { version: VERSION } = require('./package.json');
const BANNER = makeBanner(VERSION);

// ====== 主流程 ======
/** 参数/用法类错误：终端提示（stderr）+ （--json 时）机器可读错误行 + 退出码 */
function fail(message, hint) {
  console.error(C.red(message));
  if (hint) console.error(C.dim('  ' + hint));
  jsonout.emit({ type: 'error', ok: false, error: { kind: 'usage', code: null, message }, hint: hint || '' });
  process.exitCode = 1;
}

/** 目标写 - 时从标准输入读（管道 / AI 调用友好；只读一次并缓存） */
let _stdinTarget;
function stdinTarget() {
  if (_stdinTarget === undefined) {
    try { _stdinTarget = require('fs').readFileSync(0, 'utf8').trim(); } catch { _stdinTarget = ''; }
  }
  return _stdinTarget;
}

/** 能力清单（AI 自描述）：始终输出 JSON，便于机器读取 */
function printCaps() {
  const { buildCaps } = require('./lib/caps');
  process.stdout.write(JSON.stringify(buildCaps(), null, 2) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.json) jsonout.enable(); // 兜底：以 require 方式调用时 prescan 不生效
  if (args.caps) { printCaps(); return; }
  if (args.help) { console.log(HELP); return; }
  if (args.version) { console.log(VERSION); return; }
  // 动作词缺目标（如 node cli.js 查看）：给简洁帮助 + 失败退出，不去猜默认账号
  if (args.shortHelp) {
    console.log(SHORT_HELP);
    jsonout.emit({
      type: 'error', ok: false, error: { kind: 'usage', code: null, message: '缺少目标（动态/评论链接或 UP）' },
      hint: '补上目标：node cli.js 查看 <动态链接>；完整说明 node cli.js --帮助',
    });
    process.exitCode = 1;
    return;
  }
  if (args.noEmoji) emoji.setEnabled(false); // 全局关闭 emoji 彩色化（回退文本）
  if (args.verbose) logger.setLevel('debug'); // -v：请求摘要等 debug 级信息写入日志文件
  logger.info(`===== 启动 v${VERSION} | ${process.argv.slice(2).join(' ') || '(交互模式)'} =====`);

  // ---- 扫码登录：独立执行，成功后保存 Cookie 并退出 ----
  if (args.login) {
    const t0 = Date.now();
    try {
      log(C.dim('正在生成登录二维码...'));
      const info = await qrLogin(log);
      jsonout.emit({
        type: 'result', event: 'login', ok: true,
        uname: info && info.uname, mid: info && info.mid != null ? String(info.mid) : null,
        durationMs: Date.now() - t0,
      });
      jsonout.emit({ type: 'end', ok: true, exitCode: 0, cards: 0, durationMs: Date.now() - t0 });
    } catch (err) {
      console.error(C.red(`✗ 登录失败: ${err.message}`));
      logger.error(`登录失败: ${err.message}`);
      jsonout.emit({ type: 'error', ok: false, ...jsonout.describeError(err) });
      process.exitCode = 1;
    }
    return;
  }

  const saved = loadConfig();
  // 目标可以写 - ：从标准输入读一行（echo "<链接>" | node cli.js 查看 -）
  if (args.oid === '-') args.oid = stdinTarget();
  if (args.rpid === '-') args.rpid = stdinTarget();
  if (args.uid === '-') args.uid = extractUid(stdinTarget());
  const cfg = buildConfig(args, saved);
  // 向导保存的 emoji 开关（--no-emoji 已在 buildConfig 内优先处理）
  if (!cfg.emoji) emoji.setEnabled(false);
  // 裸参数 oid / rpid 可能是链接 → 提取数字 ID；opus 链接自动转换评论 oid
  if (cfg.oid) {
    const r = await resolveCommentOid(cfg.oid, cfg.cookie);
    cfg.oid = r.oid;
    if (r.type != null) cfg.type = r.type;
  }
  if (cfg.rpid) cfg.rpid = extractId(cfg.rpid);
  if (!Number.isFinite(cfg.interval) || cfg.interval < 10) cfg.interval = 60;
  if (!Number.isFinite(cfg.type)) cfg.type = 11;
  if (!Number.isFinite(cfg.scale) || cfg.scale < 0.5 || cfg.scale > 6) cfg.scale = 2;
  // uid 必须是纯数字（拼入 API URL，脏值产生无效请求且无提示）
  if (args.uid && !isNumericUid(args.uid)) {
    logger.error(`参数错误: --UP 非数字 (${args.uid})`);
    fail(`--UP 需要数字 UID（或直接粘贴 UP 空间链接），收到: ${args.uid}`,
      '空间链接形如 https://space.bilibili.com/401315430；UP 空间页地址里 mid= 后面那串就是 UID');
    return;
  }
  if (saved.uid && !isNumericUid(saved.uid)) {
    logger.error(`配置错误: 已保存 UID 非法 (${saved.uid})`);
    fail(`配置中的 UP UID 非法（${saved.uid}）`, '删除 ~/.bili-pinned-card/config.json 后重试');
    return;
  }

  // ---- 机器可读：运行开始事件（目标已解析完毕）----
  jsonout.emit({
    type: 'start', version: VERSION,
    action: args._action || (cfg.upTop ? 'hot' : cfg.rpid ? 'card' : 'view'),
    // uid 只有在用户显式指定/已保存时才报告：DEFAULT_UID 兜底值是内部默认账号，不代表调用意图
    target: { oid: cfg.oid || null, uid: (cfg.uidExplicit || !cfg.uidDefaulted) ? (cfg.uid || null) : null, rpid: cfg.rpid || null },
    mode: cfg.once ? 'once' : 'watch', outDir: cfg.outDir, dryRun: !!cfg.dryRun,
  });

  // JSON 模式下不打印横幅（人类日志已全部改道 stderr，横幅只会添乱）
  const banner = jsonout.enabled() ? '' : BANNER;

  // ---- 统一会话：向导 → 运行 → 「再运行一次」都在同一 readline 会话内（跨轮零状态残留） ----
  const inter = await runInteractive(cfg, {
    args,
    banner,
    saved,
    run: c => runWatcher(c, { bannerShown: true, banner }),
  });
  if (inter.exit) return;
  // 非交互（--no-input / 非 TTY / CI / 未触发向导）：按参数或已保存配置直接运行
  if (!inter.ran) await runWatcher(cfg, { bannerShown: false, banner });
}

if (require.main === module) {
  main().catch(err => {
    console.error(C.red('致命错误: ' + (err?.message || err)));
    logger.error('致命错误: ' + (err?.message || err));
    jsonout.emit({ type: 'error', ok: false, ...jsonout.describeError(err) });
    jsonout.emit({ type: 'end', ok: false, exitCode: 1, cards: 0, durationMs: 0 });
    process.exit(1);
  });
}

module.exports = { parseArgs, buildConfig };
