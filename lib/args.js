'use strict';
/**
 * CLI 参数解析与静态配置构建（从 cli.js 拆出，纯函数便于测试）
 * 依赖：lib/ui（颜色）/ lib/state（默认 UID），不依赖网络与交互
 */
const path = require('path');
const { C } = require('./ui');
const { DEFAULT_UID } = require('./state');

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
    upTop: null, maxDyns: null, yes: false, login: false, verbose: false,
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
      case '--login': set('login', true); break;
      case '--show-replies': case '-r': set('showReplies', true); break;
      case '--no-replies': set('showReplies', false); break;
      case '--quiet': case '-q': set('quiet', true); break;
      case '--verbose': case '-v': set('verbose', true); break;
      case '--help': case '-h': set('help', true); break;
      default:
        if (arg.startsWith('--')) { console.error(C.red(`未知参数: ${arg}`)); process.exit(1); }
        if (!a.oid) set('oid', arg); // 裸参数视为动态 ID
    }
  }
  return a;
}

/** 合并命令行与已保存配置，生成运行前静态配置；up-top 是一次性模式，未显式开启时默认关闭 */
function buildConfig(args, saved = {}) {
  return {
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
    upTop: args.upTop != null ? args.upTop : (saved.upTop ?? 0),
    maxDyns: args.maxDyns != null ? args.maxDyns : (saved.maxDyns ?? Infinity),
    yes: !!args.yes,
    trackDyn: args.trackDyn != null ? args.trackDyn : (saved.trackDyn ?? false),
    quiet: args.quiet,
  };
}

/** 是否纯数字 UID（拼入 API URL 需要；脏值会产生无效请求且无提示） */
function isNumericUid(v) {
  return /^\d+$/.test(String(v));
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
  --login                扫码登录：终端显示二维码，手机 B站 App 扫码后自动保存 Cookie
  --cookie <SESSDATA>    登录 Cookie（可选）：解锁自动识别置顶动态，降低风控
  --watch                持续监控（默认）
  --once                 单次检查并出图后退出
  --force                即使置顶评论未变化也重新出图
  -r, --show-replies     卡片上绘制精彩回复（默认不画）
  --track-dyn            同时监测普通动态更新：置顶未变但发了新动态时提示并出图
  -i, --interval <秒>    监控间隔（默认 60，最短 10）
  -o, --out <目录>       输出目录（默认 ./output）
  -q, --quiet            安静模式（仅输出结果行）
  -v, --verbose          详细日志：debug 级写入文件（每次 API 请求摘要/耗时），排障用
  -h, --help             帮助

  日志: 运行详情自动落盘 ~/.bili-pinned-card/logs/YYYY-MM-DD.log（保留 30 天）
        Cookie/凭据不入日志；debug 级请求摘要需加 -v

示例:
  node cli.js --login                              # 扫码登录，自动保存 Cookie（推荐首次使用）
  node cli.js --oid 404135596 --once --force
  node cli.js --oid 404135596 --rpid 313406396048 --once   # 绘制指定评论（旧置顶等）
  node cli.js --oid 404135596 --rpid 313406396048 --context --once   # 该评论的 UP 互动回顾图
  node cli.js --oid 404135596 --up-top --once              # UP 热评 TOP 卡（单动态）
  node cli.js --uid 401315430 --cookie "SESSDATA=xxx; bili_jct=yyy" --up-top --once   # 全账号动态自动检索出卡
  node cli.js --uid 401315430 --cookie "SESSDATA=xxx; bili_jct=yyy" --watch -i 120
`;

module.exports = {
  argValue,
  parseArgs,
  buildConfig,
  isNumericUid,
  HELP,
};
