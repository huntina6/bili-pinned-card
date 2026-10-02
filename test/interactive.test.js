'use strict';
/**
 * 交互步骤状态机测试（node:test，零网络）
 * 覆盖：交互闸门判定 / 模式表 / 登录方式表 / 数字 key 契约 /
 *      draft 隔离（跨轮零残留）/ 「上一步」输入原语 / 多选原语 / 持久化字段
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { attach, multiSelect, CANCEL, BACK } = require('../lib/ui');
const {
  shouldInteract, createDraft, MODES, modeById, modeByKey, defaultModeId,
  loginChoices, pickValue, SECTION_JUMPS, askBack, printSummary,
  needsUid, resolveJump, validateWebhookInput,
} = require('../lib/interactive');

const ROOT = path.resolve(__dirname, '..');

function fakeStdin() {
  const s = new EventEmitter();
  s.isRaw = false;
  s.setRawMode = v => { s.isRaw = !!v; };
  s.resume = () => {};
  s.pause = () => {};
  s.setEncoding = () => {};
  return s;
}
const io = () => ({ stdin: fakeStdin(), stdout: { isTTY: false, write: () => true } });

// ====== 交互闸门 ======
test('shouldInteract：非 TTY / CI / --no-input 一律不引导', () => {
  assert.equal(shouldInteract({}, { stdinTTY: false, stdoutTTY: true, ci: false }), false);
  assert.equal(shouldInteract({}, { stdinTTY: true, stdoutTTY: false, ci: false }), false);
  assert.equal(shouldInteract({}, { stdinTTY: true, stdoutTTY: true, ci: true }), false);
  assert.equal(shouldInteract({ noInput: true }, { stdinTTY: true, stdoutTTY: true }), false);
});

test('shouldInteract：--interactive 可覆盖「已给目标」的默认跳过', () => {
  const env = { stdinTTY: true, stdoutTTY: true, ci: false };
  assert.equal(shouldInteract({ oid: '404135596' }, env), false); // 显式目标 → 默认不引导（脚本可预测）
  assert.equal(shouldInteract({ oid: '404135596', cookie: 'x' }, env), false);
  assert.equal(shouldInteract({ oid: '404135596', interactive: true }, env), true); // 强制进向导补配
  assert.equal(shouldInteract({}, env), true); // 完全无目标参数 → 引导
  assert.equal(shouldInteract({ cookie: 'x' }, env), false); // 已给 Cookie → 视为显式配置
});

// ====== 模式表 ======
test('MODES：key 唯一且连续，desc 可用，key→id 双向可查', () => {
  const keys = MODES.map(m => m.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const m of MODES) {
    assert.equal(typeof m.desc(m => true), 'string');
    assert.equal(modeByKey(m.key), m);
    assert.equal(modeById(m.id), m);
  }
  assert.equal(modeByKey('3').id, 'hot');
  assert.equal(modeByKey('0').id, 'exit');
});

test('MODES：once/hot/manual 三元语义互斥且符合定义', () => {
  const byId = id => MODES.find(m => m.id === id);
  assert.equal(byId('watch').once, false);
  assert.equal(byId('once').once, true);
  assert.equal(byId('hot').hot, true);
  assert.equal(byId('hot').once, true);
  assert.equal(byId('manual').manual, true);
  assert.equal(byId('watch').hot, false);
});

test('defaultModeId：由参数/已保存配置推断默认模式', () => {
  assert.equal(defaultModeId({}, {}), 'watch');
  assert.equal(defaultModeId({ once: true }, {}), 'once');
  assert.equal(defaultModeId({ upTop: 10 }, {}), 'hot');
  assert.equal(defaultModeId({}, { upTop: 5 }), 'hot');
  assert.equal(defaultModeId({ rpid: '123' }, {}), 'manual');
});

// ====== 登录方式表（数字 key 与模式节一致） ======
test('loginChoices：key 为连续数字编号（数字键可直达）', () => {
  const guestList = loginChoices(false, '');
  const loggedList = loginChoices(true, '401315430');
  for (const list of [guestList, loggedList]) {
    assert.deepEqual(list.map(c => c.key), list.map((_, i) => String(i + 1)));
    assert.equal(new Set(list.map(c => c.value)).size, list.length);
  }
  assert.equal(guestList.length, 3);
  assert.equal(loggedList.length, 4);
  assert.equal(pickValue(loggedList, '1'), 'keep');
  assert.equal(pickValue(guestList, '1'), 'scan');
});

// ====== draft 隔离（旧实现的三处防残留补丁已被结构性消除） ======
test('createDraft：一次性字段一律归零，不继承上一轮残留', () => {
  const dirty = {
    uid: '401315430', oid: '404135596', upTop: 20, rpid: '313406396048',
    context: true, force: true, once: true, maxDyns: 30, cookie: 'SESSDATA=x',
    rules: ['抽奖'], notifyEvents: ['new'], scale: 2,
  };
  const d = createDraft(dirty, { lastUpTop: 25, lastMaxDyns: 40 });
  assert.equal(d.upTop, 0);
  assert.equal(d.rpid, '');
  assert.equal(d.context, false);
  assert.equal(d.force, false);
  assert.equal(d.once, false);
  assert.equal(d.maxDyns, Infinity);
  assert.equal(d.uidExplicit, false);
  assert.equal(d._lastUpTop, 25); // 向导预填沿用上次设定
  assert.equal(d._lastMaxDyns, 40);
  assert.equal(d.uid, '401315430');
  assert.equal(d.oid, '404135596');
});

test('createDraft：rules / notifyEvents 为副本，改 draft 不污染原配置', () => {
  const cfg = { rules: ['抽奖'], notifyEvents: ['new'], uid: '1', cookie: '' };
  const d = createDraft(cfg, {});
  d.rules.push('预告');
  d.notifyEvents.push('error');
  assert.deepEqual(cfg.rules, ['抽奖']);
  assert.deepEqual(cfg.notifyEvents, ['new']);
});

test('createDraft：游客（无 Cookie）时 autoIdentify 能力关闭', () => {
  assert.equal(createDraft({ uid: '1', cookie: '' }, {}).cap.autoIdentify, false);
  assert.equal(createDraft({ uid: '1', cookie: 'SESSDATA=x' }, {}).cap.autoIdentify, true);
});

// ====== 「返回修改」段落跳转全部指向真实步骤 ======
test('SECTION_JUMPS：全部指向存在的步骤 id', () => {
  const ids = new Set(['login', 'mode', 'hotN', 'target', 'oid', 'rpid', 'maxDyns', 'monitor', 'notify', 'output', 'confirm']);
  assert.ok(SECTION_JUMPS.length >= 5);
  for (const s of SECTION_JUMPS) assert.ok(ids.has(s.step), `未知步骤: ${s.step}`);
  assert.equal(new Set(SECTION_JUMPS.map(s => s.key)).size, SECTION_JUMPS.length);
});

// ====== 文本输入「上一步」 ======
function fakeRl(answers) {
  const q = [...answers];
  return { question: (prompt, cb) => cb(q.shift()), once: () => {}, removeListener: () => {} };
}

test('askBack：输入 b / back / .. 返回 BACK（校验前拦截）', async () => {
  for (const word of ['b', 'back', '..', ' B ']) {
    attach(fakeRl([word]));
    assert.equal(await askBack('UID', '', v => (/^\d+$/.test(v) ? null : '必须是数字')), BACK);
    attach(null);
  }
});

test('askBack：校验失败重问，合法值原样返回', async t => {
  t.mock.method(console, 'log', () => {});
  attach(fakeRl(['abc', '401315430']));
  assert.equal(await askBack('UID', '', v => (/^\d+$/.test(v) ? null : '必须是数字')), '401315430');
  attach(null);
});

test('askBack：Ctrl+C 穿透为 CANCEL', async () => {
  let handler = null;
  attach({ question: () => {}, once: (ev, fn) => { if (ev === 'SIGINT') handler = fn; }, removeListener: () => {} });
  const p = askBack('UID', '');
  handler();
  assert.equal(await p, CANCEL);
  attach(null);
});

// ====== 多选原语（通知事件订阅） ======
const EVENT_OPTS = [
  { key: '1', label: 'new' }, { key: '2', label: 'unpinned' }, { key: '3', label: 'error' },
];

test('multiSelect：空格反选 + ↓ 移动 + 回车确认，按选项顺序返回', async () => {
  const { stdin, stdout } = io();
  const p = multiSelect(EVENT_OPTS, ['1'], { stdin, stdout });
  stdin.emit('data', ' ');       // 取消勾选 1
  stdin.emit('data', '\x1b[B');  // ↓ → 2
  stdin.emit('data', ' ');       // 勾选 2
  stdin.emit('data', '\r');      // 确认
  assert.deepEqual(await p, ['2']);
});

test('multiSelect：a 全选 / 再按 a 清空', async () => {
  const a = io();
  const p1 = multiSelect(EVENT_OPTS, [], a);
  a.stdin.emit('data', 'a');
  a.stdin.emit('data', '\r');
  assert.deepEqual(await p1, ['1', '2', '3']);

  const b = io();
  const p2 = multiSelect(EVENT_OPTS, ['1', '2', '3'], b);
  b.stdin.emit('data', 'a');
  b.stdin.emit('data', '\r');
  assert.deepEqual(await p2, []);
});

test('multiSelect：← 返回 BACK，Esc 返回 CANCEL', async () => {
  const a = io();
  const p1 = multiSelect(EVENT_OPTS, [], a);
  a.stdin.emit('data', '\x1b[D');
  assert.equal(await p1, BACK);

  const b = io();
  const p2 = multiSelect(EVENT_OPTS, [], b);
  b.stdin.emit('data', '\x1b');
  const done = await Promise.race([p2, new Promise(r => setTimeout(() => r('timeout'), 120))]);
  assert.equal(done, CANCEL);
});

// ====== 持久化字段（子进程隔离 HOME，验证真实落盘内容） ======
test('persistDraft：通知/规则/lastUpTop/lastMaxDyns/emoji 落盘，且不写会误触发的模式键', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-cfg-'));
  try {
    const script = `
      const { createDraft, persistDraft } = require(${JSON.stringify(path.join(ROOT, 'lib/interactive'))});
      const { buildConfig, parseArgs } = require(${JSON.stringify(path.join(ROOT, 'lib/args'))});
      const cfg = buildConfig(parseArgs(['--oid', '404135596']), {});
      const d = createDraft(cfg, {});
      Object.assign(d, {
        upTop: 7, maxDyns: 30, rules: ['抽奖'], ruleMode: 'all',
        notifyWebhook: 'https://example.com/hook', notifyFormat: 'feishu',
        notifyChatId: '', notifyEvents: ['new', 'error'], notifyPrefix: 'UP 名',
        emojiEnabled: false, scale: 2, interval: 60, uidForSave: '401315430',
      });
      persistDraft(d);
    `;
    execFileSync(process.execPath, ['-e', script], { env: { ...process.env, HOME: home, USERPROFILE: home } });
    const saved = JSON.parse(fs.readFileSync(path.join(home, '.bili-pinned-card', 'config.json'), 'utf8'));

    // 新增持久化字段
    assert.equal(saved.emoji, false);
    assert.equal(saved.lastUpTop, 7);
    assert.equal(saved.lastMaxDyns, 30);
    assert.deepEqual(saved.notifyEvents, ['new', 'error']);
    assert.equal(saved.notifyPrefix, 'UP 名');
    assert.deepEqual(saved.rules, ['抽奖']);
    // 不得写入运行时模式键：checkOnce 的 `if (cfg.upTop)` 会被历史值误触发
    assert.equal('upTop' in saved, false);
    assert.equal('maxDyns' in saved, false);
    // rpid 是一次性目标，不落盘（否则下一轮 monitor 误入指定评论分支）
    assert.equal('rpid' in saved, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ====== 汇总页：登录判定与通知事件展示 ======
/** 捕获 printSummary 的终端输出 */
function summaryOf(t, dump) {
  const out = [];
  t.mock.method(console, 'log', (...a) => out.push(a.join(' ')));
  printSummary(dump);
  return out.join('\n');
}
const baseDraft = (over = {}) => ({
  uid: '401315430', oid: '', modeId: 'watch', once: false, interval: 60, upTop: 0, rpid: '',
  force: false, maxDyns: Infinity, trackDyn: false, rules: [], ruleMode: 'any', showReplies: false,
  notifyWebhook: '', notifyFormat: 'generic', notifyEvents: null, notifyPrefix: '',
  scale: 2, outDir: '/tmp/out', cookie: '', ...over,
});

