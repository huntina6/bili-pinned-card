'use strict';
/**
 * 交互式配置引导（从 cli.js 拆出）
 * - qrLogin：扫码登录（--login 与交互模式共用）
 * - runInteractive：TTY 下无 --oid 且未显式 --cookie 时逐步引导（❯ 设计语言与文案保持原样）
 * 依赖：ui / logger / state / api / login，不依赖 cli.js
 */
const readline = require('readline');
const ui = require('./ui');
const { C, log, attach, ask, section, select, selectYN, summaryRow, displayWidth } = ui;
const logger = require('./logger');
const { resolveCommentOid } = require('./api');
const { loadConfig, saveConfig, DEFAULT_UID, CFG_FILE } = require('./state');

// ====== 扫码登录（--login 与交互模式共用） ======
/** 执行扫码登录并保存 Cookie；成功返回 { cookieStr, uname, mid }，失败抛出 */
async function qrLogin(log) {
  const { loginFlow } = require('./login');
  const { cookieStr, uname, mid } = await loginFlow({
    log,
    onStatus: (code) => {
      // 只提示关键动作，避免 2.5s 一次的轮询刷屏
      if (code === 86090) log(C.yellow(`已扫码！请在手机 B站 App 上点击「确认登录」`));
      else if (code === 86038) log(C.yellow('二维码已失效，正在等待重新生成...'));
    },
  });
  saveConfig({ ...loadConfig(), cookie: cookieStr });
  log(`${C.green('✅ 登录成功:')} ${uname} (UID ${mid})`);
  log(C.dim(`Cookie 已保存至 ${CFG_FILE}，后续命令自动沿用（有效期约 30 天，过期后重新 --login）`));
  return { cookieStr, uname, mid };
}

/**
 * 交互式配置引导（就地修改 cfg）
 * @param {CliConfig} cfg buildConfig 产物
 * @param {{args: {oid?: string|null, cookie?: string|null}, banner: string}} opts 原始参数与启动横幅
 * @returns {Promise<{ran: boolean, exit?: boolean}>} ran=是否进行了交互；exit=用户选择退出
 */
