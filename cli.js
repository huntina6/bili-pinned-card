#!/usr/bin/env node
'use strict';
/**
 * bili-pinned-card v1.2.3 —— B站置顶评论监测 + 自动出图
 * 全平台独立版：无需浏览器、无需登录（匿名可读评论；提供 SESSDATA 可自动识别置顶动态）
 *
 * 用法：
 *   node cli.js                       # 交互模式（终端提示引导）
 *   node cli.js --oid 404135596       # 直接指定动态 ID，单次检查出图
 *   node cli.js --uid 401315430 --watch --interval 60
 *   node cli.js --help
 *
 * 模块结构：lib/ui（终端交互）/ lib/state（配置持久化）/ lib/monitor（核心检查）/ lib/api（B站 API）/ lib/card（卡片渲染）
 */

const path = require('path');
const readline = require('readline');
const ui = require('./lib/ui');
const { C, log, makeBanner, attach, ask, section, select, selectYN, summaryRow, displayWidth } = ui;
const { extractId, resolveCommentOid, BiliError } = require('./lib/api');
const { checkOnce } = require('./lib/monitor');
const { loadConfig, saveConfig, DEFAULT_UID } = require('./lib/state');

const VERSION = '1.2.4';
const BANNER = makeBanner(VERSION);

// ====== 参数解析 ======
/** 读取带值参数的值；缺失时输出错误并退出 */
function argValue(argv, i, name) {
  const v = argv[i + 1];
  if (v === undefined) {
    console.error(C.red(`参数 ${name} 缺少值，用法见 --help`));
    process.exit(1);
  }
  return v;
}
function parseArgs(argv) {
  const a = {
    uid: null, oid: null, rpid: null, type: null, interval: null, out: null,
    once: false, force: false, showReplies: null, cookie: null,
    upName: null, quiet: false, trackDyn: null, context: false, help: false,
    upTop: null, maxDyns: null, yes: false,
  };
  const set = (k, v) => { a[k] = v; };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--uid': case '-u': set('uid', argValue(argv, i, arg)); i++; break;
      case '--oid': set('oid', argValue(argv, i, arg)); i++; break;
      case '--rpid': set('rpid', argValue(argv, i, arg)); i++; break;
      case '--type': case '-t': set('type', argValue(argv, i, arg)); i++; break;
      case '--interval': case '-i': set('interval', argValue(argv, i, arg)); i++; break;
      case '--out': case '-o': set('out', argValue(argv, i, arg)); i++; break;
      case '--cookie': case '-c': set('cookie', argValue(argv, i, arg)); i++; break;
      case '--up-name': set('upName', argValue(argv, i, arg)); i++; break;
      case '--up-top': {
        // 可选数字参数：下一位为纯数字则作为 TOP N，否则默认 10
        const next = argv[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) { set('upTop', parseInt(next, 10)); i++; }
        else set('upTop', 10);
        break;
      }
      case '--max-dyns': set('maxDyns', parseInt(argValue(argv, i, arg), 10)); i++; break;
      case '--yes': set('yes', true); break;
      case '--track-dyn': set('trackDyn', true); break;
      case '--no-track-dyn': set('trackDyn', false); break;
      case '--context': set('context', true); break;
      case '--once': set('once', true); break;
      case '--watch': set('once', false); break;
      case '--force': set('force', true); break;
      case '--show-replies': case '-r': set('showReplies', true); break;
      case '--no-replies': set('showReplies', false); break;
      case '--quiet': case '-q': set('quiet', true); break;
      case '--help': case '-h': set('help', true); break;
      default:
        if (arg.startsWith('--')) { console.error(C.red(`未知参数: ${arg}`)); process.exit(1); }
        if (!a.oid) set('oid', arg); // 裸参数视为动态 ID
    }
  }
  return a;
}

