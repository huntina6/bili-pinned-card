'use strict';
/**
 * CLI 参数解析与静态配置构建（从 cli.js 拆出，纯函数便于测试）
 * 依赖：lib/ui（颜色）/ lib/state（默认 UID），不依赖网络与交互
 */
const path = require('path');
const { C } = require('./ui');
const { DEFAULT_UID } = require('./state');
const { W: CARD_W } = require('./card/constants');
const { parseRule } = require('./rule');
const { NOTIFY_EVENTS, FORMATS } = require('./notify');

// 项目目录（lib/args.js 的上一级）；默认输出固定为 <项目>/output，与运行时 cwd 无关
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'output');
// 渲染倍率范围（0.5x=340px ~ 6x=4080px；支持自定义宽度换算）
const MIN_SCALE = 0.5;
const MAX_SCALE = 6;

/**
 * 解析渲染倍率：--width <像素>（优先）> --scale <倍率> > 已保存 > 默认 2
 * @param {{scale?: number|null, width?: number|null}} args
 * @param {{scale?: number}} [saved]
 * @returns {number}
 */
function resolveScale(args, saved = {}) {
  if (args.width != null) return args.width / CARD_W;
  if (args.scale != null) return args.scale;
  const s = Number(saved.scale);
  return Number.isFinite(s) && s >= MIN_SCALE && s <= MAX_SCALE ? s : 2;
}

/**
 * 解析输出目录：显式 --out > 自定义保存值 > 项目目录/output
 * 旧配置兼容：历史默认值形如 <任意目录>/output 且未标记 outDirCustom 时，跟随当前项目目录
 * @param {{out?: string|null}} args
 * @param {{outDir?: string, outDirCustom?: boolean}} [saved]
 * @returns {string}
 */
function resolveOutDir(args, saved = {}) {
  if (args.out) return args.out;
  const s = saved.outDir ? String(saved.outDir) : '';
  if (!s) return DEFAULT_OUT_DIR;
  if (saved.outDirCustom === true) return s;
  if (path.basename(path.resolve(s)).toLowerCase() === 'output') return DEFAULT_OUT_DIR;
  return s;
}

// ====== 参数写法表：中文名（帮助里首选）/ 英文名 / 旧参数名 三种写法完全等价 ======
// 设计依据（cli-guidelines / clig.dev 中文版）：人类优先、示例先行、优先使用标准标志名、
// 以「不破坏既有接口」的方式演进。旧写法永久保留，只是不再作为帮助里的首选展示。
const FLAG_ALIASES = {
  // 目标
  '--动态': '--oid', '--dynamic': '--oid', '--oid': '--oid', '-d': '--oid',
  '--评论': '--rpid', '--comment': '--rpid', '--rpid': '--rpid',
  '--up': '--uid', '--up主': '--uid', '--uid': '--uid', '-u': '--uid',
  '--类型': '--type', '--type': '--type', '-t': '--type',
  // 模式与节奏
  '--监控': '--watch', '--watch': '--watch',
  '--单次': '--once', '--once': '--once',
  '--热评': '--up-top', '--条数': '--up-top', '--top': '--up-top', '--up-top': '--up-top',
  '--动态上限': '--max-dyns', '--limit': '--max-dyns', '--max-dyns': '--max-dyns',
  '--确认': '--yes', '--yes': '--yes',
  '--间隔': '--interval', '--every': '--interval', '--interval': '--interval', '-i': '--interval',
  '--回顾': '--context', '--context': '--context',
  '--追踪动态': '--track-dyn', '--track-dynamic': '--track-dyn', '--track-dyn': '--track-dyn',
  '--强制': '--force', '--force': '--force',
  '--回复': '--show-replies', '--replies': '--show-replies', '--show-replies': '--show-replies', '-r': '--show-replies',
  // 卡片与输出
  '--输出': '--out', '--output': '--out', '--out': '--out', '-o': '--out',
  '--倍率': '--scale', '--scale': '--scale',
  '--宽度': '--width', '--width': '--width',
  '--无表情': '--no-emoji', '--no-emoji': '--no-emoji',
  '--标题': '--up-name', '--up-name': '--up-name',
  // 规则与推送
  '--规则': '--rule', '--rule': '--rule',
  '--规则模式': '--rule-mode', '--rule-mode': '--rule-mode',
  '--推送': '--notify-webhook', '--webhook': '--notify-webhook', '--notify-webhook': '--notify-webhook',
  '--推送格式': '--notify-format', '--notify-format': '--notify-format',
  '--推送事件': '--notify-events', '--notify-events': '--notify-events',
  '--推送群': '--notify-chat-id', '--notify-chat-id': '--notify-chat-id',
  '--推送前缀': '--notify-prefix', '--notify-prefix': '--notify-prefix',
  // 登录与运行
  '--cookie': '--cookie', '--sessdata': '--cookie', '-c': '--cookie',
  '--登录': '--login', '--login': '--login',
  '--向导': '--interactive', '--interactive': '--interactive', '-I': '--interactive',
  '--免向导': '--no-input', '--no-input': '--no-input',
  '--静音': '--quiet', '--quiet': '--quiet', '-q': '--quiet',
  '--详细': '--verbose', '--verbose': '--verbose', '-v': '--verbose',
  '--版本': '--version', '--version': '--version', '-V': '--version',
  '--帮助': '--help', '--help': '--help', '-h': '--help',
  // 机器可读（AI / 脚本）
  '--json': '--json', '--机器可读': '--json', '-j': '--json',
  '--演练': '--dry-run', '--dry-run': '--dry-run', '--预演': '--dry-run',
  '--能力': '--caps', '--caps': '--caps',
};