async function runInteractive(cfg, { args, banner }) {
  // ---- 交互模式：终端提示引导 ----
  if (!(process.stdin.isTTY && !args.oid && args.cookie == null)) {
    if (!cfg.oid && !cfg.cookie) {
      // 非交互且无 oid：尝试匿名自动识别（可能被风控）
      console.log(C.dim('未指定 --oid 且无 Cookie，尝试匿名自动识别置顶动态（可能被风控）...'));
    }
    return { ran: false };
  }
  console.log(banner);
  log(C.dim(`运行日志: ${logger.logDir()}（排障加 -v 记录每次 API 请求）`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  attach(rl);

  // —— 模式选择（↑/↓ 移动光标，回车确认） ——
  section('运行模式');
  console.log(C.dim('  ↑/↓ 选择，回车确认'));
  const mode = await select([
    { key: '1', label: '持续监控', desc: '置顶评论变化自动出图（默认）' },
    { key: '2', label: '单次检查', desc: '立即检查置顶并出图一次' },
    { key: '3', label: 'UP 热评 TOP 卡', desc: 'UP 的每条一级评论出一张卡' },
    { key: '0', label: '退出', desc: '' },
  ], 0);
  if (mode === '0') { console.log('\n再见 👋'); rl.close(); attach(null); return { ran: true, exit: true }; }
  const hot = mode === '3'; // UP 热评 TOP 卡模式（一次性批量出图）
  cfg.once = mode === '2' || hot;
  if (hot) {
    const nAns = await ask('每张卡的粉丝高赞区条数', '10');
    cfg.upTop = Math.max(1, Math.min(50, parseInt(nAns, 10) || 10));
  } else {
    cfg.upTop = 0; // 交互未选热评时强制清零（防已保存配置残留误入热评分支）
  }

  // —— 目标设置 ——
  section('目标设置');
  const uidAns = await ask('目标 UP 主 UID', cfg.uid);
  cfg.uid = uidAns || DEFAULT_UID;

  // —— 登录方式：沿用已保存 / 扫码模式 / 匿名模式 ——
  section('登录方式');
  console.log(C.dim('  ↑/↓ 选择，回车确认'));
  const cookieOpts = [];
  if (cfg.cookie) {
    const uidM = String(cfg.cookie).match(/DedeUserID=(\d+)/);
    cookieOpts.push({
      key: 'keep',
      label: '沿用已保存 Cookie',
      desc: uidM ? `已登录 UID ${uidM[1]}` : '回车直接沿用',
    });
    cookieOpts.push({ key: 'scan', label: '扫码模式', desc: '重新扫码登录刷新 Cookie（推荐）' });
    cookieOpts.push({ key: 'anon', label: '匿名模式', desc: '清除已保存的 Cookie' });
  } else {
    cookieOpts.push({ key: 'anon', label: '匿名模式', desc: '无需登录，部分场景可能被风控（-352）' });
    cookieOpts.push({ key: 'scan', label: '扫码模式', desc: '手机扫码登录，自动保存全新 Cookie（解锁全量评论，推荐）' });
  }
  const cookieMode = await select(cookieOpts, 0);
  if (cookieMode === 'scan') {
    try {
      const { cookieStr } = await qrLogin(log);
      cfg.cookie = cookieStr; // 本次运行立即生效（qrLogin 已持久化）
    } catch (err) {
      console.error(C.red(`  ✗ 扫码登录失败: ${err.message}，本次沿用原登录状态运行`));
      logger.error(`交互扫码登录失败: ${err.message}`);
    }
  } else if (cookieMode === 'anon') {
    const hadCookie = !!cfg.cookie;
    cfg.cookie = '';
    if (!cfg.quiet) log(C.dim(hadCookie ? '已清除已保存的 Cookie，本次以匿名模式运行' : '本次以匿名模式运行'));
  }

  // —— 动态目标（链接解析需用上面确定的 Cookie） ——
  section('动态目标');
  const oidAns = await ask(
    hot
      ? '动态链接或 ID（推荐填单条动态；留空则检索该 UP 全账号动态，逐条确认处理）'
      : '动态链接或 ID（可选，留空则自动识别置顶动态；支持 Opus 链接）',
    cfg.oid || '');
  if (oidAns) {
    try {
      const r = await resolveCommentOid(oidAns, cfg.cookie);
      cfg.oid = r.oid;
      if (r.type != null) cfg.type = r.type;
    } catch (e) {
      console.log(C.red(`  ✗ 链接解析失败: ${e.message}，请检查后重试`));
      logger.error(`链接解析失败: ${e.message}`);
    }
  }

  if (!cfg.oid && !cfg.cookie) {
    console.log(C.yellow(hot
      ? '  ⚠ 全账号检索需要 Cookie（匿名会被风控 -352）；可回头选「扫码模式」或填写单条动态链接'
      : '  ⚠ 未提供 Cookie 时自动识别置顶动态可能被风控（-352），届时程序会提示你补充。'));
  }

  // —— 监控行为（仅置顶监测模式；热评模式为一次性批量出图，无需间隔/动态监测） ——
  if (!hot) {
    section('监控行为');
    if (!cfg.once) {
      const iv = await ask('检查间隔（秒）', String(cfg.interval));
      if (parseInt(iv, 10) >= 10) cfg.interval = parseInt(iv, 10);
    }
    cfg.trackDyn = await selectYN('同时监测普通动态更新（置顶未变但发了新动态时提示并出图）', cfg.trackDyn);
  }

  // —— 卡片与输出 ——
  section(hot ? '输出设置' : '卡片与输出');
  if (!hot) cfg.showReplies = await selectYN('卡片上绘制精彩回复', cfg.showReplies);
  const outAns = await ask('输出目录', cfg.outDir);
  if (outAns) cfg.outDir = outAns;
  const nameAns = await ask('卡片标题显示名（留空自动取 UP 名）', cfg.upName || '');
  if (nameAns) cfg.upName = nameAns;

  // 保存配置（Cookie 也保存，下次免输；注意保管本机安全）
  saveConfig({
    uid: cfg.uid, oid: cfg.oid, type: cfg.type, cookie: cfg.cookie,
    upName: cfg.upName, showReplies: cfg.showReplies,
    interval: cfg.interval, outDir: cfg.outDir, trackDyn: cfg.trackDyn,
  });
  rl.close();
  attach(null);

  // —— 配置汇总 ——
  const cookieUid = String(cfg.cookie || '').match(/DedeUserID=(\d+)/)?.[1];
  console.log(`\n${C.pink('┌─ ')}${C.bold('配置完成')}${C.pink(` ${'─'.repeat(Math.max(2, 44 - displayWidth('配置完成') - 4))}┐`)}`);
  summaryRow('目标', cfg.oid ? `动态 ${cfg.oid}` : `UID ${cfg.uid}`);
  summaryRow('登录', cookieUid ? `UID ${cookieUid}（已登录）` : '匿名');
  summaryRow('模式', hot
    ? `UP 热评 TOP 卡 · 高赞区 ${cfg.upTop} 条/卡`
    : (cfg.once ? '单次检查' : `持续监控 · 每 ${cfg.interval}s`));
  if (!hot && cfg.trackDyn) summaryRow('监测', '普通动态更新已开启');
  if (!hot && cfg.showReplies) summaryRow('卡片', '含精彩回复');
  summaryRow('输出', cfg.outDir);
  console.log(`\n${C.green('✔')} 开始运行，Ctrl+C 随时退出\n`);
  return { ran: true };
}

module.exports = { qrLogin, runInteractive };
