'use strict';
/**
 * 监控执行与主循环（从 cli.js 拆出）
 * - classifyError：错误分类纯函数（-101 登录态 / -352·-412·-799 风控 / 其他）
 * - runWatcher：运行前提示（非交互 banner）→ SIGINT → checkOnce 循环 → 完成提示
 * 依赖：monitor / api / ui / logger，不依赖 cli.js
 */
const { C, log } = require('./ui');
const logger = require('./logger');
const { checkOnce } = require('./monitor');
const { BiliError } = require('./api');

/**
 * 错误分类（纯函数，便于单测）
 * @returns {'auth'|'risk'|'other'} auth=Cookie 失效；risk=风控/限流；other=其他
 */
function classifyError(err) {
  if (err instanceof BiliError) {
    if (err.code === -101) return 'auth';
    if (err.code === -352 || err.code === -412 || err.code === -799) return 'risk';
  }
  return 'other';
}

/**
 * 执行监控主循环（once 单次 / watch 持续）
 * @param {object} cfg 运行配置（buildConfig + 交互修改后）
 * @param {object} opts { bannerShown 交互阶段是否已打印 banner, banner 启动横幅 }
 */
async function runWatcher(cfg, { bannerShown, banner }) {
  const modeTxt = cfg.upTop
    ? `UP 热评 TOP 卡（高赞区 ${cfg.upTop} 条/卡）`
    : (cfg.once ? '单次检查' : `每 ${cfg.interval}s 监控`);
  if (!cfg.quiet && !bannerShown) {
    console.log(banner);
    log(C.dim(`运行日志: ${logger.logDir()}（排障加 -v 记录每次 API 请求）`));
    log(`${C.bold('目标:')} ${cfg.oid ? '动态 ' + cfg.oid : 'UID ' + cfg.uid}${cfg.cookie ? ' ' + C.dim('(已带 Cookie)') : C.dim(' (匿名)')}`);
    log(`${C.bold('输出:')} ${cfg.outDir} · ${modeTxt}${cfg.force ? ' · 强制出图' : ''}${cfg.showReplies && !cfg.upTop ? ' · 含精彩回复' : ''}`);
    log('');
  }

  // ---- 执行 ----
  let running = true;
  const stopped = () => { running = false; };

  if (process.stdin.isTTY) {
    process.on('SIGINT', () => {
      console.log('');
      log(C.yellow('收到 Ctrl+C，正在退出...'));
      stopped();
      setTimeout(() => process.exit(0), 100);
    });
  }

  const loop = async () => {
    while (running) {
      const t0 = Date.now();
      try {
        const res = await checkOnce(cfg);
        if (res.event === 'error') break; // 参数错误（如 --rpid 缺 --oid），继续循环只会重复报错
        if (res.file && cfg.quiet) {
          console.log(res.file); // quiet 模式只输出文件路径（方便脚本取用）
        }
      } catch (err) {
        const kind = classifyError(err);
        if (kind === 'auth') {
          console.log(C.red(`  ✗ Cookie 已失效 (-101)：${err.message}`));
          logger.error(`Cookie 失效 (-101): ${err.message}`);
          console.log(C.yellow('  → 解决：运行 --login 重新扫码登录（Cookie 约 30 天有效）'));
          if (cfg.once) { process.exitCode = 1; return; }
        } else if (kind === 'risk') {
          const freqHint = cfg.cookie
            ? '请求过于频繁被 B站 限流（本机 IP/指纹），请等待数分钟冷却后重试；程序已内置每次请求 1~2s 随机节流'
            : '匿名请求被风控，建议 --login 扫码登录后重试，或直接指定动态 ID（--oid <动态ID>）';
          console.log(C.red(`  ⚠ 风控 (${err.code})：${err.message}`));
          logger.warn(`风控 (${err.code}): ${err.message}`);
          console.log(C.yellow(`  → ${freqHint}`));
          if (cfg.once) { process.exitCode = 1; return; }
        } else {
          console.log(C.red(`  ✗ 检查失败: ${err.message || err}`));
          logger.error(`检查失败: ${err.message || err}`);
        }
      }

      if (cfg.once || !running) break;
      const elapsed = Date.now() - t0;
      const wait = Math.max(1, cfg.interval * 1000 - elapsed);
      if (!cfg.quiet) log(C.dim(`下次检查: ${new Date(Date.now() + wait).toLocaleTimeString('zh-CN', { hour12: false })}`));
      await new Promise(r => setTimeout(r, wait));
    }
  };

  await loop();
  if (cfg.once) {
    console.log(C.dim('单次检查完成。'));
  }
}

module.exports = { classifyError, runWatcher };