/** 动作词（第一个非选项参数）→ 规范动作；把「一句话命令」翻成参数组合 */
const ACTIONS = {
  '登录': 'login', login: 'login',
  '查看': 'view', view: 'view',
  '监控': 'watch', watch: 'watch',
  '热评': 'hot', top: 'hot',
  '出图': 'card', card: 'card',
  '回顾': 'context', context: 'context',
  '帮助': 'help', help: 'help',
  '能力': 'caps', caps: 'caps', capabilities: 'caps',
};

/** 归一化选项名：长选项 ASCII 部分大小写不敏感（--UP == --up），再查别名表 */
function canonFlag(arg) {
  if (!arg.startsWith('-')) return arg;
  if (arg.startsWith('--')) {
    const lower = '--' + arg.slice(2).toLowerCase();
    return FLAG_ALIASES[lower] || FLAG_ALIASES[arg] || lower;
  }
  return FLAG_ALIASES[arg] || arg; // 单字母短选项区分大小写（-i 间隔 / -I 向导）
}

/** UP 空间链接 → UID 数字串；不是空间链接则原样返回（交由调用方校验并给出提示） */
function extractUid(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/space\.bilibili\.com\/(\d+)/i);
  return m ? m[1] : s;
}

/** 动作词的目标：UP 空间链接 → uid，其余（动态/评论链接、裸 ID）→ 评论对象 oid */
function assignTarget(a, target) {
  if (!target) return;
  if (/space\.bilibili\.com\/\d+/i.test(target)) {
    if (!a.uid) a.uid = extractUid(target);
    return;
  }
  if (!a.oid) a.oid = target;
}

/**
 * 应用动作词（在全部参数扫描完成后执行 → 动作词与参数顺序无关）
 * 语义：动作词只是「说人话」的语法糖，显式参数优先于动作词的默认值。
 * 例：node cli.js 监控 <链接> 60  ==  --watch --oid <链接> --interval 60
 * @param {any} a parseArgs 中间态
 * @returns {any} 同一个对象
 */
function applyAction(a) {
  const positionals = a._positionals || [];
  const act = a._action;
  if (!act) {
    // 兼容历史用法：裸参数即动态 ID/链接
    if (positionals.length && !a.oid) a.oid = positionals[0];
    return a;
  }
  const target = positionals[0] || '';
  const isLink = /^(https?:\/\/|\/\/)/i.test(target) || /bilibili\.com/i.test(target);
  // 第二个纯数字位置参数：动作词的数量参数（监控=间隔秒数 / 热评=高赞区条数）
  const extra = positionals.slice(1);
  const numArg = extra.length && /^\d+$/.test(extra[0]) ? parseInt(extra[0], 10) : null;
  let consumed = target ? 1 : 0;
  switch (act) {
    case 'login': a.login = true; break;
    case 'help': a.help = true; break;
    case 'caps': a.caps = true; break;
    case 'view':
      if (target && !a.oid) a.oid = target;
      if (!a._onceExplicit) a.once = true;
      break;
    case 'watch':
      assignTarget(a, target);
      if (numArg && a.interval == null) { a.interval = numArg; consumed = 2; }
      if (!a._onceExplicit) a.once = false;
      break;
    case 'hot':
      assignTarget(a, target);
      if (a.upTop == null) {
        if (numArg) { a.upTop = numArg; consumed = 2; } else { a.upTopBare = true; } // 不带 N：沿用上次条数（缺省 10）
      }
      if (!a._onceExplicit) a.once = true; // 热评是「跑一遍就完」的批任务
      break;
    case 'card':
    case 'context':
      if (target && !a.rpid) a.rpid = target;
      // 评论分享链接里同时含「评论 ID」与所属动态，可一次填好两个目标
      if (isLink && target && !a.oid) a.oid = target;
      if (act === 'context') a.context = true;
      if (!a._onceExplicit) a.once = true;
      break;
    default: break;
  }
  // 动作词缺目标：给简洁帮助，而不是去猜默认账号
  const needTarget = (act === 'card' || act === 'context') ? !(a.rpid || a.oid)
    : (act === 'view' || act === 'watch' || act === 'hot') ? !(a.oid || a.uid) : false;
  if (needTarget) a.shortHelp = true;
  // 未被消费的多余参数：明确提示，不静默吞掉用户输入
  const ignored = positionals.slice(consumed);
  if (ignored.length) console.error(C.yellow('⚠ 已忽略多余参数: ' + ignored.join(' ')));
  return a;
}

