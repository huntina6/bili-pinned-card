'use strict';
/**
 * 交互式配置引导（零依赖 step 状态机）
 * - qrLogin：扫码登录（--login 与交互模式共用）
 * - runInteractive：会话语义入口 —— 单一 readline 贯穿「向导 → 运行 → 再运行」，
 *   每轮从 buildConfig 产物重建 draft，从结构上消除跨轮状态残留
 * - runWizard：步骤定义表（STEPS）驱动，支持「上一步」、失败可恢复、汇总确认页
 * 依赖：ui / logger / state / api / login / notify / args，不依赖 cli.js
 */
const readline = require('readline');
const os = require('os');
const path = require('path');
const ui = require('./ui');
const {
  C, log, attach, ask, askSecret, startSpinner, CANCEL, BACK,
  section, select, selectYN, multiSelect, summaryRow, displayWidth,
} = ui;
const logger = require('./logger');
const { resolveCommentOid, extractId } = require('./api');
const { DEFAULT_UID, loadConfig, saveConfig, CFG_FILE } = require('./state');
const { DEFAULT_OUT_DIR, buildConfig, sanitizeOid, extractUid } = require('./args');
const { parseRule } = require('./rule');
const { NOTIFY_EVENTS, FORMATS } = require('./notify');
const { W: CARD_W } = require('./card/constants');
const emoji = require('./card/emoji');

// ====== 步骤状态机信号 ======
const NEXT = Symbol('bpc.next');
const EXIT = Symbol('bpc.exit');
const SAVE_ONLY = Symbol('bpc.saveOnly');

