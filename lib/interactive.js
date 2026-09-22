'use strict';
/**
 * 交互式配置引导（从 cli.js 拆出）
 * - qrLogin：扫码登录（--login 与交互模式共用）
 * - runInteractive：TTY 下无 --oid 且未显式 --cookie 时逐步引导（❯ 设计语言与文案保持原样）
 * 依赖：ui / logger / state / api / login，不依赖 cli.js
 */
const readline = require('readline');
const os = require('os');
const path = require('path');
const ui = require('./ui');
const { C, log, attach, ask, askValidated, askSecretValidated, startSpinner, CANCEL, section, select, selectYN, summaryRow, displayWidth } = ui;
const logger = require('./logger');
const { resolveCommentOid, extractId } = require('./api');
const { DEFAULT_UID, loadConfig, saveConfig, CFG_FILE } = require('./state');
const { DEFAULT_OUT_DIR } = require('./args');
const { W: CARD_W } = require('./card/constants');
const emoji = require('./card/emoji');

// ====== 交互输入校验与路径处理（纯函数，便于单测） ======
/** 展开路径开头的 ~（~ 或 ~/、~\）；其他原样返回 */
function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}
function validateUidInput(v) {
  return /^\d+$/.test(String(v)) ? null : 'UID 必须是纯数字（在 UP 主空间页地址中可看到 mid=）';
}
function validateIntervalInput(v) {
  return /^\d+$/.test(String(v)) && parseInt(v, 10) >= 10 ? null : '间隔需为不小于 10 的整数（过频会被风控）';
}
function validateTopNInput(v) {
  const n = parseInt(v, 10);
  return /^\d+$/.test(String(v)) && n >= 1 && n <= 50 ? null : '请输入 1-50 的整数';
}
function validateWidthInput(v) {
  const n = parseInt(v, 10);
  return /^\d+$/.test(String(v)) && n >= 340 && n <= 4080 ? null : '请输入 340-4080 的整数（像素）';
}
function validateCookieInput(v) {
  return String(v || '').includes('SESSDATA=') ? null : 'Cookie 需包含 SESSDATA=（浏览器 F12 → Application → Cookies 复制）';
}
function validateRpidInput(v) {
  return /^\d+$/.test(extractId(v)) ? null : '评论 ID 需为数字或评论分享链接';
}
/**
 * 登录能力矩阵：游客（无 Cookie）不可用 UID 自动识别 / 全账号热评 / 完整子回复（仅第一页 20 条）
 * @param {boolean} loggedIn
 * @returns {{autoIdentify: boolean, fullSubReplies: boolean, fullAccountTop: boolean}}
 */
function loginCapabilities(loggedIn) {
  const on = !!loggedIn;
  return { autoIdentify: on, fullSubReplies: on, fullAccountTop: on };
}

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
 * @param {{args: {oid?: string|null, cookie?: string|null, noInput?: boolean}, banner: string, bannerShown?: boolean}} opts 原始参数与启动横幅
 * @returns {Promise<{ran: boolean, exit?: boolean}>} ran=是否进行了交互；exit=用户选择退出/取消
 */