test('printSummary：只有 SESSDATA 的 Cookie 也判定为已登录（能力已放开，展示不得反说游客）', (t) => {
  const text = summaryOf(t, baseDraft({ cookie: 'SESSDATA=abc; bili_jct=def' }));
  assert.match(text, /已登录/);
  assert.doesNotMatch(text, /游客/);
  assert.doesNotMatch(text, /无 UID 自动识别/);
});

test('printSummary：无 Cookie 时显示游客与能力限制', (t) => {
  const text = summaryOf(t, baseDraft({ cookie: '' }));
  assert.match(text, /游客（仅指定动态）/);
  assert.match(text, /无 UID 自动识别 · 无全账号热评 · 子回复仅第一页/);
});

test('printSummary：通知事件「全不选」明确显示不推送任何事件', (t) => {
  const none = summaryOf(t, baseDraft({ notifyWebhook: 'https://example.com/hook', notifyEvents: [] }));
  assert.match(none, /不推送任何事件/);
  const all = summaryOf(t, baseDraft({ notifyWebhook: 'https://example.com/hook', notifyEvents: null }));
  assert.match(all, /new,unpinned,dyn-update,up-top,error/);
});

// ====== 交互向导：按需提问与人类逻辑（真实状态机驱动，零网络）======
/** 在子进程里用脚本化答案驱动 runWizard，返回 { trace, action, draft }（链接解析打桩） */
function wizardTrace(spec, home) {
  const script = `
    const ROOT = ${JSON.stringify(ROOT)};
    const ui = require(ROOT + '/lib/ui');
    const spec = JSON.parse(process.env.WIZ_SPEC);
    const q = { select: [...spec.select], yn: [...spec.yn], ask: [...spec.ask], multi: [...(spec.multi || [])] };
    const trace = [];
    ui.section = t => trace.push(typeof t === 'function' ? String(t({})) : String(t));
    ui.select = async () => q.select.shift();
    ui.selectYN = async () => q.yn.shift();
    ui.ask = async () => (q.ask.length ? q.ask.shift() : '');
    ui.askSecret = async () => '';
    ui.multiSelect = async () => q.multi.shift();
    ui.startSpinner = () => ({ stop() {}, fail() {} });
    ui.attach = () => {};
    // 本用例只验证状态机流程：桩掉链接解析（不联网）
    const apiPath = require.resolve(ROOT + '/lib/api');
    require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true,
      exports: { resolveCommentOid: async () => ({ oid: '407750907', type: 11 }), extractId: v => String(v).replace(/\\D/g, '') } };
    const { buildConfig, parseArgs } = require(ROOT + '/lib/args');
    const { createDraft, runWizard } = require(ROOT + '/lib/interactive');
    (async () => {
      const argv = spec.argv || [];
      const saved = spec.saved || {};
      const cfg = buildConfig(parseArgs(argv), saved);
      const draft = createDraft(cfg, saved);
      const res = await runWizard(draft, { args: parseArgs(argv), saved });
      console.log('__RESULT__' + JSON.stringify({
        trace, action: res.action,
        draft: { uid: draft.uid, uidExplicit: draft.uidExplicit, oid: draft.oid, rpid: draft.rpid,
          dryRun: draft.dryRun, modeId: draft.modeId, once: draft.once },
      }));
    })();
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    // HOME 供 POSIX；USERPROFILE 供 Windows（os.homedir() 在 Windows 读 USERPROFILE），
    // 否则子进程的 persistDraft 会写到 CI runner 的真实用户目录
    env: { ...process.env, HOME: home, USERPROFILE: home, WIZ_SPEC: JSON.stringify(spec) },
  });
  const line = out.split('\n').find(l => l.startsWith('__RESULT__'));
  assert.ok(line, '子进程未返回结果：' + out);
  return JSON.parse(line.slice('__RESULT__'.length));
}

test('needsUid：只有「没给动态目标」时才需要问 UP 主（游客/指定评论不问）', () => {
  const cap = { autoIdentify: true };
  assert.strictEqual(needsUid({ modeId: 'watch', oid: '', cap }), true, '没动态 → 必须知道盯哪个 UP');
  assert.strictEqual(needsUid({ modeId: 'once', oid: '', cap }), true);
  assert.strictEqual(needsUid({ modeId: 'hot', oid: '', cap }), true, '热评留空 → 全账号检索需要 UP');
  assert.strictEqual(needsUid({ modeId: 'watch', oid: '407750907', cap }), false, '给了动态 → UP 身份来自动态');
  assert.strictEqual(needsUid({ modeId: 'hot', oid: '407750907', cap }), false);
  assert.strictEqual(needsUid({ modeId: 'manual', oid: '', cap }), false, '指定评论出图 → UP 自动识别');
  assert.strictEqual(needsUid({ modeId: 'watch', oid: '', cap: { autoIdentify: false } }), false, '游客问了也没用');
});

test('resolveJump：「返回修改」跳到被当前模式跳过的段落时顺延到下一个可执行步骤', () => {
  const ctx = { args: {} };
  const hot = { modeId: 'hot', oid: '1', cap: { autoIdentify: true } };
  const watch = { modeId: 'watch', oid: '1', cap: { autoIdentify: true } };
  assert.strictEqual(resolveJump('monitor', watch, ctx), 'monitor', '监控模式可直接进「监控行为」');
  assert.strictEqual(resolveJump('monitor', hot, ctx), 'notify', '热评模式没有「监控行为」→ 顺延到通知推送');
  assert.strictEqual(resolveJump('oid', hot, ctx), 'oid');
  assert.strictEqual(resolveJump('不存在的段落', hot, ctx), 'confirm');
});

test('validateWebhookInput：留空=关闭推送，非 http(s) 直接拦下（避免运行期静默失败）', () => {
  assert.strictEqual(validateWebhookInput(''), null);
  assert.strictEqual(validateWebhookInput('   '), null);
  assert.strictEqual(validateWebhookInput('https://open.feishu.cn/open-apis/bot/v2/hook/x'), null);
  assert.strictEqual(validateWebhookInput('http://127.0.0.1:8080/hook'), null);
  assert.match(validateWebhookInput('open.feishu.cn/hook'), /http/);
  assert.match(validateWebhookInput('ftp://x'), /http/);
});

test('向导实测：游客 + 单次 + 给了动态 → 不问 UP 主，且可勾选「先试跑」', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-wiz-'));
  try {
    const r = wizardTrace({
      saved: {},
      select: ['3', '2', '2', '2'],                     // 游客 / 单次检查 / 分辨率 2x / 汇总页「仅保存不运行」
      yn: [false, false, false, true, true, false],     // 追踪?否 精彩回复?否 强制?否 emoji?是 试跑?是 详细日志?否
      ask: ['https://www.bilibili.com/opus/1232243387332034584', '', '', '/tmp/out', ''],
    }, home);
    assert.deepStrictEqual(r.trace, ['登录状态', '运行模式', '动态目标', '监控行为', '通知推送', '卡片与输出', '确认']);
    assert.strictEqual(r.draft.uid, '', '游客须清空 UID（否则会按默认账号筛选 UP 互动）');
    assert.strictEqual(r.draft.dryRun, true, '向导里可勾选先试跑');
    assert.strictEqual(r.action, 'save-only');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('向导实测：已登录 + 持续监控 + 没给动态 → 才追问 UP 主，并支持粘空间链接', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-wiz-'));
  try {
    const r = wizardTrace({
      saved: { cookie: 'SESSDATA=x; bili_jct=y' },
      select: ['1', '1', '2', '2'],                     // 沿用登录 / 持续监控 / 2x / 仅保存
      yn: [false, false, false, true, false, false],    // 追踪?否 精彩回复?否 强制?否 emoji?是 试跑?否 详细日志?否
      ask: ['', 'https://space.bilibili.com/401315430', '60', '', '', '/tmp/out', ''],
    }, home);
    assert.ok(r.trace.includes('目标 UP 主'), '留空动态时应追问 UP 主');
    assert.strictEqual(r.draft.uid, '401315430', '空间链接自动取 UID');
    assert.strictEqual(r.draft.uidExplicit, true);
    assert.strictEqual(r.draft.dryRun, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('向导实测：已登录 + 指定评论出图 → 不问 UP 主（UP 由动态自动识别）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-wiz-'));
  try {
    const r = wizardTrace({
      saved: { cookie: 'SESSDATA=x; bili_jct=y' },
      select: ['1', '4', '2', '2'],            // 沿用登录 / 指定评论出图 / 2x / 仅保存
      yn: [true, true, false, false],          // 互动回顾?是 emoji?是 试跑?否 详细日志?否
      ask: ['https://t.bilibili.com/407750907?comment_root_id=319181633760', '319181633760', '', '', '', '/tmp/out', ''],
    }, home);
    assert.ok(!r.trace.includes('目标 UP 主'), '指定评论出图不该问 UP 主');
    assert.strictEqual(r.draft.rpid, '319181633760');
    assert.strictEqual(r.draft.modeId, 'manual');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
