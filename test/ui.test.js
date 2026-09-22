'use strict';
/**
 * 交互层测试（node:test，零网络）：选择器按键流 / 取消哨兵 / 校验重问 / 路径展开
 * 通过注入 fake stdin/stdout 驱动，不依赖真实 TTY
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { attach, ask, askValidated, askSecret, startSpinner, select, selectYN, CANCEL } = require('../lib/ui');
const { expandHome, validateUidInput, validateIntervalInput, validateTopNInput, validateWidthInput, validateCookieInput, validateRpidInput, loginCapabilities } = require('../lib/interactive');

function fakeStdin() {
  const s = new EventEmitter();
  s.isRaw = false;
  s.setRawMode = v => { s.isRaw = !!v; };
  s.resume = () => {};
  s.pause = () => {};
  s.setEncoding = () => {};
  return s;
}
function fakeStdout() {
  const buf = [];
  return { isTTY: false, buf, write: s => { buf.push(String(s)); return true; } };
}
const io = () => ({ stdin: fakeStdin(), stdout: fakeStdout() });
const delay = ms => new Promise(r => setTimeout(r, ms));

const OPTS = [
  { key: '1', label: '一', desc: '第一项' },
  { key: '2', label: '二', desc: '第二项' },
  { key: '3', label: '三', desc: '第三项' },
  { key: '0', label: '退出', desc: '' },
];

// ====== select ======
test('select：↓ + 回车选择第二项，结束后恢复 raw 状态', async () => {
  const { stdin, stdout } = io();
  const p = select(OPTS, 0, { stdin, stdout });
  stdin.emit('data', '\x1b[B');
  stdin.emit('data', '\r');
  assert.strictEqual(await p, '2');
  assert.strictEqual(stdin.isRaw, false, '结束后应恢复 raw 状态');
});

test('select：SS3 方向键（\\x1bOB）兼容', async () => {
  const { stdin, stdout } = io();
  const p = select(OPTS, 0, { stdin, stdout });
  stdin.emit('data', '\x1bOB');
  stdin.emit('data', '\x1bOB');
  stdin.emit('data', '\n');
  assert.strictEqual(await p, '3');
});

test('select：数字键直达并确认', async () => {
  const { stdin, stdout } = io();
  const p = select(OPTS, 0, { stdin, stdout });
  stdin.emit('data', '3');
  assert.strictEqual(await p, '3');
});

test('select：Ctrl+C / Ctrl+D 取消返回 CANCEL', async () => {
  for (const key of ['\x03', '\x04']) {
    const { stdin, stdout } = io();
    const p = select(OPTS, 0, { stdin, stdout });
    stdin.emit('data', key);
    assert.strictEqual(await p, CANCEL, `按键 ${JSON.stringify(key)} 应取消`);
  }
});

test('select：单独 Esc（50ms 无后续）取消', async () => {
  const { stdin, stdout } = io();
  const p = select(OPTS, 0, { stdin, stdout });
  stdin.emit('data', '\x1b');
  await delay(80);
  assert.strictEqual(await p, CANCEL);
});

test('select：Esc 后紧接方向键序列不误判为取消', async () => {
  const { stdin, stdout } = io();
  const p = select(OPTS, 0, { stdin, stdout });
  stdin.emit('data', '\x1b');
  stdin.emit('data', '\x1b[B');
  stdin.emit('data', '\r');
  assert.strictEqual(await p, '2');
});

// ====== selectYN ======
test('selectYN：y/n/回车/默认值', async () => {
  {
    const { stdin, stdout } = io();
    const p = selectYN('q', false, { stdin, stdout });
    stdin.emit('data', 'y');
    stdin.emit('data', '\r');
    assert.strictEqual(await p, true);
  }
  {
    const { stdin, stdout } = io();
    const p = selectYN('q', true, { stdin, stdout });
    stdin.emit('data', 'n');
    stdin.emit('data', '\r');
    assert.strictEqual(await p, false);
  }
  {
    const { stdin, stdout } = io();
    const p = selectYN('q', true, { stdin, stdout });
    stdin.emit('data', '\r');
    assert.strictEqual(await p, true, '回车应返回默认值');
  }
});

test('selectYN：← 选是、→ 选否（确定性），空格切换', async () => {
  {
    const { stdin, stdout } = io();
    const p = selectYN('q', false, { stdin, stdout });
    stdin.emit('data', '\x1b[D'); // left → 是
    stdin.emit('data', '\r');
    assert.strictEqual(await p, true);
  }
  {
    const { stdin, stdout } = io();
    const p = selectYN('q', true, { stdin, stdout });
    stdin.emit('data', '\x1b[C'); // right → 否
    stdin.emit('data', '\r');
    assert.strictEqual(await p, false);
  }
  {
    const { stdin, stdout } = io();
    const p = selectYN('q', false, { stdin, stdout });
    stdin.emit('data', ' ');
    stdin.emit('data', '\r');
    assert.strictEqual(await p, true, '空格切换');
  }
});

test('selectYN：Esc 取消返回 CANCEL', async () => {
  const { stdin, stdout } = io();
  const p = selectYN('q', false, { stdin, stdout });
  stdin.emit('data', '\x1b');
  await delay(80);
  assert.strictEqual(await p, CANCEL);
});

// ====== ask / askValidated ======
function fakeRl(answers) {
  const q = [...answers];
  return {
    question: (prompt, cb) => cb(q.shift()),
    once: () => {},
    removeListener: () => {},
  };
}

test('askValidated：非法输入重问，直到合法', async t => {
  t.mock.method(console, 'log', () => {}); // 静音校验错误输出
  attach(fakeRl(['abc', '123abc', '401315430']));
  const v = await askValidated('UID', '', validateUidInput);
  assert.strictEqual(v, '401315430');
  attach(null);
});

test('askValidated：空输入取默认值并校验通过', async () => {
  attach(fakeRl(['']));
  const v = await askValidated('间隔', '60', validateIntervalInput);
  assert.strictEqual(v, '60');
  attach(null);
});

test('ask：SIGINT 取消返回 CANCEL', async () => {
  let handler = null;
  attach({
    question: () => { /* 永不回答，模拟等待中按 Ctrl+C */ },
    once: (ev, fn) => { if (ev === 'SIGINT') handler = fn; },
    removeListener: () => {},
  });
  const p = ask('q', '');
  handler();
  assert.strictEqual(await p, CANCEL);
  attach(null);
});