const HELP = `
用法: node cli.js [选项]

  （无参数）             交互模式：终端提示引导配置后持续监控
  --oid <动态ID或链接>    直接指定动态（含其置顶评论），跳过自动识别
  --rpid <评论ID或链接>   直接绘制指定评论的卡片（如旧的置顶评论，需配合 --oid）
  --context              与 --rpid 联用：绘制该评论的 UP 互动回顾图（UP 回复/点赞对话链）
  --up-top [N]            UP 热评 TOP 卡（默认 N=10）：配合 --oid 处理单条动态；
                          配合 --uid 自动检索该账号全部动态（先询问确认，--yes 跳过）
  --max-dyns <N>          模式 B（--uid + --up-top）最多处理的动态条数（默认不限制）
  --yes                   非交互模式下跳过模式 B 的确认询问
  --uid <UP主UID>         目标 UP 主（配合 Cookie 自动识别置顶动态）
  --cookie <SESSDATA>    登录 Cookie（可选）：解锁自动识别置顶动态，降低风控
  --watch                持续监控（默认）
  --once                 单次检查并出图后退出
  --force                即使置顶评论未变化也重新出图
  -r, --show-replies     卡片上绘制精彩回复（默认不画）
  --track-dyn            同时监测普通动态更新：置顶未变但发了新动态时提示并出图
  -i, --interval <秒>    监控间隔（默认 60，最短 10）
  -o, --out <目录>       输出目录（默认 ./output）
  -q, --quiet            安静模式（仅输出结果行）
  -h, --help             帮助

示例:
  node cli.js --oid 404135596 --once --force
  node cli.js --oid 404135596 --rpid 313406396048 --once   # 绘制指定评论（旧置顶等）
  node cli.js --oid 404135596 --rpid 313406396048 --context --once   # 该评论的 UP 互动回顾图
  node cli.js --oid 404135596 --up-top --once              # UP 热评 TOP 卡（单动态）
  node cli.js --uid 401315430 --cookie "SESSDATA=xxx; bili_jct=yyy" --up-top --once   # 全账号动态自动检索出卡
  node cli.js --uid 401315430 --cookie "SESSDATA=xxx; bili_jct=yyy" --watch -i 120
`;