// ====== 交互输入校验与路径处理（纯函数，便于单测） ======
/** 展开路径开头的 ~（~ 或 ~/、~\）；其他原样返回 */
function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}
function validateUidInput(v) {
  const s = String(v || '').trim();
  if (/^\d+$/.test(s)) return null;
  // 与命令行一致：直接粘 UP 空间链接也可以（space.bilibili.com/<UID>）
  if (/space\.bilibili\.com\/\d+/i.test(s)) return null;
  return 'UID 必须是纯数字，或直接粘贴 UP 空间链接（space.bilibili.com/xxxx）';
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
/** Webhook 校验：留空=关闭推送；否则必须是 http(s) 链接（写错只会在运行期静默失败，这里先拦住） */
function validateWebhookInput(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  return /^https?:\/\/\S+/i.test(s) ? null : 'Webhook 需以 http:// 或 https:// 开头（留空则关闭推送）';
}
/** Webhook 摘要打码：仅展示 scheme+host 与路径前 8 字符（凭据通常藏在路径/查询里） */
function maskWebhook(url) {
  try {
    const u = new URL(String(url));
    const p = u.pathname.length > 8 ? u.pathname.slice(0, 8) + '…' : u.pathname;
    return `${u.protocol}//${u.host}${p}`;
  } catch { return '(已配置)'; }
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

// ====== 模式表（替代散落的 mode === '3' 字符串硬编码） ======
/**
 * @type {Array<{key:string,id:string,once:boolean,hot:boolean,manual:boolean,label:string,desc:(cap:any)=>string}>}
 */
const MODES = [
  {
    key: '1', id: 'watch', once: false, hot: false, manual: false, label: '持续监控',
    desc: cap => (cap.autoIdentify ? '置顶评论变化自动出图（默认）' : '指定动态的置顶评论变化自动出图'),
  },
  {
    key: '2', id: 'once', once: true, hot: false, manual: false, label: '单次检查',
    desc: cap => (cap.autoIdentify ? '立即检查置顶并出图一次' : '立即检查指定动态并出图一次'),
  },
  {
    key: '3', id: 'hot', once: true, hot: true, manual: false, label: 'UP 热评 TOP 卡',
    desc: cap => (cap.fullAccountTop ? 'UP 的每条一级评论出一张卡（可全账号）' : '指定单条动态，UP 的每条一级评论出一张卡'),
  },
  {
    key: '4', id: 'manual', once: true, hot: false, manual: true, label: '指定评论出图',
    desc: () => '手动出旧置顶/任意评论卡（可选 UP 互动回顾）',
  },
  { key: '0', id: 'exit', once: true, hot: false, manual: false, label: '退出', desc: () => '' },
];
const modeByKey = key => MODES.find(m => m.key === key);
const modeById = id => MODES.find(m => m.id === id);
/** 由命令行参数/已保存配置推断默认模式（已有 --oid/--cookie 时进入向导也能正确预选） */
function defaultModeId(args = {}, cfg = {}) {
  if (args.upTop != null || cfg.upTop) return 'hot';
  if (args.rpid || cfg.rpid) return 'manual';
  if (args.once) return 'once';
  return 'watch';
}

// ====== 登录方式表（key 统一为数字，与运行模式节一致，数字键可直达） ======
const LOGIN_KEEP = 'keep', LOGIN_SCAN = 'scan', LOGIN_MANUAL = 'manual', LOGIN_GUEST = 'guest';
function loginChoices(hasCookie, savedUid) {
  return hasCookie
    ? [
      { key: '1', value: LOGIN_KEEP, label: '已登录', desc: `沿用已保存 Cookie${savedUid ? `（UID ${savedUid}）` : ''}` },
      { key: '2', value: LOGIN_SCAN, label: '重新扫码登录', desc: '刷新 Cookie（有效期约 30 天，推荐）' },
      { key: '3', value: LOGIN_MANUAL, label: '手动粘贴 Cookie', desc: '浏览器 F12 复制 SESSDATA（备用方式）' },
      { key: '4', value: LOGIN_GUEST, label: '游客模式', desc: '清除已保存 Cookie；仅限指定动态，功能受限' },
    ]
    : [
      { key: '1', value: LOGIN_SCAN, label: '扫码登录', desc: '解锁 UID 自动识别 / 完整子回复 / 全账号热评' },
      { key: '2', value: LOGIN_MANUAL, label: '手动粘贴 Cookie', desc: '浏览器 F12 复制 SESSDATA（无扫码环境时）' },
      { key: '3', value: LOGIN_GUEST, label: '游客模式', desc: '免登录；仅限指定动态，子回复仅第一页' },
    ];
}
const pickValue = (choices, key) => (choices.find(c => c.key === key) || {}).value;

// ====== 通知事件说明（多选时展示） ======
const EVENT_DESC = {
  'new': '置顶评论发布/换新',
  'unpinned': '置顶被取消',
  'dyn-update': '普通动态更新',
  'up-top': '热评卡生成',
  'error': '运行错误',
};

// ====== 交互闸门（纯函数，便于单测）：显式 flag 优先，CI/非 TTY 一律不引导 ======
/**
 * 是否进入交互向导
 * - --no-input 显式退出；--interactive 显式进入（已有 --oid/--cookie 时补配规则/推送）
 * - 非双向 TTY 或 CI 环境不引导，保持脚本可预测
 * - 默认：完全没有目标参数（--oid 与 --cookie 均缺省）才引导
 * @param {any} args parseArgs 产物
 * @param {{stdinTTY?: boolean, stdoutTTY?: boolean, ci?: boolean}} [env] 可注入（便于单测）
 */
function shouldInteract(args = {}, env = {}) {
  if (args.noInput) return false;
  const ttyIn = env.stdinTTY != null ? env.stdinTTY : !!process.stdin.isTTY;
  const ttyOut = env.stdoutTTY != null ? env.stdoutTTY : !!process.stdout.isTTY;
  const ci = env.ci != null ? env.ci : !!process.env.CI;
  if (!ttyIn || !ttyOut || ci) return false;
  if (args.interactive) return true;
  return !args.oid && args.cookie == null;
}

// ====== 输入原语：统一支持「上一步」 ======
const BACK_WORDS = new Set(['b', 'back', '..']);
/** 带校验的文本输入；输入 b / back / .. 返回 BACK（在校验前拦截，避免被校验器判为非法值） */
async function askBack(question, def, validate) {
  for (;;) {
    const v = await ask(question, def);
    if (v === CANCEL) return CANCEL;
    if (BACK_WORDS.has(String(v).trim().toLowerCase())) return BACK;
    const err = validate ? validate(v) : null;
    if (!err) return v;
    console.log(`  ${C.red(`✗ ${err}`)}`);
  }
}
/** 掩码输入（Cookie）版：输入 b / back / .. 返回 BACK */
async function askSecretBack(question, validate) {
  for (;;) {
    const v = await askSecret(question);
    if (v === CANCEL) return CANCEL;
    if (BACK_WORDS.has(String(v).trim().toLowerCase())) return BACK;
    const err = validate ? validate(v) : null;
    if (!err) return v;
    console.log(`  ${C.red(`✗ ${err}`)}`);
  }
}
/** 单选（← / b 返回上一步） */
const selectBack = (options, defaultIndex = 0) => select(options, defaultIndex, undefined, { allowBack: true });

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

// ====== draft：每轮向导的干净快照 ======
/**
 * 从 buildConfig 产物派生一份干净 draft：一次性/派生字段一律归零。
 * 旧实现靠三处「防残留补丁」（uidForSave / upTop=0 / uidExplicit）兜底跨轮污染，
 * 现在改由每轮重建 draft 从结构上保证隔离。
 * @param {any} cfg buildConfig 产物
 * @param {any} saved loadConfig() 产物（提供 lastUpTop / lastMaxDyns 预填）
 */
function createDraft(cfg, saved = {}) {
  return {
    ...cfg,
    once: false, upTop: 0, maxDyns: Infinity, rpid: '', context: false, force: false,
    uidExplicit: false,
    modeId: defaultModeId({}, cfg),
    uidForSave: cfg.uid,
    // 真正「保存过的」UID（不含 DEFAULT_UID 兜底值）：游客模式回退保存时用它，避免把默认账号写进配置
    _savedUid: saved.uid || '',
    _lastUpTop: Number.isFinite(saved.lastUpTop) && saved.lastUpTop > 0 ? saved.lastUpTop : 10,
    _lastMaxDyns: Number.isFinite(saved.lastMaxDyns) && saved.lastMaxDyns > 0 ? saved.lastMaxDyns : null,
    rules: Array.isArray(cfg.rules) ? cfg.rules.slice() : [],
    // null = 未指定（向导按「全订阅」预勾选）；[] = 显式不订阅任何事件（保持不勾选）
    notifyEvents: Array.isArray(cfg.notifyEvents) ? cfg.notifyEvents.slice() : null,
    cap: loginCapabilities(!!cfg.cookie),
  };
}
/**
 * 持久化 draft（仅在汇总确认后调用）
 * - lastUpTop/lastMaxDyns 为「向导预填」专用键：刻意不写 upTop/maxDyns，
 *   否则 checkOnce 的 `if (cfg.upTop)` 分支会在下次裸跑时被历史值误触发
 * - oid/type 保存便于下次直接沿用；rpid 属一次性目标，不落盘
 * @param {any} d draft
 */
function persistDraft(d) {
  const outCustom = d.outDir !== DEFAULT_OUT_DIR;
  saveConfig({
    uid: d.uidForSave || d.uid, oid: sanitizeOid(d.oid), type: d.type, cookie: d.cookie,
    upName: d.upName, showReplies: d.showReplies,
    interval: d.interval, outDir: outCustom ? d.outDir : '', outDirCustom: outCustom,
    trackDyn: d.trackDyn, scale: d.scale,
    rules: d.rules, ruleMode: d.ruleMode,
    notifyWebhook: d.notifyWebhook, notifyFormat: d.notifyFormat,
    notifyChatId: d.notifyChatId, notifyEvents: Array.isArray(d.notifyEvents) ? d.notifyEvents : null,
    notifyPrefix: d.notifyPrefix,
    emoji: d.emojiEnabled,
    lastUpTop: d.upTop > 0 ? d.upTop : 0,
    lastMaxDyns: Number.isFinite(d.maxDyns) ? d.maxDyns : null,
  });
}

/**
 * 是否需要询问「目标 UP 主 UID」（纯函数，便于单测）
 * 人类逻辑：只有「没有动态目标」时才需要知道盯哪个 UP ——
 *   · 指定评论出图：UP 由动态/评论自动识别，不必问
 *   · 游客模式：UID 自动识别不可用，问了也没用
 *   · 已经填了动态：UP 身份来自这条动态（监测、热评都不需要 uid）
 *   · 没填动态：监测要靠 UID 自动识别置顶动态、热评要全账号检索 → 必须问
 * @param {any} d draft
 * @returns {boolean}
 */
function needsUid(d) {
  const cap = d.cap || loginCapabilities(!!d.cookie);
  if (!cap.autoIdentify) return false;
  if (d.modeId === 'manual') return false;
  return !String(d.oid || '').trim();
}

// ====== 步骤定义表 ======
/**
 * 每步形状：{ id, title?, when?(d,ctx), passive?(d), run(d,ctx) }
 * passive=true 表示该步在特定条件下无任何提问（供「上一步」跳过）
 * run 返回：NEXT / BACK / CANCEL / EXIT / SAVE_ONLY / 字符串（跳转到该步骤 id）
 * @typedef {{id:string, title?:string|((d:any)=>string), when?:(d:any,ctx:any)=>boolean,
 *   passive?:(d:any,ctx:any)=>boolean, run:(d:any,ctx:any)=>Promise<any>}} Step
 */
/** @type {Step[]} */
const STEPS = [
  {
    id: 'login',
    title: '登录状态',
    run: async (d) => {
      console.log(C.dim('  ↑/↓ 或数字键选择，回车确认；← 返回上一步'));
      const savedUid = String(d.cookie || '').match(/DedeUserID=(\d+)/)?.[1];
      const choices = loginChoices(!!d.cookie, savedUid);
      const key = await selectBack(choices, 0);
      if (key === CANCEL) return CANCEL;
      if (key === BACK) return BACK;
      const value = pickValue(choices, key);
      if (value === LOGIN_SCAN) {
        try {
          const { cookieStr } = await qrLogin(log);
          d.cookie = cookieStr; // 本次运行立即生效（qrLogin 已持久化）
        } catch (err) {
          console.error(C.red(`  ✗ 扫码登录失败: ${err.message}`));
          logger.error(`交互扫码登录失败: ${err.message}`);
          console.log(C.yellow(d.cookie ? '  本次沿用已保存 Cookie 运行。' : '  将继续以游客模式运行（功能受限）。'));
        }
      } else if (value === LOGIN_MANUAL) {
        console.log(C.dim('  提示：输入过程仅显示 *，不会回显 Cookie 内容'));
        const ck = await askSecretBack('Cookie（SESSDATA=xxx; bili_jct=yyy）', validateCookieInput);
        if (ck === CANCEL) return CANCEL;
        if (ck === BACK) return BACK;
        d.cookie = String(ck);
      } else if (value === LOGIN_GUEST) {
        const had = !!d.cookie;
        d.cookie = '';
        // 游客用不了「UID 自动识别」，本次身份置空；已保存的 UID 留给 uidForSave，下次登录后仍可沿用
        d.uidForSave = d._savedUid || '';
        d.uid = '';
        d.uidExplicit = false;
        console.log(C.dim(had ? '  已清除已保存的 Cookie，本次以游客模式运行' : '  本次以游客模式运行'));
      }
      d.cap = loginCapabilities(!!d.cookie);
      console.log(C.dim(d.cap.autoIdentify
        ? '  可用：UID 自动识别置顶动态 · 完整子回复 · 全账号热评检索'
        : '  可用：指定动态出图；不可用：UID 自动识别 · 全账号热评 · 完整子回复（仅第一页 20 条）'));
      return NEXT;
    },
  },
  {
    id: 'mode',
    title: '运行模式',
    run: async (d, ctx) => {
      console.log(C.dim('  ↑/↓ 或数字键选择，回车确认；← 返回上一步'));
      const cap = d.cap || loginCapabilities(!!d.cookie);
      const defIdx = Math.max(0, MODES.findIndex(m => m.id === defaultModeId(ctx.args, d)));
      const key = await selectBack(MODES.map(m => ({ key: m.key, label: m.label, desc: m.desc(cap) })), defIdx);
      if (key === CANCEL) return CANCEL;
      if (key === BACK) return BACK;
      const m = modeByKey(key);
      if (m.id === 'exit') { console.log('\n再见 👋'); return EXIT; }
      d.modeId = m.id;
      d.once = m.once;
      // 归零属「模式语义定义」：非热评模式不带 upTop，非指定评论模式不带 rpid
      if (!m.hot) d.upTop = 0;
      if (!m.manual) { d.rpid = ''; d.context = false; }
      return NEXT;
    },
  },
  {
    id: 'hotN',
    when: d => d.modeId === 'hot',
    run: async (d) => {
      const def = d.upTop > 0 ? String(d.upTop) : String(d._lastUpTop || 10);
      const ans = await askBack('每张卡的粉丝高赞区条数（1-50）', def, validateTopNInput);
      if (ans === CANCEL) return CANCEL;
      if (ans === BACK) return BACK;
      d.upTop = parseInt(ans, 10);
      return NEXT;
    },
  },
  {
    id: 'oid',
    title: '动态目标',
    run: async (d) => {
      const cap = d.cap || loginCapabilities(!!d.cookie);
      const needOid = d.modeId === 'manual' || !cap.autoIdentify;
      const hot = d.modeId === 'hot';
      const validate = needOid
        ? (v => {
          const s = String(v || '').trim();
          if (!s) {
            return d.modeId === 'manual'
              ? '指定评论出图需先填写动态链接或 ID'
              : '游客模式必须填写动态链接或 ID（登录后可用 UID 自动识别）';
          }
          // 历史配置里的 oid=0 会被预填为 "[0]"：直接回车等于沿用无效目标，下游只报 -400
          return /^0+$/.test(s) ? 'ID 不能为 0（无效动态 ID，B站 会返回空壳评论区）' : null;
        })
        : null;
      const question = d.modeId === 'manual'
        ? '动态链接或 ID（指定评论出图必填）'
        : (needOid
          ? (hot ? '动态链接或 ID（游客模式必填：仅支持单条动态）' : '动态链接或 ID（游客模式必填，不支持留空自动识别）')
          : (hot
            ? '动态链接或 ID（推荐填单条动态；留空则检索该 UP 全账号动态，逐条确认处理）'
            : '动态链接或 ID（可选，留空则自动识别置顶动态；支持 Opus 链接）'));
      for (;;) {
        const ans = await askBack(question, d.oid || '', validate);
        if (ans === CANCEL) return CANCEL;
        if (ans === BACK) return BACK;
        const text = String(ans || '').trim();
        if (!text) return NEXT;
        const sp = startSpinner('正在解析动态链接...');
        try {
          const r = await resolveCommentOid(text, d.cookie);
          // 显式展示解析结果：此前固定打印「动态链接已解析」，即使解析出的是评论 oid 或原样透传也显示成功，
          // 会把「静默拿错 oid」掩盖成正常流程（实测 oid=0 也能显示 ✓）
          sp.stop(C.green(`  ✓ 评论区对象 oid=${r.oid}${r.type != null ? ` · type=${r.type}` : '（原样使用，未做类型转换）'}`));
          d.oid = r.oid;
          if (r.type != null) d.type = r.type;
          return NEXT;
        } catch (e) {
          sp.stop(); // 先清除 spinner 再打印错误
          console.log(C.red(`  ✗ 链接解析失败: ${e.message}`));
          logger.error(`链接解析失败: ${e.message}`);
          // 失败不再整轮退出：可重填 / 显式沿用旧目标 / 返回上一步（避免静默沿用旧目标）
          const retry = await selectBack([
            { key: '1', label: '重新填写', desc: '再次输入动态链接或 ID' },
            { key: '2', label: '沿用已保存目标', desc: d.oid ? `动态 ${d.oid}` : '（当前无目标，将自动识别）' },
            { key: '0', label: '返回上一步', desc: '' },
          ], 0);
          if (retry === CANCEL) return CANCEL;
          if (retry === BACK || retry === '0') return BACK;
          if (retry === '2') return NEXT;
        }
      }
    },
  },
  {
    id: 'target',
    title: '目标 UP 主',
    // 只有「没给动态目标」时才需要才知道盯哪个 UP（见 needsUid）
    when: d => needsUid(d),
    run: async (d) => {
      console.log(C.dim('  没填动态 → 需要知道盯哪个 UP 主：在 UP 空间页地址 space.bilibili.com/<数字> 里能看到 UID，'));
      console.log(C.dim('  也可以把整条空间链接粘进来（自动取 UID）'));
      // 兜底的 DEFAULT_UID 是内部默认账号，不能当成用户的默认答案：没有真正保存过的 UID 就不预填
      const def = d.uidDefaulted ? '' : (d.uid || '');
      const ans = await askBack('目标 UP 主 UID（或空间链接）', def, validateUidInput);
      if (ans === CANCEL) return CANCEL;
      if (ans === BACK) return BACK;
      d.uid = extractUid(ans); // 粘空间链接时自动取出 UID
      d.uidExplicit = true;
      d.uidDefaulted = false;
      d.uidForSave = d.uid;
      return NEXT;
    },
  },
  {
    id: 'rpid',
    when: d => d.modeId === 'manual',
    run: async (d) => {
      const ans = await askBack('评论链接或 ID（分享链接会自动提取评论 ID）', d.rpid || '', validateRpidInput);
      if (ans === CANCEL) return CANCEL;
      if (ans === BACK) return BACK;
      d.rpid = extractId(ans);
      const ctxAns = await selectYN('同时生成 UP 互动回顾图（该评论下的 UP 回复/点赞）', d.context, undefined);
      if (ctxAns === CANCEL) return CANCEL;
      d.context = Boolean(ctxAns);
      return NEXT;
    },
  },
  {
    id: 'maxDyns',
    when: d => d.modeId === 'hot' && (d.cap || {}).autoIdentify && !d.oid,
    run: async (d) => {
      const def = Number.isFinite(d.maxDyns) ? String(d.maxDyns) : (d._lastMaxDyns ? String(d._lastMaxDyns) : '');
      const ans = await askBack(
        '全账号检索最多处理动态数（留空不限制）', def,
        v => {
          const s = String(v || '').trim();
          return (!s || (/^\d+$/.test(s) && parseInt(s, 10) >= 1)) ? null : '请输入 ≥1 的整数，或留空不限制';
        },
      );
      if (ans === CANCEL) return CANCEL;
      if (ans === BACK) return BACK;
      d.maxDyns = String(ans).trim() ? parseInt(ans, 10) : Infinity;
      return NEXT;
    },
  },
  {
    id: 'monitor',
    title: '监控行为',
    when: d => d.modeId !== 'hot' && d.modeId !== 'manual',
    run: async (d) => {
      if (!d.once) {
        const iv = await askBack('检查间隔（秒）', String(d.interval), validateIntervalInput);
        if (iv === CANCEL) return CANCEL;
        if (iv === BACK) return BACK;
        d.interval = parseInt(iv, 10);
      }
      const dynAns = await selectYN('同时监测普通动态更新（置顶未变但发了新动态时提示并出图）', d.trackDyn, undefined);
      if (dynAns === CANCEL) return CANCEL;
      d.trackDyn = Boolean(dynAns);
      // 内容规则（可选）：仅命中规则的置顶评论才出图/推送；留空不过滤
      const ruleAns = await askBack('内容规则（关键词或 /正则/i，多个用逗号分隔；留空不过滤）', (d.rules || []).join(','));
      if (ruleAns === CANCEL) return CANCEL;
      if (ruleAns === BACK) return BACK;
      const rawRules = String(ruleAns || '').split(',').map(s => s.trim()).filter(Boolean);
      d.rules = [];
      for (const r of rawRules) {
        try { parseRule(r); d.rules.push(r); }
        catch (e) { console.log(C.yellow(`  ✗ 规则「${r}」已忽略：${e.message}`)); }
      }
      if (d.rules.length > 1) {
        const rmAns = await selectYN('多条规则需全部命中（否则任一命中即出图）', d.ruleMode === 'all', undefined);
        if (rmAns === CANCEL) return CANCEL;
        d.ruleMode = rmAns ? 'all' : 'any';
      } else {
        d.ruleMode = 'any';
      }
      return NEXT;
    },
  },
  {
    id: 'notify',
    title: '通知推送',
    run: async (d) => {
      const nwAns = await askBack('推送 Webhook 地址（留空关闭；支持飞书/钉钉/Telegram/通用）', d.notifyWebhook || '', validateWebhookInput);
      if (nwAns === CANCEL) return CANCEL;
      if (nwAns === BACK) return BACK;
      d.notifyWebhook = String(nwAns || '').trim();
      if (!d.notifyWebhook) {
        // 关闭推送：清空全部通知字段，避免残留旧模板/订阅集
        d.notifyFormat = 'generic';
        d.notifyChatId = '';
        d.notifyEvents = [];
        d.notifyPrefix = '';
        return NEXT;
      }
      const fmtAns = await selectBack([
        { key: '1', label: '通用 JSON', desc: '自定义服务接收原始事件字段（默认）' },
        { key: '2', label: '飞书机器人', desc: 'msg_type=text' },
        { key: '3', label: '钉钉机器人', desc: 'msgtype=text' },
        { key: '4', label: 'Telegram Bot', desc: '需再填 chat_id' },
      ], Math.max(0, FORMATS.indexOf(d.notifyFormat)));
      if (fmtAns === CANCEL) return CANCEL;
      if (fmtAns === BACK) return BACK;
      d.notifyFormat = FORMATS[parseInt(String(fmtAns), 10) - 1] || 'generic';
      if (d.notifyFormat === 'telegram') {
        const cidAns = await askBack('Telegram chat_id', d.notifyChatId || '');
        if (cidAns === CANCEL) return CANCEL;
        if (cidAns === BACK) return BACK;
        d.notifyChatId = String(cidAns || '').trim();
      } else {
        d.notifyChatId = '';
      }
      // 订阅事件子集（多选；空数组语义为「全订阅」，故未配置时默认全选）
      // 预勾选：未指定（null）→ 全部勾选；显式空数组 → 一个都不勾（尊重上次的「不推送」选择）
      const pre = new Set(Array.isArray(d.notifyEvents) ? d.notifyEvents : NOTIFY_EVENTS);
      const eventOpts = NOTIFY_EVENTS.map((e, i) => ({ key: String(i + 1), label: e, desc: EVENT_DESC[e] || '' }));
      const preKeys = eventOpts.filter(o => pre.has(NOTIFY_EVENTS[Number(o.key) - 1])).map(o => o.key);
      const picked = await multiSelect(eventOpts, preKeys);
      if (!Array.isArray(picked)) return picked === CANCEL ? CANCEL : BACK;
      d.notifyEvents = picked.map(k => NOTIFY_EVENTS[Number(k) - 1]).filter(Boolean);
      if (!d.notifyEvents.length) console.log(C.dim('  未勾选任何事件：本次配置不推送通知（重新勾选即可恢复）'));
      const prefixAns = await askBack('推送标题前缀（如 UP 名；留空不加前缀）', d.notifyPrefix || '');
      if (prefixAns === CANCEL) return CANCEL;
      if (prefixAns === BACK) return BACK;
      d.notifyPrefix = String(prefixAns || '').trim();
      return NEXT;
    },
  },
  {
    id: 'output',
    title: d => (d.modeId === 'hot' || d.modeId === 'manual' ? '输出设置' : '卡片与输出'),
    run: async (d, ctx) => {
      const hot = d.modeId === 'hot', manual = d.modeId === 'manual';
      if (!hot && (!manual || !d.context)) {
        const srAns = await selectYN('卡片上绘制精彩回复', d.showReplies, undefined);
        if (srAns === CANCEL) return CANCEL;
        d.showReplies = Boolean(srAns);
      }
      if (!manual) {
        const fAns = await selectYN('强制重新出图（忽略已出图状态）', d.force, undefined);
        if (fAns === CANCEL) return CANCEL;
        d.force = Boolean(fAns);
      }
      // emoji 开关：--no-emoji 时默认关闭（显式 flag 决定默认值，仍可在向导内改）
      const emojiAns = await selectYN('彩色 emoji（Twemoji 内联图）', ctx.args.noEmoji ? false : emoji.emojiEnabled(), undefined);
      if (emojiAns === CANCEL) return CANCEL;
      emoji.setEnabled(Boolean(emojiAns));
      d.emojiEnabled = Boolean(emojiAns);
      // 输出分辨率：预设倍率 / 自定义宽度（宽度换算为倍率保存）
      const presetIdx = [1, 2, 3].indexOf(d.scale);
      const resAns = await selectBack([
        { key: '1', label: '1x（680px）', desc: '小图分享' },
        { key: '2', label: '2x（1360px）', desc: '默认高清（推荐）' },
        { key: '3', label: '3x（2040px）', desc: '超清' },
        { key: 'x', label: '自定义宽度', desc: `当前 ${Math.round(CARD_W * d.scale)}px（340-4080）` },
      ], presetIdx >= 0 ? presetIdx : 3);
      if (resAns === CANCEL) return CANCEL;
      if (resAns === BACK) return BACK;
      if (resAns === 'x') {
        const wAns = await askBack('输出宽度（像素，340-4080）', String(Math.round(CARD_W * d.scale)), validateWidthInput);
        if (wAns === CANCEL) return CANCEL;
        if (wAns === BACK) return BACK;
        d.scale = parseInt(wAns, 10) / CARD_W;
      } else {
        d.scale = parseInt(String(resAns), 10); // 1/2/3 预设倍率
      }
      const outAns = await askBack('输出目录', d.outDir);
      if (outAns === CANCEL) return CANCEL;
      if (outAns === BACK) return BACK;
      if (outAns) d.outDir = expandHome(outAns);
      const nameAns = await askBack('卡片标题显示名（留空自动取 UP 名）', d.upName || '');
      if (nameAns === CANCEL) return CANCEL;
      if (nameAns === BACK) return BACK;
      if (nameAns) d.upName = nameAns;
      // 运行方式：先试跑（只看会出什么）/ 详细日志（排障）
      const dryAns = await selectYN('先试跑一次（只报告会出什么，不出图、不改状态）', !!d.dryRun, undefined);
      if (dryAns === CANCEL) return CANCEL;
      d.dryRun = Boolean(dryAns);
      const vAns = await selectYN('记录详细日志（每次 API 请求写入日志文件，排障用）', logger.getLevel() === 'debug', undefined);
      if (vAns === CANCEL) return CANCEL;
      d.verbose = Boolean(vAns);
      logger.setLevel(d.verbose ? 'debug' : 'info');
      return NEXT;
    },
  },
  {
    id: 'confirm',
    title: '确认',
    run: async (d, ctx) => {
      printSummary(d);
      const key = await select([
        { key: '1', label: '开始运行', desc: d.once ? '按以上配置立即执行一次' : '按以上配置开始持续监控' },
        { key: '2', label: '仅保存配置，不运行', desc: '下次直接沿用（含 Cookie/规则/推送）' },
        { key: '3', label: '返回修改', desc: '选择要重新配置的段落' },
        { key: '4', label: '清空已保存配置', desc: '移除 config.json 中的全部历史配置' },
        { key: '0', label: '放弃并退出', desc: '不保存本次修改' },
      ], 0);
      if (key === CANCEL) return CANCEL;
      if (key === '0') { console.log(C.yellow('已放弃本次配置，未保存。')); return EXIT; }
      if (key === '4') {
        const sure = await selectYN('确认清空已保存配置？此后需重新登录/配置', false, undefined);
        if (sure === CANCEL) return CANCEL;
        if (sure === true) {
          saveConfig({});
          console.log(C.green(`  已清空已保存配置（${CFG_FILE}）`));
        } else {
          console.log(C.dim('  已取消清空，配置保持不变。'));
        }
        return 'confirm';
      }
      if (key === '3') {
        const jm = await selectBack(SECTION_JUMPS.map(s => ({ key: s.key, label: s.label, desc: s.desc })), 0);
        if (jm === CANCEL) return CANCEL;
        if (jm === BACK) return 'confirm';
        return resolveJump((SECTION_JUMPS.find(s => s.key === jm) || {}).step || 'confirm', d, ctx);
      }
      // 保存时机：确认通过后才落盘（旧实现在打印汇总前就已写入）
      persistDraft(d);
      console.log(C.dim(`  配置已保存至 ${CFG_FILE}`));
      return key === '2' ? SAVE_ONLY : NEXT;
    },
  },
];

/** 汇总页「返回修改」可选段落 → 目标步骤 id */
const SECTION_JUMPS = [
  { key: '1', label: '登录状态', desc: 'Cookie / 扫码 / 游客模式', step: 'login' },
  { key: '2', label: '运行模式', desc: '持续监控 / 单次 / 热评 / 指定评论', step: 'mode' },
  { key: '3', label: '目标与动态', desc: 'UID / 动态链接 / 评论 ID', step: 'oid' },
  { key: '4', label: '监控行为', desc: '间隔 / 普通动态 / 内容规则', step: 'monitor' },
  { key: '5', label: '通知推送', desc: 'Webhook / 模板 / 事件 / 前缀', step: 'notify' },
  { key: '6', label: '卡片与输出', desc: '回复 / 分辨率 / 目录 / 标题名', step: 'output' },
];

/**
 * 「返回修改」跳转解析：目标段落可能被当前模式跳过（如热评/指定评论模式没有「监控行为」段落）
 * → 顺延到下一个可执行步骤并明确提示，避免「选了没反应」
 * @param {string} stepId SECTION_JUMPS 里的步骤 id
 * @param {any} draft
 * @param {any} ctx
 * @returns {string} 实际要跳到的步骤 id
 */
function resolveJump(stepId, draft, ctx) {
  const start = STEPS.findIndex(s => s.id === stepId);
  if (start < 0) return 'confirm';
  const label = (SECTION_JUMPS.find(s => s.step === stepId) || {}).label || stepId;
  for (let j = start; j < STEPS.length; j++) {
    const s = STEPS[j];
    if (s.when && !s.when(draft, ctx)) continue;
    if (s.passive && s.passive(draft, ctx)) continue;
    if (j !== start) {
      const t = typeof s.title === 'function' ? s.title(draft) : s.title;
      console.log(C.dim(`  「${label}」在当前模式（${draft.modeId}）下不适用，已跳到「${t || s.id}」`));
    }
    return s.id;
  }
  return 'confirm';
}

// ====== 汇总页 ======
/** 配置汇总（先展示、后保存：保存动作在用户确认之后才发生） */
function printSummary(d) {
  const cookieUid = String(d.cookie || '').match(/DedeUserID=(\d+)/)?.[1];
  const loggedIn = !!d.cookie; // 判定口径与 loginCapabilities 一致：有 Cookie 即已登录（DedeUserID 只是展示用）
  console.log(`\n${C.pink('┌─ ')}${C.bold('配置汇总')}${C.pink(` ${'─'.repeat(Math.max(2, 44 - displayWidth('配置汇总') - 4))}┐`)}`);
  summaryRow('目标', d.oid ? `动态 ${d.oid}` : `UID ${d.uid}`);
  // 只粘 SESSDATA（无 DedeUserID）也是已登录：能力已按 Cookie 放开，展示不能反过来说「游客」
  summaryRow('登录', loggedIn
    ? (cookieUid ? `UID ${cookieUid}（已登录）` : '已登录（Cookie 未含 DedeUserID）')
    : '游客（仅指定动态）');
  if (!loggedIn) summaryRow('限制', '无 UID 自动识别 · 无全账号热评 · 子回复仅第一页');
  summaryRow('模式', d.modeId === 'hot'
    ? `UP 热评 TOP 卡 · 高赞区 ${d.upTop} 条/卡`
    : (d.modeId === 'manual'
      ? `指定评论出图${d.context ? ' · UP互动回顾' : ''}`
      : (d.once ? '单次检查' : `持续监控 · 每 ${d.interval}s`)));
  if (d.modeId === 'manual') summaryRow('评论', d.rpid);
  if (d.modeId !== 'manual' && d.force) summaryRow('重出', '强制忽略已出图状态');
  if (d.modeId === 'hot' && Number.isFinite(d.maxDyns)) summaryRow('限额', `全账号最多 ${d.maxDyns} 条动态`);
  if (d.modeId !== 'hot' && d.modeId !== 'manual' && d.trackDyn) summaryRow('监测', '普通动态更新已开启');
  if (d.rules && d.rules.length) summaryRow('规则', `${d.rules.join(' + ')}（${d.ruleMode === 'all' ? '全部命中' : '任一命中'}）`);
  if (d.notifyWebhook) {
    summaryRow('推送', `${d.notifyFormat || 'generic'} → ${maskWebhook(d.notifyWebhook)}`);
    const evs = Array.isArray(d.notifyEvents) ? d.notifyEvents : NOTIFY_EVENTS;
    summaryRow('事件', evs.length ? evs.join(',') : '（不推送任何事件）');
    if (d.notifyPrefix) summaryRow('前缀', d.notifyPrefix);
  }
  if (d.modeId !== 'hot' && d.showReplies) summaryRow('卡片', '含精彩回复');
  if (!emoji.emojiEnabled()) summaryRow('emoji', '已关闭彩色化（回退文本）');
  summaryRow('分辨率', `${Math.round(CARD_W * d.scale)}px（${Number(Number(d.scale).toFixed(2))}x）`);
  summaryRow('输出', d.outDir);
  if (d.dryRun) summaryRow('试跑', '只报告计划，不出图、不改状态');
  if (logger.getLevel() === 'debug') summaryRow('日志', '详细（每次 API 请求写入日志文件）');
  console.log('');
}

// ====== 步骤状态机驱动 ======
/** 「上一步」目标：跳过未启用（when=false）与无提问（passive=true）的步骤；无更早步骤则原地重问 */
function prevIndex(i, draft, ctx) {
  for (let j = i - 1; j >= 0; j--) {
    const s = STEPS[j];
    if (s.when && !s.when(draft, ctx)) continue;
    if (s.passive && s.passive(draft, ctx)) continue;
    return j;
  }
  return i;
}
/** 逐步执行步骤表；返回 { action: 'run'|'exit'|'cancel'|'save-only' } */
async function runWizard(draft, ctx) {
  let i = 0;
  while (i < STEPS.length) {
    const step = STEPS[i];
    if (step.when && !step.when(draft, ctx)) { i++; continue; }
    if (step.title) section(typeof step.title === 'function' ? step.title(draft) : step.title);
    const r = await step.run(draft, ctx);
    if (r === CANCEL) return { action: 'cancel' };
    if (r === EXIT) return { action: 'exit' };
    if (r === SAVE_ONLY) return { action: 'save-only' };
    if (r === BACK) { i = prevIndex(i, draft, ctx); continue; }
    if (typeof r === 'string') {
      const t = STEPS.findIndex(s => s.id === r);
      i = t >= 0 ? t : i + 1;
      continue;
    }
    i++;
  }
  return { action: 'run' };
}

// ====== 会话语义入口 ======
/**
 * 向导 → 运行 → 「再运行一次」全部在同一 readline 会话内完成（替代旧的 promptReRun 另开 readline）
 * 每轮都从 buildConfig(args, 盘上配置) 重建基准 + createDraft 快照，跨轮零状态残留
 * @param {any} cfg buildConfig 产物（原地更新，与 watcher 共享引用）
 * @param {{args?:any, banner?:string, bannerShown?:boolean, saved?:any, run?:(cfg:any)=>Promise<void>}} opts
 * @returns {Promise<{ran:boolean, exit?:boolean}>}
 */
async function runInteractive(cfg, { args = {}, banner = '', bannerShown = false, run } = {}) {
  if (!shouldInteract(args)) {
    if (!args.oid && args.cookie == null && !args.noInput) {
      console.log(C.dim('未指定 --oid 且无 Cookie，尝试匿名自动识别置顶动态（可能被风控）...'));
      console.log(C.dim('（非 TTY / CI 环境默认跳过交互向导；需强制进入可加 --interactive）'));
    }
    return { ran: false };
  }
  if (banner && !bannerShown) console.log(banner);
  log(C.dim(`运行日志: ${logger.logDir()}（排障加 -v 记录每次 API 请求）`));

  // 单一 readline：向导与「再运行一次」共用一个实例
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  attach(rl);
  let cancelled = false;
  const teardown = () => {
    ui.cancelActivePrompts();
    try { rl.close(); } catch { /* 忽略 */ }
    attach(null);
  };
  // 向导期间 Ctrl+C = 取消配置并退出；运行期间卸载，交由 watcher 的进程级信号处理
  const onSigint = () => {
    if (cancelled) return;
    cancelled = true;
    teardown();
    console.log(`\n${C.yellow('已取消配置，未运行。')}`);
    process.exit(130);
  };
  const armSignals = () => rl.on('SIGINT', onSigint);
  const disarmSignals = () => rl.removeListener('SIGINT', onSigint);
  armSignals();

  for (;;) {
    const base = loadConfig();
    Object.assign(cfg, buildConfig(args, base)); // 每轮从「参数 + 盘上配置」重新归一化
    const draft = createDraft(cfg, base);
    const res = await runWizard(draft, { args, saved: base });
    if (res.action === 'cancel') {
      teardown();
      console.log(`\n${C.yellow('已取消配置，未运行。')}`);
      process.exitCode = 130;
      return { ran: true, exit: true };
    }
    if (res.action === 'exit') { teardown(); return { ran: true, exit: true }; }
    if (res.action === 'save-only') {
      teardown();
      console.log(C.yellow('已保存配置，未运行。下次不带参数直接运行即可沿用。'));
      return { ran: true, exit: true };
    }
    Object.assign(cfg, draft); // 回写本次配置（cfg 与 watcher 共享引用）
    if (typeof run !== 'function') { teardown(); return { ran: true }; }

    disarmSignals();
    try {
      await run(cfg);
    } finally {
      armSignals();
    }
    if (!(process.stdin.isTTY && process.stdout.isTTY && !cfg.quiet)) break;
    const again = await selectYN('返回配置菜单，再运行一次？', false, undefined);
    if (again !== true) break;
  }
  teardown();
  return { ran: true };
}

module.exports = {
  runInteractive, runWizard, qrLogin, shouldInteract,
  createDraft, persistDraft, printSummary,
  MODES, modeByKey, modeById, defaultModeId, loginChoices, pickValue, needsUid, resolveJump,
  validateWebhookInput,
  EVENT_DESC, SECTION_JUMPS,
  expandHome, validateUidInput, validateIntervalInput, validateTopNInput, validateWidthInput,
  validateCookieInput, validateRpidInput, loginCapabilities, maskWebhook, askBack, askSecretBack,
};

