'use strict';
/**
 * 监控执行与主循环（从 cli.js 拆出）
 * - classifyError：错误分类纯函数（-101 登录态 / -352·-412·-799 风控 / 其他）
 * - runWatcher：运行前提示（非交互 banner）→ SIGINT → checkOnce 循环 → 完成提示
 *   同时作为通知推送的唯一出口：每个 checkOnce 结果经 notifyResult 分发（未配置 Webhook 时空操作）
 * 依赖：monitor / api / ui / logger / notify，不依赖 cli.js
 */
const { C, log } = require('./ui');
const logger = require('./logger');
const { checkOnce } = require('./monitor');
const { notifyResult } = require('./notify');
const { BiliError, RISK_CODES } = require('./api');
const { W: CARD_W } = require('./card/constants');
const jsonout = require('./jsonout'); // 机器可读输出（--json 未启用时全部为 no-op）

/**
 * 错误分类（纯函数，便于单测）
 * @returns {'auth'|'risk'|'expired'|'other'} auth=Cookie 失效；risk=风控/限流/签名失败；expired=Token 过期；other=其他
 */
function classifyError(err) {
  if (err instanceof BiliError) {
    if (err.code === -101) return 'auth';
    // RISK_CODES = -352/-403/-412/-509/-799：可用节流 + 重试/Cookie 刷新恢复
    if (RISK_CODES.includes(err.code)) return 'risk';
    if (err.code === -658) return 'expired';
  }
  return 'other';
}

const MAX_BACKOFF_MS = 10 * 60 * 1000; // 退避上限 10 分钟
let _sigintBound = false; // 进程级 Ctrl+C 只绑定一次（菜单循环会重复调用 runWatcher）
let _sigtermBound = false;
let _stopActive = null;   // 当前运行实例的停止回调
let _stopEmit = null;     // 当前运行实例的机器可读结束事件（--json；菜单循环每轮重置）

/** Ctrl+C：优雅退出（TTY 交互场景） */
function onSigint() {
  console.log('');
  log(C.yellow('收到 Ctrl+C，正在退出...'));
  if (_stopActive) _stopActive();
  if (_stopEmit) _stopEmit('sigint');
  setTimeout(() => process.exit(0), 100);
}
/** SIGTERM：脚本/AI 停止长驻进程的常规方式，同样补一行 end 事件 */
function onSigterm() {
  log(C.yellow('收到 SIGTERM，正在退出...'));
  if (_stopActive) _stopActive();
  if (_stopEmit) _stopEmit('sigterm');
  setTimeout(() => process.exit(0), 100);
}

/**
 * 风控/错误自适应退避（纯函数，便于单测）：interval × 2^(streak-1)，封顶 10 分钟，±20% 抖动
 * 对应「B站 412 标准处置：调大检查间隔、增加等待、避免规律性」
 * @param {number} intervalSec 基础监控间隔（秒）
 * @param {number} streak 连续失败次数（≥1）
 * @param {() => number} [rng] 随机源（默认 Math.random；注入 () => 0.5 可关闭抖动）
 * @returns {number} 等待毫秒数
 */
function computeBackoffMs(intervalSec, streak, rng = Math.random) {
  const base = Math.max(1, intervalSec) * 1000;
  const exp = Math.min(Math.max(1, streak) - 1, 3); // 1x / 2x / 4x / 8x
  const jitter = 0.8 + rng() * 0.4;
  return Math.round(Math.min(MAX_BACKOFF_MS, base * 2 ** exp * jitter));
}

/**
 * 执行监控主循环（once 单次 / watch 持续）
 * @param {CliConfig} cfg 运行配置（buildConfig + 交互修改后）
 * @param {{bannerShown: boolean, banner: string}} opts 交互阶段是否已打印 banner、启动横幅
 */