// ====== 主流程 ======
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  const saved = loadConfig();
  const cfg = {
    uid: args.uid || saved.uid || DEFAULT_UID,
    uidExplicit: !!args.uid,
    oid: args.oid ? String(args.oid) : (saved.oid || ''),
    rpid: args.rpid ? String(args.rpid) : (saved.rpid || ''),
    type: args.type != null ? parseInt(args.type, 10) : (saved.type || 11),
    cookie: args.cookie != null ? args.cookie : (saved.cookie || ''),
    upName: args.upName || saved.upName || '',
    showReplies: args.showReplies != null ? args.showReplies : (saved.showReplies ?? false),
    interval: args.interval != null ? parseInt(args.interval, 10) : (saved.interval || 60),
    outDir: args.out || saved.outDir || path.join(process.cwd(), 'output'),
    once: args.once,
    force: args.force,
    context: args.context,
    upTop: args.upTop != null ? args.upTop : (saved.upTop ?? 10),
    maxDyns: args.maxDyns != null ? args.maxDyns : (saved.maxDyns ?? Infinity),
    yes: !!args.yes,
    trackDyn: args.trackDyn != null ? args.trackDyn : (saved.trackDyn ?? false),
    quiet: args.quiet,
  };
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
  if (args.uid && !/^\d+$/.test(String(args.uid))) {
    console.error(C.red(`--uid 必须是数字 UID，收到: ${args.uid}`));
    process.exit(1);
  }
  if (saved.uid && !/^\d+$/.test(String(saved.uid))) {
    console.error(C.red(`配置中的 uid 非法（${saved.uid}），请删除 ~/.bili-pinned-card/config.json 后重试`));
    process.exit(1);
  }

  // ---- 交互模式：终端提示引导 ----
  let bannerShown = false;
  if (process.stdin.isTTY && !args.oid && args.cookie == null) {
    console.log(BANNER);
    bannerShown = true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    attach(rl);

    // —— 模式选择（↑/↓ 移动光标，回车确认） ——
    section('运行模式');
    console.log(C.dim('  ↑/↓ 选择，回车确认'));
    const mode = await select([
      { key: '1', label: '持续监控', desc: '检测到置顶评论变化自动出图（默认）' },
      { key: '2', label: '单次检查', desc: '立即检查并出图一次' },
      { key: '0', label: '退出', desc: '' },
    ], 0);
    if (mode === '0') { console.log('\n再见 👋'); rl.close(); attach(null); return; }
    cfg.once = mode === '2';

    // —— 目标设置 ——
    section('目标设置');
    const uidAns = await ask('目标 UP 主 UID', cfg.uid);
    cfg.uid = uidAns || DEFAULT_UID;

    // Cookie 交互：已有保存的 Cookie 时明确提示（留空会沿用，输入 clear 清除回到匿名）
    const cookieAns = await ask(
      cfg.cookie
        ? `SESSDATA Cookie（已保存，回车沿用；输入 ${C.yellow('clear')} 清除后匿名）`
        : 'SESSDATA Cookie（可选，留空匿名；提供后可自动识别置顶动态）',
      '');
    if (cookieAns.trim().toLowerCase() === 'clear') {
      cfg.cookie = '';
      if (!cfg.quiet) log(C.dim('已清除已保存的 Cookie，本次以匿名运行'));
    } else if (cookieAns) cfg.cookie = cookieAns;

    const oidAns = await ask('动态链接或 ID（可选，留空则自动识别置顶动态；支持 Opus 链接）', cfg.oid || '');
    if (oidAns) {
      try {
        const r = await resolveCommentOid(oidAns, cfg.cookie);
        cfg.oid = r.oid;
        if (r.type != null) cfg.type = r.type;
      } catch (e) {
        console.log(C.red(`  ✗ 链接解析失败: ${e.message}，请检查后重试`));
      }
    }

    if (!cfg.oid && !cfg.cookie) {
      console.log(C.yellow('  ⚠ 未提供 Cookie 时自动识别置顶动态可能被风控（-352），届时程序会提示你补充。'));
    }

    // —— 监控行为 ——
    section('监控行为');
    if (!cfg.once) {
      const iv = await ask('检查间隔（秒）', String(cfg.interval));
      if (parseInt(iv, 10) >= 10) cfg.interval = parseInt(iv, 10);
    }
    cfg.trackDyn = await selectYN('同时监测普通动态更新（置顶未变但发了新动态时提示并出图）', cfg.trackDyn);

    // —— 卡片与输出 ——
    section('卡片与输出');
    cfg.showReplies = await selectYN('卡片上绘制精彩回复', cfg.showReplies);
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
    console.log(`\n${C.pink('┌─ ')}${C.bold('配置完成')}${C.pink(` ${'─'.repeat(Math.max(2, 44 - displayWidth('配置完成') - 4))}┐`)}`);
    summaryRow('目标', cfg.oid ? `动态 ${cfg.oid}` : `UID ${cfg.uid}${cfg.cookie ? '（已带 Cookie）' : '（匿名）'}`);
    summaryRow('模式', cfg.once ? '单次检查' : `持续监控 · 每 ${cfg.interval}s`);
    if (cfg.trackDyn) summaryRow('监测', '普通动态更新已开启');
    if (cfg.showReplies) summaryRow('卡片', '含精彩回复');
    summaryRow('输出', cfg.outDir);
    console.log(`\n${C.green('✔')} 开始运行，Ctrl+C 随时退出\n`);
  } else if (!cfg.oid && !cfg.cookie) {
    // 非交互且无 oid：尝试匿名自动识别（可能被风控）
    console.log(C.dim('未指定 --oid 且无 Cookie，尝试匿名自动识别置顶动态（可能被风控）...'));
  }

  if (!cfg.quiet && !bannerShown) {
    console.log(BANNER);
    log(`${C.bold('目标:')} ${cfg.oid ? '动态 ' + cfg.oid : 'UID ' + cfg.uid}${cfg.cookie ? ' ' + C.dim('(已带 Cookie)') : C.dim(' (匿名)')}`);
    log(`${C.bold('输出:')} ${cfg.outDir} · ${cfg.once ? '单次检查' : `每 ${cfg.interval}s 监控`}${cfg.force ? ' · 强制出图' : ''}${cfg.showReplies ? ' · 含精彩回复' : ''}`);
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
        if (err instanceof BiliError && (err.code === -352 || err.code === -412)) {
          console.log(C.red(`  ⚠ 风控 (${err.code})：${err.message}`));
          console.log(C.yellow(`  → 解决：提供 SESSDATA Cookie（--cookie "SESSDATA=xxx"）或直接指定动态 ID（--oid <动态ID>）`));
          if (cfg.once) { process.exitCode = 1; return; }
        } else {
          console.log(C.red(`  ✗ 检查失败: ${err.message || err}`));
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

main().catch(err => {
  console.error(C.red('致命错误: ' + (err?.message || err)));
  process.exit(1);
});