/** 读取带值参数的值；缺失时输出错误并退出 */
function argValue(argv, i, name) {
  const v = argv[i + 1];
  if (v === undefined) {
    console.error(C.red('参数 ' + name + ' 缺少值'));
    console.error(C.dim('运行 node cli.js --帮助 查看用法，或直接 node cli.js 进配置向导'));
    process.exit(1);
  }
  return v;
}

/**
 * 解析命令行参数（中文名 / 英文名 / 旧参数名三种写法等价；支持中文动作词）
 * @param {string[]} argv
 * @returns {any}
 */
function parseArgs(argv) {
  const a = {
    uid: null, oid: null, rpid: null, type: null, interval: null, out: null,
    once: false, force: false, showReplies: null, cookie: null,
    upName: null, quiet: false, trackDyn: null, context: false, help: false,
    upTop: null, upTopBare: false, maxDyns: null, yes: false, login: false, verbose: false,
    version: false, noInput: false, interactive: false, scale: null, noEmoji: false, width: null,
    rules: null, ruleMode: null, notifyWebhook: null, notifyFormat: null,
    notifyEvents: null, notifyChatId: null, notifyPrefix: null,
    json: false,          // 机器可读输出（NDJSON）
    dryRun: false,        // 只解析与报告，不渲染、不写 state
    caps: false,          // 输出能力清单
    shortHelp: false,     // 动作词缺目标 → 打印简洁帮助
    _action: null,        // 动作词（内部态）
    _positionals: [],     // 非选项参数（内部态）
    _onceExplicit: false, // 是否显式给过 --监控/--单次（决定动作词能否改 once）
  };
  const set = (k, v) => { a[k] = v; };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const arg = canonFlag(raw); // 别名归一化：中文名/英文名/旧名 → 规范名
    switch (arg) {
      case '--uid': set('uid', extractUid(argValue(argv, i, raw))); i++; break;
      case '--oid': set('oid', argValue(argv, i, raw)); i++; break;
      case '--rpid': set('rpid', argValue(argv, i, raw)); i++; break;
      case '--type': set('type', argValue(argv, i, raw)); i++; break;
      case '--interval': set('interval', argValue(argv, i, raw)); i++; break;
      case '--out': set('out', argValue(argv, i, raw)); i++; break;
      case '--cookie': set('cookie', argValue(argv, i, raw)); i++; break;
      case '--up-name': set('upName', argValue(argv, i, raw)); i++; break;
      case '--up-top': {
        // 可选数字参数：下一位为纯数字则作为 TOP N，否则沿用上次向导条数（缺省 10）
        const next = argv[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) { set('upTop', parseInt(next, 10)); i++; }
        else { set('upTop', null); set('upTopBare', true); }
        break;
      }
      case '--max-dyns': {
        const n = parseInt(argValue(argv, i, raw), 10);
        set('maxDyns', Number.isFinite(n) && n > 0 ? n : null); // 非法值回退默认（不限制）
        i++;
        break;
      }
      case '--yes': set('yes', true); break;
      case '--scale': {
        const n = parseFloat(argValue(argv, i, raw));
        // 支持小数倍率（如 1.5），范围 0.5~6；非法值回退默认 2x
        set('scale', Number.isFinite(n) && n >= MIN_SCALE && n <= MAX_SCALE ? n : null);
        i++;
        break;
      }
      case '--width': {
        const n = parseInt(argValue(argv, i, raw), 10);
        // 自定义输出宽度（像素），范围 340~4080（=0.5x~6x）；优先于 --倍率
        set('width', Number.isInteger(n) && n >= CARD_W * MIN_SCALE && n <= CARD_W * MAX_SCALE ? n : null);
        i++;
        break;
      }
      case '--rule': {
        // 可重复：--规则 抽奖 --规则 /置顶|通知/i；正则非法立即报错（避免运行期静默失效）
        const v = argValue(argv, i, raw);
        try { parseRule(v); } catch (e) { console.error(C.red('规则非法: ' + e.message)); process.exit(1); }
        a.rules = (a.rules || []).concat(v);
        i++;
        break;
      }
      case '--rule-mode': {
        const v = String(argValue(argv, i, raw)).toLowerCase();
        if (v !== 'any' && v !== 'all') { console.error(C.red('--规则模式 仅支持 any / all，收到: ' + v)); process.exit(1); }
        set('ruleMode', v);
        i++;
        break;
      }
      case '--notify-webhook': set('notifyWebhook', argValue(argv, i, raw)); i++; break;
      case '--notify-format': {
        const v = String(argValue(argv, i, raw)).toLowerCase();
        if (!FORMATS.includes(v)) { console.error(C.red('--推送格式 仅支持 ' + FORMATS.join(' / ') + '，收到: ' + v)); process.exit(1); }
        set('notifyFormat', v);
        i++;
        break;
      }
      case '--notify-events': {
        const list = String(argValue(argv, i, raw)).split(',').map(s => s.trim()).filter(Boolean);
        // 未知事件名直接报错，避免用户以为已订阅实际静默丢弃
        const bad = list.filter(e => !NOTIFY_EVENTS.includes(e));
        if (bad.length) { console.error(C.red('--推送事件 含未知事件: ' + bad.join(', ') + '（可选: ' + NOTIFY_EVENTS.join(', ') + '）')); process.exit(1); }
        // 显式传空串 = 不订阅任何事件；完全不传该参数才是「全订阅」
        set('notifyEvents', list.length ? list : []);
        i++;
        break;
      }
      case '--notify-chat-id': set('notifyChatId', argValue(argv, i, raw)); i++; break;
      case '--notify-prefix': set('notifyPrefix', argValue(argv, i, raw)); i++; break;
      case '--no-emoji': set('noEmoji', true); break;
      case '--track-dyn': set('trackDyn', true); break;
      case '--no-track-dyn': set('trackDyn', false); break;
      case '--context': set('context', true); break;
      case '--once': set('once', true); a._onceExplicit = true; break;
      case '--watch': set('once', false); a._onceExplicit = true; break;
      case '--force': set('force', true); break;
      case '--login': set('login', true); break;
      case '--no-input': set('noInput', true); break;
      case '--interactive': set('interactive', true); break;
      case '--show-replies': set('showReplies', true); break;
      case '--no-replies': set('showReplies', false); break;
      case '--quiet': set('quiet', true); break;
      case '--verbose': set('verbose', true); break;
      case '--version': set('version', true); break;
      case '--help': set('help', true); break;
      case '--json': set('json', true); break;
      case '--dry-run': set('dryRun', true); break;
      case '--caps': set('caps', true); break;
      default:
        // 单独的 - 表示「目标从标准输入读」（管道/AI 调用），不是选项
        if (arg !== '-' && arg.startsWith('-')) {
          // 未知选项直接报错（历史实现会把 -x 当成裸 oid 静默吞掉）
          console.error(C.red('未知参数: ' + raw));
          console.error(C.dim('运行 node cli.js --帮助 查看全部参数'));
          process.exit(1);
        }
        if (!a._action && ACTIONS[arg]) a._action = ACTIONS[arg];
        else if (!a._action && ACTIONS[arg.toLowerCase()]) a._action = ACTIONS[arg.toLowerCase()];
        else a._positionals.push(arg);
    }
  }
  return applyAction(a);
}