async function runWatcher(cfg, { bannerShown, banner }) {
  const modeTxt = cfg.upTop
    ? `UP 热评 TOP 卡（高赞区 ${cfg.upTop} 条/卡）`
    : (cfg.once ? '单次检查' : `每 ${cfg.interval}s 监控`);
  if (!cfg.quiet && !bannerShown && !cfg.json) {
    console.log(banner);
    log(C.dim(`运行日志: ${logger.logDir()}（排障加 -v 记录每次 API 请求）`));
    log(`${C.bold('目标:')} ${cfg.oid ? '动态 ' + cfg.oid : 'UID ' + cfg.uid}${cfg.cookie ? ' ' + C.dim('(已带 Cookie)') : C.dim(' (匿名)')}`);
    log(`${C.bold('输出:')} ${cfg.outDir} · ${modeTxt} · ${Math.round(CARD_W * (cfg.scale || 2))}px${cfg.force ? ' · 强制出图' : ''}${cfg.showReplies && !cfg.upTop ? ' · 含精彩回复' : ''}`);
    log('');
  }

  // ---- 执行 ----
  let running = true;
  let hadError = false; // 本次运行是否以「失败」收尾（决定 --once 的退出码与结束语）
  let cards = 0;        // 本次运行产出的卡片数（机器可读 end 事件里回执）
  const startedAt = Date.now();
  const stopped = () => { running = false; };

  _stopActive = stopped;
  _stopEmit = reason => jsonout.emit({
    type: 'end', ok: !hadError, exitCode: 0, cards,
    durationMs: Date.now() - startedAt, reason,
  });
  if (process.stdin.isTTY && !_sigintBound) {
    _sigintBound = true;
    process.on('SIGINT', onSigint);
  }
  // 长驻（watch）时接管 SIGTERM：脚本/AI 用 kill 停止时也能拿到机器可读的结束事件
  if (!cfg.once && !_sigtermBound) {
    _sigtermBound = true;
    process.on('SIGTERM', onSigterm);
  }

  const loop = async () => {
    let failStreak = 0;   // 连续失败次数（成功自动复位）
    let nextWaitMs = null; // 本次失败后的退避等待（null=按基础 interval）
    while (running) {
      const t0 = Date.now();
      try {
        const res = await checkOnce(cfg);
        // 通知层唯一出口（best-effort）：未配置 webhook / 事件未订阅 / 事件不可映射时零开销跳过
        await notifyResult(cfg, res);
        // 机器可读结果（--json）：每次检查一行，comment 用精简结构
        cards += Number(res.cards) || (res.file ? 1 : 0);
        jsonout.emit({
          ...res,
          type: 'result', // 必须写在展开之后：res.type 是评论区类型（11/1/12…），不能覆盖事件类型
          ok: res.event !== 'error',
          comment: jsonout.pickComment(res.comment),
          durationMs: Date.now() - t0,
        });
        // 参数/目标类错误（如 --rpid 缺 --oid、--up-top 全账号未带 Cookie）：继续循环只会重复报错。
        // 必须让退出码体现失败——此前静默 exit 0，cron/脚本无法区分「跑成功」与「配置写错」
        if (res.event === 'error') {
          hadError = true;
          process.exitCode = 1;
          jsonout.emit({
            type: 'error', ok: false,
            error: { kind: 'usage', code: null, message: '目标无效或缺少必要参数' },
            hint: '运行 node cli.js --帮助 查看用法；出图需给出评论所属动态（可直接粘评论分享链接）',
          });
          break;
        }
        // 单次模式下拉取结果不可信（动态已删/-404 等）同样算失败；watch 模式不置错，继续自愈重试
        if (res.event === 'fetch-error' && cfg.once) { hadError = true; process.exitCode = 1; }
        if (res.file && cfg.quiet) {
          console.log(res.file); // quiet 模式只输出文件路径（方便脚本取用）
        }
        if (failStreak > 0) {
          failStreak = 0;
          nextWaitMs = null;
          if (!cfg.quiet) log(C.green('✔ 请求已恢复，监控间隔复位'));
        }
      } catch (err) {
        const kind = classifyError(err);
        // 机器可读错误（--json）：kind 供 AI 决定下一步（auth → 引导用户登录；risk → 稍后重试）
        jsonout.emit({ type: 'error', ok: false, ...jsonout.describeError(err), durationMs: Date.now() - t0 });
        // 仅对需人工介入的凭据类错误推送（风控类会自愈，逐次推送会刷屏）
        if (kind === 'auth' || kind === 'expired') {
          await notifyResult(cfg, { event: 'error', message: err.message, oid: cfg.oid || null });
        }
        failStreak++;
        nextWaitMs = computeBackoffMs(cfg.interval, failStreak);
        const cooldownTxt = `约 ${Math.round(nextWaitMs / 1000)}s 后自动重试（连续第 ${failStreak} 次失败，成功后自动恢复）`;
        if (kind === 'auth') {
          console.log(C.red(`  ✗ Cookie 已失效 (-101)：${err.message}`));
          logger.error(`Cookie 失效 (-101): ${err.message}`);
          console.log(C.yellow('  → 解决：运行 --login 重新扫码登录（Cookie 约 30 天有效）'));
          if (cfg.once) { process.exitCode = 1; return; }
        } else if (kind === 'expired') {
          console.log(C.red(`  ✗ 登录凭证已过期 (-658)：${err.message}`));
          logger.error(`Token 过期 (-658): ${err.message}`);
          console.log(C.yellow('  → 解决：运行 --login 重新扫码登录'));
          if (cfg.once) { process.exitCode = 1; return; }
        } else if (kind === 'risk') {
          const isSignErr = err.code === -403;
          const freqHint = isSignErr
            ? '接口签名校验失败（WBI）：通常是 Cookie 过期或本地时间偏差过大导致；请先 `--login` 刷新 Cookie，若仍失败请检查系统时间'
            : (cfg.cookie
              ? '请求过于频繁被 B站 限流（本机 IP/指纹），程序已自动退避冷却并恢复，也可等待数分钟后重试'
              : '匿名请求被风控，程序已自动退避冷却；建议 --login 扫码登录后重试，或直接指定动态 ID（--oid <动态ID>）');
          console.log(C.red(`  ⚠ 风控 (${err.code})：${err.message}`));
          logger.warn(`风控 (${err.code}): ${err.message}`);
          console.log(C.yellow(`  → ${freqHint}`));
          if (cfg.once) { process.exitCode = 1; return; }
        } else {
          console.log(C.red(`  ✗ 检查失败: ${err.message || err}`));
          logger.error(`检查失败: ${err.message || err}`);
        }
        // 单次模式（--once / 向导「开始运行」）不再重试：提示退避会自相矛盾（曾出现「约 58s 后自动重试」紧接「单次检查完成」）
        if (!cfg.quiet && !cfg.once) console.log(C.dim(`  ⏳ 已自动退避：${cooldownTxt}`));
      }

      if (cfg.once || !running) break;
      const elapsed = Date.now() - t0;
      const base = nextWaitMs != null ? nextWaitMs : cfg.interval * 1000;
      const wait = Math.max(1, base - elapsed);
      if (!cfg.quiet) log(C.dim(`下次检查: ${new Date(Date.now() + wait).toLocaleTimeString('zh-CN', { hour12: false })}`));
      await new Promise(r => setTimeout(r, wait));
    }
  };

  await loop();
  _stopActive = null;
  _stopEmit = null;
  jsonout.emit({ type: 'end', ok: !hadError, exitCode: hadError ? 1 : 0, cards, durationMs: Date.now() - startedAt });
  if (cfg.once) {
    console.log(C.dim(hadError ? '单次检查未完成（见上方错误）。' : '单次检查完成。'));
  }
}

module.exports = { classifyError, computeBackoffMs, MAX_BACKOFF_MS, runWatcher };