async function runInteractive(cfg, { args, banner, bannerShown = false }) {
  // ---- 交互模式：终端提示引导（--no-input 显式禁用；非 TTY 自动跳过） ----
  if (!(process.stdin.isTTY && !args.oid && args.cookie == null && !args.noInput)) {
    if (!cfg.oid && !cfg.cookie) {
      // 非交互且无 oid：尝试匿名自动识别（可能被风控）
      console.log(C.dim('未指定 --oid 且无 Cookie，尝试匿名自动识别置顶动态（可能被风控）...'));
    }
    return { ran: false };
  }
  if (banner && !bannerShown) console.log(banner);
  log(C.dim(`运行日志: ${logger.logDir()}（排障加 -v 记录每次 API 请求）`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  attach(rl);

  // Ctrl+C / Esc 统一取消出口：先恢复终端（raw/光标/监听器），再退出
  let cancelled = false;
  const teardown = () => {
    ui.cancelActivePrompts();
    try { rl.close(); } catch { /* 忽略 */ }
    attach(null);
  };
  const cancel = () => {
    teardown();
    console.log(`\n${C.yellow('已取消配置，未运行。')}`);
    process.exitCode = 130;
    return { ran: true, exit: true };
  };
  rl.on('SIGINT', () => {
    if (cancelled) return;
    cancelled = true;
    teardown();
    console.log(`\n${C.yellow('已取消配置，未运行。')}`);
    process.exit(130);
  });

  // —— 登录状态（第一步：先确定能力边界，再决定可选项） ——
  section('登录状态');
  console.log(C.dim('  ↑/↓ 或数字键选择，回车确认'));
  const savedUidM = String(cfg.cookie || '').match(/DedeUserID=(\d+)/);
  const loginOpts = [];
  if (cfg.cookie) {
    loginOpts.push({ key: 'login', label: '已登录', desc: `沿用已保存 Cookie${savedUidM ? `（UID ${savedUidM[1]}）` : ''}` });
    loginOpts.push({ key: 'scan', label: '重新扫码登录', desc: '刷新 Cookie（有效期约 30 天，推荐）' });
    loginOpts.push({ key: 'manual', label: '手动粘贴 Cookie', desc: '浏览器 F12 复制 SESSDATA（备用方式）' });
    loginOpts.push({ key: 'guest', label: '游客模式', desc: '清除已保存 Cookie；仅限指定动态，功能受限' });
  } else {
    loginOpts.push({ key: 'scan', label: '扫码登录', desc: '解锁 UID 自动识别 / 完整子回复 / 全账号热评' });
    loginOpts.push({ key: 'manual', label: '手动粘贴 Cookie', desc: '浏览器 F12 复制 SESSDATA（无扫码环境时）' });
    loginOpts.push({ key: 'guest', label: '游客模式', desc: '免登录；仅限指定动态，子回复仅第一页' });
  }
  const loginMode = await select(loginOpts, 0);
  if (loginMode === CANCEL) return cancel();
  if (loginMode === 'scan') {
    try {
      const { cookieStr } = await qrLogin(log);
      cfg.cookie = cookieStr; // 本次运行立即生效（qrLogin 已持久化）
    } catch (err) {
      console.error(C.red(`  ✗ 扫码登录失败: ${err.message}`));
      logger.error(`交互扫码登录失败: ${err.message}`);
      console.log(C.yellow(cfg.cookie ? '  本次沿用已保存 Cookie 运行。' : '  将继续以游客模式运行（功能受限）。'));
    }
  } else if (loginMode === 'manual') {
    console.log(C.dim('  提示：输入过程仅显示 *，不会回显 Cookie 内容'));
    const ckAns = await askSecretValidated('Cookie（SESSDATA=xxx; bili_jct=yyy）', validateCookieInput);
    if (ckAns === CANCEL) return cancel();
    cfg.cookie = String(ckAns); // CANCEL 已在上方返回
    if (!cfg.quiet) log(C.dim('已使用手动填写的 Cookie（完成配置后写入本机 config.json）'));
  } else if (loginMode === 'guest') {
    const hadCookie = !!cfg.cookie;
    cfg.cookie = '';
    if (!cfg.quiet) log(C.dim(hadCookie ? '已清除已保存的 Cookie，本次以游客模式运行' : '本次以游客模式运行'));
  }
  const cap = loginCapabilities(!!cfg.cookie);
  console.log(C.dim(cap.autoIdentify
    ? '  可用：UID 自动识别置顶动态 · 完整子回复 · 全账号热评检索'
    : '  可用：指定动态出图；不可用：UID 自动识别 · 全账号热评 · 完整子回复（仅第一页 20 条）'));

  // —— 模式选择（↑/↓ 移动光标，回车确认；数字键直达；Esc/Ctrl+C 取消） ——
  section('运行模式');
  console.log(C.dim('  ↑/↓ 或数字键选择，回车确认'));
  const mode = await select([
    { key: '1', label: '持续监控', desc: cap.autoIdentify ? '置顶评论变化自动出图（默认）' : '指定动态的置顶评论变化自动出图' },
    { key: '2', label: '单次检查', desc: cap.autoIdentify ? '立即检查置顶并出图一次' : '立即检查指定动态并出图一次' },
    { key: '3', label: 'UP 热评 TOP 卡', desc: cap.fullAccountTop ? 'UP 的每条一级评论出一张卡（可全账号）' : '指定单条动态，UP 的每条一级评论出一张卡' },
    { key: '4', label: '指定评论出图', desc: '手动出旧置顶/任意评论卡（可选 UP 互动回顾）' },
    { key: '0', label: '退出', desc: '' },
  ], 0);
  if (mode === CANCEL) return cancel();
  if (mode === '0') { console.log('\n再见 👋'); teardown(); return { ran: true, exit: true }; }
  const hot = mode === '3';       // UP 热评 TOP 卡模式（一次性批量出图）
  const manual = mode === '4';    // 指定评论出图（--rpid，可选 --context）
  cfg.once = mode === '2' || hot || manual;
  if (hot) {
    const nAns = await askValidated('每张卡的粉丝高赞区条数（1-50）', '10', validateTopNInput);
    if (nAns === CANCEL) return cancel();
    cfg.upTop = parseInt(nAns, 10);
  } else {
    cfg.upTop = 0; // 交互未选热评时强制清零（防已保存配置残留误入热评分支）
  }

  // —— 目标设置 ——
  section('目标设置');
  if (cap.autoIdentify) {
    const uidAns = await askValidated('目标 UP 主 UID', cfg.uid, validateUidInput);
    if (uidAns === CANCEL) return cancel();
    cfg.uid = uidAns || DEFAULT_UID;
  } else {
    // 游客：跳过 UID（自动识别不可用），UP 身份改由动态/评论自动识别；已保存 UID 保留在配置中
    console.log(C.dim('  游客模式：跳过 UID（自动识别不可用），UP 身份将从动态自动识别'));
    cfg.uidExplicit = false;
  }
  const uidForSave = cfg.uid; // 游客时保留原已保存 UID，避免被空值覆盖
  if (!cap.autoIdentify) cfg.uid = '';

  // —— 动态目标（链接解析需用上面确定的登录状态） ——
  section('动态目标');
  const needOid = manual || !cap.autoIdentify;
  let oidAns;
  if (needOid) {
    const q = manual
      ? '动态链接或 ID（指定评论出图必填）'
      : (hot ? '动态链接或 ID（游客模式必填：仅支持单条动态）' : '动态链接或 ID（游客模式必填，不支持留空自动识别）');
    oidAns = await askValidated(q, cfg.oid || '',
      v => (String(v || '').trim() ? null : (manual ? '指定评论出图需先填写动态链接或 ID' : '游客模式必须填写动态链接或 ID（登录后可用 UID 自动识别）')));
  } else {
    oidAns = await ask(
      hot
        ? '动态链接或 ID（推荐填单条动态；留空则检索该 UP 全账号动态，逐条确认处理）'
        : '动态链接或 ID（可选，留空则自动识别置顶动态；支持 Opus 链接）',
      cfg.oid || '');
  }
  if (oidAns === CANCEL) return cancel();
  if (oidAns) {
    const sp = startSpinner('正在解析动态链接...');
    try {
      const r = await resolveCommentOid(oidAns, cfg.cookie);
      cfg.oid = r.oid;
      if (r.type != null) cfg.type = r.type;
      sp.stop(C.green('  ✓ 动态链接已解析'));
    } catch (e) {
      sp.stop(); // 先清除 spinner 再打印错误
      // 解析失败必须阻断：否则 cfg.oid 会静默保留上一次的旧值，用户以为在监控新目标，实际监控的是旧目标
      console.log(C.red(`  ✗ 链接解析失败: ${e.message}`));
      logger.error(`链接解析失败: ${e.message}`);
      console.log(C.yellow('  本次已取消运行，请重新执行并填写有效的动态链接或 ID。'));
      teardown();
      process.exitCode = 130;
      return { ran: true, exit: true };
    }
  }

  // 指定评论出图：评论 ID + 是否同时出 UP 互动回顾图
  if (manual) {
    const rpidAns = await askValidated('评论链接或 ID（分享链接会自动提取评论 ID）', cfg.rpid || '', validateRpidInput);
    if (rpidAns === CANCEL) return cancel();
    cfg.rpid = extractId(rpidAns);
    const ctxAns = await selectYN('同时生成 UP 互动回顾图（该评论下的 UP 回复/点赞）', cfg.context);
    if (ctxAns === CANCEL) return cancel();
    cfg.context = Boolean(ctxAns);
  }

  // 全账号热评检索限额（--max-dyns，仅登录 + 不填动态时）
  if (hot && cap.autoIdentify && !cfg.oid) {
    const mdAns = await askValidated(
      '全账号检索最多处理动态数（留空不限制）',
      Number.isFinite(cfg.maxDyns) ? String(cfg.maxDyns) : '',
      v => { const s = String(v || '').trim(); return (!s || (/^\d+$/.test(s) && parseInt(s, 10) >= 1)) ? null : '请输入 ≥1 的整数，或留空不限制'; });
    if (mdAns === CANCEL) return cancel();
    cfg.maxDyns = String(mdAns).trim() ? parseInt(mdAns, 10) : Infinity;
  }

  // —— 监控行为（仅置顶监测模式；热评/指定评论为一次性出图，无需间隔/动态监测） ——
  if (!hot && !manual) {
    section('监控行为');
    if (!cfg.once) {
      const iv = await askValidated('检查间隔（秒）', String(cfg.interval), validateIntervalInput);
      if (iv === CANCEL) return cancel();
      cfg.interval = parseInt(iv, 10);
    }
    const dynAns = await selectYN('同时监测普通动态更新（置顶未变但发了新动态时提示并出图）', cfg.trackDyn);
    if (dynAns === CANCEL) return cancel();
    cfg.trackDyn = Boolean(dynAns);
  }

  // —— 卡片与输出 ——
  section(hot || manual ? '输出设置' : '卡片与输出');
  if (!hot && (!manual || !cfg.context)) {
    const srAns = await selectYN('卡片上绘制精彩回复', cfg.showReplies);
    if (srAns === CANCEL) return cancel();
    cfg.showReplies = Boolean(srAns);
  }
  if (!manual) {
    const fAns = await selectYN('强制重新出图（忽略已出图状态）', cfg.force);
    if (fAns === CANCEL) return cancel();
    cfg.force = Boolean(fAns);
  }
  const emojiAns = await selectYN('彩色 emoji（Twemoji 内联图）', emoji.emojiEnabled());
  if (emojiAns === CANCEL) return cancel();
  emoji.setEnabled(Boolean(emojiAns));
  // 输出分辨率：预设倍率 / 自定义宽度（宽度换算为倍率保存）
  const presetIdx = [1, 2, 3].indexOf(cfg.scale);
  const resAns = await select([
    { key: '1', label: '1x（680px）', desc: '小图分享' },
    { key: '2', label: '2x（1360px）', desc: '默认高清（推荐）' },
    { key: '3', label: '3x（2040px）', desc: '超清' },
    { key: 'x', label: '自定义宽度', desc: `当前 ${Math.round(CARD_W * cfg.scale)}px（340-4080）` },
  ], presetIdx >= 0 ? presetIdx : 3);
  if (resAns === CANCEL) return cancel();
  if (resAns === 'x') {
    const wAns = await askValidated('输出宽度（像素，340-4080）', String(Math.round(CARD_W * cfg.scale)), validateWidthInput);
    if (wAns === CANCEL) return cancel();
    cfg.scale = parseInt(wAns, 10) / CARD_W;
  } else {
    cfg.scale = parseInt(String(resAns), 10); // 1/2/3 预设倍率（CANCEL 已在上方返回）
  }
  const outAns = await ask('输出目录', cfg.outDir);
  if (outAns === CANCEL) return cancel();
  if (outAns) cfg.outDir = expandHome(outAns);
  const nameAns = await ask('卡片标题显示名（留空自动取 UP 名）', cfg.upName || '');
  if (nameAns === CANCEL) return cancel();
  if (nameAns) cfg.upName = nameAns;

  // 保存配置（Cookie 也保存，下次免输；注意保管本机安全）
  // outDir 仅在用户自定义时持久化；保持默认则每次运行时重新解析为「当前项目目录/output」
  const outCustom = cfg.outDir !== DEFAULT_OUT_DIR;
  saveConfig({
    uid: uidForSave, oid: cfg.oid, type: cfg.type, cookie: cfg.cookie,
    upName: cfg.upName, showReplies: cfg.showReplies,
    interval: cfg.interval, outDir: outCustom ? cfg.outDir : '', outDirCustom: outCustom,
    trackDyn: cfg.trackDyn,
    scale: cfg.scale,
  });
  teardown();

  // —— 配置汇总 ——
  const cookieUid = String(cfg.cookie || '').match(/DedeUserID=(\d+)/)?.[1];
  console.log(`\n${C.pink('┌─ ')}${C.bold('配置完成')}${C.pink(` ${'─'.repeat(Math.max(2, 44 - displayWidth('配置完成') - 4))}┐`)}`);
  summaryRow('目标', cfg.oid ? `动态 ${cfg.oid}` : `UID ${cfg.uid}`);
  summaryRow('登录', cookieUid ? `UID ${cookieUid}（已登录）` : '游客（仅指定动态）');
  if (!cookieUid) summaryRow('限制', '无 UID 自动识别 · 无全账号热评 · 子回复仅第一页');
  summaryRow('模式', hot
    ? `UP 热评 TOP 卡 · 高赞区 ${cfg.upTop} 条/卡`
    : (manual
      ? `指定评论出图${cfg.context ? ' · UP互动回顾' : ''}`
      : (cfg.once ? '单次检查' : `持续监控 · 每 ${cfg.interval}s`)));
  if (manual) summaryRow('评论', cfg.rpid);
  if (!manual && cfg.force) summaryRow('重出', '强制忽略已出图状态');
  if (!hot && !manual && cfg.trackDyn) summaryRow('监测', '普通动态更新已开启');
  if (!hot && cfg.showReplies) summaryRow('卡片', '含精彩回复');
  if (!emoji.emojiEnabled()) summaryRow('emoji', '已关闭彩色化（回退文本）');
  summaryRow('分辨率', `${Math.round(CARD_W * cfg.scale)}px（${cfg.scale}x）`);
  summaryRow('输出', cfg.outDir);
  console.log(`\n${C.green('✔')} 开始运行，Ctrl+C 随时退出\n`);
  return { ran: true };
}

module.exports = { qrLogin, runInteractive, expandHome, validateUidInput, validateIntervalInput, validateTopNInput, validateWidthInput, validateCookieInput, validateRpidInput, loginCapabilities };