/**
 * 归一化规则列表：命令行优先于已保存配置；非法正则丢弃并告警（不因配置脏值中断运行）
 * @param {string[]|string|null|undefined} fromArgs
 * @param {string[]|string|null|undefined} fromSaved
 * @returns {string[]}
 */
function normalizeRules(fromArgs, fromSaved) {
  const src = fromArgs != null ? fromArgs : fromSaved;
  const arr = Array.isArray(src) ? src : (src ? [src] : []);
  const out = [];
  for (const raw of arr) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    try { parseRule(text); } catch (e) { console.error(C.red(`忽略非法规则（${text}）: ${e.message}`)); continue; }
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * 归一化 oid：全 0 视为未设置。
 * 必要性：B站 对无效动态 ID 返回全 0 空壳，一旦 oid=0 落盘，下次向导会预填 "[0]"，
 * 一路跑到评论接口只报 -400，用户无法从错误看出真实原因；清理后回到「留空自动识别」语义。
 * 链接/正常 ID 原样保留，交由 resolveCommentOid 转换。
 * @param {string} v
 * @returns {string}
 */
function sanitizeOid(v) {
  const s = String(v ?? '').trim();
  return /^0+$/.test(s) ? '' : s;
}

/** 合并命令行与已保存配置，生成运行前静态配置；up-top 是一次性模式，未显式开启时默认关闭 */
function buildConfig(args, saved = {}) {
  // uid 兜底 DEFAULT_UID 只为「未指定 --oid 时匿名自动识别置顶动态」提供默认账号，
  // 它不代表用户指定的 UP 身份，故用 uidDefaulted 单独标记：
  // monitor 的身份解析据此避免把默认账号当成真实 UP，压掉接口识别出的 mid
  // （曾导致 --oid + --up-top 静默 0 张卡、UP主徽标漏、互动回顾图筛错人）
  const explicitUid = String(args.uid || saved.uid || '');
  return {
    uid: explicitUid || DEFAULT_UID,
    uidExplicit: !!args.uid,
    uidDefaulted: !explicitUid,
    oid: sanitizeOid(args.oid ? String(args.oid) : (saved.oid || '')),
    rpid: args.rpid ? String(args.rpid) : (saved.rpid || ''),
    type: args.type != null ? parseInt(args.type, 10) : (saved.type || 11),
    cookie: args.cookie != null ? args.cookie : (saved.cookie || ''),
    upName: args.upName || saved.upName || '',
    showReplies: args.showReplies != null ? args.showReplies : (saved.showReplies ?? false),
    interval: args.interval != null ? parseInt(args.interval, 10) : (saved.interval || 60),
    outDir: resolveOutDir(args, saved),
    once: args.once,
    force: args.force,
    context: args.context,
    // --up-top 不带 N 时沿用上次向导记下的条数（lastUpTop），缺省 10
    upTop: args.upTop != null ? args.upTop
      : (args.upTopBare ? (saved.lastUpTop > 0 ? saved.lastUpTop : 10) : (saved.upTop ?? 0)),
    // maxDyns 同样支持沿用上次向导设定（lastMaxDyns）；缺失即不限制
    maxDyns: args.maxDyns != null ? args.maxDyns
      : (saved.lastMaxDyns > 0 ? saved.lastMaxDyns : (saved.maxDyns ?? Infinity)),
    scale: resolveScale(args, saved),
    yes: !!args.yes,
    trackDyn: args.trackDyn != null ? args.trackDyn : (saved.trackDyn ?? false),
    quiet: args.quiet,
    rules: normalizeRules(args.rules, saved.rules),
    ruleMode: args.ruleMode || (saved.ruleMode === 'all' ? 'all' : 'any'),
    notifyWebhook: args.notifyWebhook != null ? args.notifyWebhook : (saved.notifyWebhook || ''),
    notifyFormat: args.notifyFormat || (FORMATS.includes(saved.notifyFormat) ? saved.notifyFormat : 'generic'),
    // 语义：未指定（null）= 运行期全订阅；显式空数组 = 不订阅任何事件（向导「全不选」）
    notifyEvents: args.notifyEvents != null ? args.notifyEvents
      : (Array.isArray(saved.notifyEvents) ? saved.notifyEvents : null),
    notifyChatId: args.notifyChatId != null ? args.notifyChatId : (saved.notifyChatId || ''),
    notifyPrefix: args.notifyPrefix != null ? args.notifyPrefix : (saved.notifyPrefix || ''),
    // emoji 开关：--no-emoji 优先于向导保存值
    emoji: args.noEmoji ? false : (saved.emoji !== false),
    // 机器可读与演练（一次性运行参数，不落盘）
    json: !!args.json,
    dryRun: !!args.dryRun,
  };
}

/** 是否纯数字 UID（拼入 API URL 需要；脏值会产生无效请求且无提示） */
function isNumericUid(v) {
  return /^\d+$/.test(String(v));
}

/** 帮助文本（内容在 lib/help.js：HELP 完整说明书 / SHORT_HELP 简洁帮助） */
const { HELP, SHORT_HELP } = require('./help');

module.exports = {
  argValue,
  parseArgs,
  buildConfig,
  normalizeRules,
  sanitizeOid,
  isNumericUid,
  extractUid,
  applyAction,
  FLAG_ALIASES,
  ACTIONS,
  HELP,
  SHORT_HELP,
  PROJECT_ROOT,
  DEFAULT_OUT_DIR,
  resolveOutDir,
  resolveScale,
  MIN_SCALE,
  MAX_SCALE,
};