// ====== 掩码输入 / spinner ======
test('askSecret：掩码显示、退格、回车提交、raw 恢复', async () => {
  attach({ _writeToOutput: () => {}, on: () => {}, removeListener: () => {} });
  const { stdin, stdout } = io();
  const p = askSecret('Cookie', { stdin, stdout });
  stdin.emit('data', 'S');
  stdin.emit('data', 'E');
  stdin.emit('data', '\x7f'); // 退格删除 E
  stdin.emit('data', 'C');
  stdin.emit('data', '\r');
  assert.strictEqual(await p, 'SC');
  const text = stdout.buf.join('');
  assert.ok(text.includes('*'), '应显示掩码');
  assert.ok(!/S[EC]/.test(text), `不应回显原文，实际: ${text}`);
  assert.strictEqual(stdin.isRaw, false, '结束后应恢复 raw');
  attach(null);
});

test('askSecret：Esc/Ctrl+C 取消返回 CANCEL', async () => {
  for (const key of ['\x03', '\x1b']) {
    attach({ _writeToOutput: () => {}, on: () => {}, removeListener: () => {} });
    const { stdin, stdout } = io();
    const p = askSecret('Token', { stdin, stdout });
    stdin.emit('data', key);
    if (key === '\x1b') await delay(80); // 单独 Esc 50ms 判定
    assert.strictEqual(await p, CANCEL, `按键 ${JSON.stringify(key)} 应取消`);
    attach(null);
  }
});

test('startSpinner：非 TTY 为 no-op；TTY 下输出动画帧且 stop 可清除', async () => {
  const noop = startSpinner('x', { stdout: { isTTY: false, write() {} } });
  noop.stop('msg'); // 不应抛错
  const chunks = [];
  const sp = startSpinner('加载中', { stdout: { isTTY: true, write: s => { chunks.push(String(s)); } } });
  await delay(120);
  sp.stop('完成');
  const text = chunks.join('');
  assert.ok(text.includes('\x1b[?25l'), '应隐藏光标');
  assert.ok(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text), '应输出动画帧');
  assert.ok(text.includes('完成'), 'stop 消息应输出');
  assert.ok(text.includes('\x1b[?25h'), '应恢复光标');
});

// ====== 纯函数：路径展开与校验 ======
test('expandHome：~ / ~/ / ~\\ 展开，其余原样', () => {
  assert.strictEqual(expandHome('~'), os.homedir());
  assert.strictEqual(expandHome('~/cards'), path.join(os.homedir(), 'cards'));
  assert.strictEqual(expandHome('~\\cards'), path.join(os.homedir(), 'cards'));
  assert.strictEqual(expandHome('a/b'), 'a/b');
  assert.strictEqual(expandHome(''), '');
  assert.strictEqual(expandHome(null), '');
});

test('validateUidInput / validateIntervalInput / validateTopNInput 边界', () => {
  assert.strictEqual(validateUidInput('401315430'), null);
  assert.ok(validateUidInput('abc'));
  assert.ok(validateUidInput(''));

  assert.strictEqual(validateIntervalInput('10'), null);
  assert.strictEqual(validateIntervalInput('60'), null);
  assert.ok(validateIntervalInput('9'));
  assert.ok(validateIntervalInput('abc'));

  assert.strictEqual(validateTopNInput('1'), null);
  assert.strictEqual(validateTopNInput('50'), null);
  assert.ok(validateTopNInput('0'));
  assert.ok(validateTopNInput('51'));
  assert.ok(validateTopNInput('x'));

  assert.strictEqual(validateWidthInput('340'), null);
  assert.strictEqual(validateWidthInput('1360'), null);
  assert.strictEqual(validateWidthInput('4080'), null);
  assert.ok(validateWidthInput('339'));
  assert.ok(validateWidthInput('4081'));
  assert.ok(validateWidthInput('abc'));

  assert.strictEqual(validateCookieInput('SESSDATA=abc; bili_jct=def'), null);
  assert.ok(validateCookieInput('abc'), '缺少 SESSDATA 应报错');
  assert.ok(validateCookieInput(''));

  assert.strictEqual(validateRpidInput('313406396048'), null);
  assert.strictEqual(validateRpidInput('https://t.bilibili.com/404135596?comment_root_id=313406396048'), null);
  assert.ok(validateRpidInput('abc'));
  assert.ok(validateRpidInput(''));
});

test('loginCapabilities：登录/游客能力矩阵（游客三项均不可用）', () => {
  const full = { autoIdentify: true, fullSubReplies: true, fullAccountTop: true };
  assert.deepStrictEqual(loginCapabilities(true), full);
  assert.deepStrictEqual(loginCapabilities(401315430), full);
  const guest = { autoIdentify: false, fullSubReplies: false, fullAccountTop: false };
  assert.deepStrictEqual(loginCapabilities(false), guest);
  assert.deepStrictEqual(loginCapabilities(''), guest);
  assert.deepStrictEqual(loginCapabilities(undefined), guest);
});
