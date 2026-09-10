#!/usr/bin/env node
'use strict';
/**
 * bili-pinned-card v1.3.0 —— B站置顶评论监测 + 自动出图
 * 全平台独立版：无需浏览器、无需登录（匿名可读评论；提供 SESSDATA 可自动识别置顶动态）
 *
 * 用法：
 *   node cli.js                       # 交互模式（终端提示引导）
 *   node cli.js --oid 404135596       # 直接指定动态 ID，单次检查出图
 *   node cli.js --uid 401315430 --watch --interval 60
 *   node cli.js --help
 *
 * 模块结构：lib/args（参数解析）/ lib/interactive（交互引导）/ lib/watcher（监控循环）
 *          lib/ui（终端样式）/ lib/state（配置持久化）/ lib/monitor（核心检查）/ lib/api（B站 API）/ lib/card（卡片渲染）
 */

// 启动加速：Node >= 22.8 的编译缓存（旧版本静默跳过；仅直接运行 cli.js 时启用，避免被 require 时产生副作用）
if (require.main === module) {
  try { require('node:module').enableCompileCache?.(); } catch { /* 忽略 */ }
}

const { C, makeBanner, log } = require('./lib/ui');
const logger = require('./lib/logger');
const { parseArgs, buildConfig, isNumericUid, HELP } = require('./lib/args');
const { qrLogin, runInteractive } = require('./lib/interactive');
const { runWatcher } = require('./lib/watcher');
const { resolveCommentOid, extractId } = require('./lib/api');
const { loadConfig } = require('./lib/state');

const VERSION = '1.3.0';
const BANNER = makeBanner(VERSION);

// ====== 主流程 ======
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  if (args.verbose) logger.setLevel('debug'); // -v：请求摘要等 debug 级信息写入日志文件
  logger.info(`===== 启动 v${VERSION} | ${process.argv.slice(2).join(' ') || '(交互模式)'} =====`);

  // ---- 扫码登录：独立执行，成功后保存 Cookie 并退出 ----
  if (args.login) {
    try {
      log(C.dim('正在生成登录二维码...'));
      await qrLogin(log);
    } catch (err) {
      console.error(C.red(`✗ 登录失败: ${err.message}`));
      logger.error(`登录失败: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  const saved = loadConfig();
  const cfg = buildConfig(args, saved);
  // 裸参数 oid / rpid 可能是链接 → 提取数字 ID；opus 链接自动转换评论 oid
  if (cfg.oid) {
    const r = await resolveCommentOid(cfg.oid, cfg.cookie);
    cfg.oid = r.oid;
    if (r.type != null) cfg.type = r.type;
  }
  if (cfg.rpid) cfg.rpid = extractId(cfg.rpid);
  if (!Number.isFinite(cfg.interval) || cfg.interval < 10) cfg.interval = 60;
  if (!Number.isFinite(cfg.type)) cfg.type = 11;
  // uid 必须是纯数字（拼入 API URL，脏值产生无效请求且无提示）
  if (args.uid && !isNumericUid(args.uid)) {
    console.error(C.red(`--uid 必须是数字 UID，收到: ${args.uid}`));
    logger.error(`参数错误: --uid 非数字 (${args.uid})`);
    process.exit(1);
  }
  if (saved.uid && !isNumericUid(saved.uid)) {
    console.error(C.red(`配置中的 uid 非法（${saved.uid}），请删除 ~/.bili-pinned-card/config.json 后重试`));
    logger.error(`配置错误: 已保存 uid 非法 (${saved.uid})`);
    process.exit(1);
  }

  // ---- 交互引导（TTY 下无 --oid 且未显式 --cookie 时；就地修改 cfg） ----
  const inter = await runInteractive(cfg, { args, banner: BANNER });
  if (inter.exit) return;

  // ---- 执行监控 ----
  await runWatcher(cfg, { bannerShown: inter.ran, banner: BANNER });
}

if (require.main === module) {
  main().catch(err => {
    console.error(C.red('致命错误: ' + (err?.message || err)));
    logger.error('致命错误: ' + (err?.message || err));
    process.exit(1);
  });
}

module.exports = { parseArgs, buildConfig };
