'use strict';
/**
 * 能力清单（node cli.js 能力 / --能力）：给 AI 的「工具自描述」
 * 输出 JSON：动作词、全部参数写法（含旧名）、取值方式、通知事件、卡片产物、退出码、环境变量。
 * 目的：AI 不必解析中文帮助文本，直接读结构化 schema 决定怎么调用。
 */
const { FLAG_ALIASES, ACTIONS } = require('./args');
const { NOTIFY_EVENTS } = require('./notify');

/** 取值方式：value=必填值，optional=可选值，flag=开关 */
const ARITY = {
  '--oid': 'value', '--rpid': 'value', '--uid': 'value', '--type': 'value',
  '--interval': 'value', '--out': 'value', '--cookie': 'value', '--up-name': 'value',
  '--max-dyns': 'value', '--scale': 'value', '--width': 'value',
  '--rule': 'value', '--rule-mode': 'value',
  '--notify-webhook': 'value', '--notify-format': 'value', '--notify-events': 'value',
  '--notify-chat-id': 'value', '--notify-prefix': 'value',
  '--up-top': 'optional',
};

/** 一句话说明（英文键，供 AI 快速匹配意图；中文在 --帮助 里） */
const DESC = {
  '--oid': 'dynamic link or id (the dynamic whose pinned comment is watched)',
  '--rpid': 'comment link or id (render this comment instead)',
  '--uid': 'UP mid or space link (auto-detect the UP pinned dynamic)',
  '--type': 'comment area type, default 11 = dynamic',
  '--watch': 'keep monitoring (default)',
  '--once': 'single check then exit',
  '--up-top': 'UP hot-comment top cards; optional N = fan replies per card',
  '--max-dyns': 'max dynamics to scan in full-account mode',
  '--yes': 'skip the confirmation prompt in non-interactive runs',
  '--interval': 'poll interval seconds, default 60, min 10',
  '--context': 'with --rpid: render the UP interaction review instead of a card',
  '--track-dyn': 'also report normal dynamic updates',
  '--force': 'ignore state.json / existing files and re-render',
  '--show-replies': 'draw hot replies on the pinned card',
  '--out': 'output directory (default <project>/output)',
  '--scale': 'render scale 0.5-6, default 2',
  '--width': 'output width in px 340-4080, overrides --scale',
  '--no-emoji': 'disable colored emoji (fall back to text)',
  '--up-name': 'card title name (defaults to the UP name)',
  '--rule': 'content rule, repeatable: keyword or /regex/flags',
  '--rule-mode': 'any (default) | all',
  '--notify-webhook': 'webhook URL for event push (default off)',
  '--notify-format': 'generic | feishu | dingtalk | telegram',
  '--notify-events': 'subscribed events; omitted = all; empty string = none',
  '--notify-chat-id': 'telegram chat id',
  '--notify-prefix': 'title prefix for pushes',
  '--cookie': 'SESSDATA cookie string',
  '--login': 'QR login and save the cookie',
  '--interactive': 'force the interactive wizard',
  '--no-input': 'never enter the wizard',
  '--quiet': 'only print produced file paths',
  '--verbose': 'log every API request to the log file',
  '--version': 'print version',
  '--help': 'print the full manual',
  '--json': 'machine-readable NDJSON on stdout, human logs on stderr',
  '--dry-run': 'resolve targets and report the plan without rendering or writing state',
  '--caps': 'print this capability manifest as JSON',
  '--no-replies': 'disable hot replies (overrides saved config)',
  '--no-track-dyn': 'disable dynamic tracking (overrides saved config)',
};

/** 别名按规范名分组：{ '--oid': ['--oid','--动态','-d',...] } */
function aliasesByCanon() {
  const groups = {};
  for (const [name, canon] of Object.entries(FLAG_ALIASES)) {
    if (!groups[canon]) groups[canon] = [];
    groups[canon].push(name);
  }
  // 不在别名表里的开关（反向开关）补进来
  for (const extra of ['--no-replies', '--no-track-dyn']) {
    if (!groups[extra]) groups[extra] = [extra];
  }
  return groups;
}

/** 动作词的等价参数与目标语义 */
const ACTION_META = {
  login: { target: 'none', equivalent: ['--login'], desc: 'scan QR to log in and save cookie' },
  view: { target: 'dynamic', equivalent: ['--once', '--oid'], desc: 'render the pinned comment of one dynamic, then exit' },
  watch: { target: 'dynamic|up', equivalent: ['--watch'], desc: 'keep polling; optional 2nd positional = interval seconds' },
  hot: { target: 'dynamic|up', equivalent: ['--once', '--up-top'], desc: 'UP hot-comment cards; optional 2nd positional = fan reply count; with --up scans the whole account' },
  card: { target: 'comment', equivalent: ['--once', '--rpid'], desc: 'render one comment as a pinned-style card' },
  context: { target: 'comment', equivalent: ['--once', '--rpid', '--context'], desc: 'render the UP interaction review of one comment' },
  help: { target: 'none', equivalent: ['--help'], desc: 'print the full manual' },
  caps: { target: 'none', equivalent: ['--caps'], desc: 'print this capability manifest (JSON)' },
};

/** 构建能力清单（纯函数，便于测试） */
function buildCaps() {
  const groups = aliasesByCanon();
  const flags = Object.keys(groups).sort().map(canon => ({
    name: canon,
    aliases: groups[canon],
    arity: ARITY[canon] || 'flag',
    desc: DESC[canon] || '',
  }));
  const actions = [];
  for (const [word, id] of Object.entries(ACTIONS)) {
    if (!ACTION_META[id]) continue;
    actions.push({ word, id, ...ACTION_META[id] });
  }
  return {
    name: '@huntina6/bili-pinned-card',
    version: require('../package.json').version,
    jsonContract: 1,
    entry: 'cli.js',
    notes: [
      'targets accept share links (opus / t.bilibili.com / dynamic / comment / space) or raw numeric ids',
      'three spellings are equivalent: Chinese names, English names, legacy names',
      'use --json for a stable NDJSON stream on stdout; human logs go to stderr',
      'use --dry-run to resolve targets and see the plan without rendering or writing state',
    ],
    actions,
    flags,
    events: NOTIFY_EVENTS,
    cards: [
      { kind: 'pinned', file: 'pinned-card_<ctime>_<rpid>.png', latest: 'latest.png' },
      { kind: 'unpinned', file: 'unpinned-context_<ctime>_<rpid>.png', latest: 'latest-unpinned.png' },
      { kind: 'up-top', file: 'up-top_<ctime>_<rpid>.png', latest: 'latest-up-top.png' },
      { kind: 'dynamic', file: 'dynamic-update_<ctime>_<dynId>.png', latest: 'latest-dynamic.png' },
    ],
    exitCodes: { 0: 'success (including "no pinned comment" / "unchanged")', 1: 'failure (bad args, missing target, cookie invalid, deleted dynamic)', 130: 'cancelled by user' },
    env: ['BILI_LOG_LEVEL', 'BILI_LOG_DIR', 'BILI_BUVID_DIR', 'BILI_WBI_DIR', 'BILI_TICKET_DIR', 'BILI_EMOJI_CDN', 'NO_COLOR', 'CI'],
    files: {
      config: '~/.bili-pinned-card/config.json',
      logs: '~/.bili-pinned-card/logs/YYYY-MM-DD.log',
      state: '<outDir>/state.json',
    },
  };
}

module.exports = { buildCaps, ARITY, DESC, ACTION_META };
