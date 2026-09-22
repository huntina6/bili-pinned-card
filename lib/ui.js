'use strict';
/** 终端样式与交互（颜色/日志/横幅/对齐/ask/选择器）；rl 由 cli.js 通过 attach() 注入 */
const logger = require('./logger'); // 文件日志（终端输出的落盘旁路）

// ====== 终端样式 ======
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  dim: s => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  cyan: s => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  green: s => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: s => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: s => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  bold: s => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  pink: s => (useColor ? `\x1b[38;5;204m${s}\x1b[0m` : s),
};

function ts() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
  logger.info(`[${ts()}] ${msg}`); // 同步落盘（quiet 模式终端静默，文件仍记录，便于排障）
}

// ====== 终端对齐工具（CJK 全角按 2 列宽，避免横幅/表格歪斜） ======
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}
/** 终端显示宽度：CJK/全角=2 列，其余=1 列；ANSI 颜色转义不计宽 */
function displayWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x2ffff)) w += 2;
    else w += 1;
  }
  return w;
}

const BOX_W = 44; // 横幅内容区宽度（显示列）
const boxBorder = (left, right) => `${left}${'═'.repeat(BOX_W)}${right}`;
const boxLine = text => {
  const pad = Math.max(0, BOX_W - displayWidth(text) - 4);
  return `║  ${text}${' '.repeat(pad)}  ║`;
};

/** 启动横幅（版本号由调用方传入，保持 ui 无版本耦合） */
function makeBanner(version) {
  return `
${boxBorder('╔', '╗')}
${boxLine(`${C.bold(C.pink('B站 置顶评论监测 · 自动出图'))} v${version}`)}
${boxLine(C.dim('全平台独立版 · 零浏览器依赖 · 扫码登录可选'))}
${boxBorder('╚', '╝')}
`;
}

// ====== 交互提示（rl 由 cli.js attach 注入，避免模块级 readline 耦合） ======
let _rl = null;
function attach(rl) { _rl = rl; }

/** 用户取消（Ctrl+C / Ctrl+D / Esc / SIGINT）哨兵；与普通返回值类型区分 */
const CANCEL = Symbol('bpc.cancel');

/** 活跃提示的清理栈：SIGINT 可能在数据回调前触发，需外部统一恢复终端状态 */
const _activeCleanups = new Set();
/** 恢复所有活跃中的选择器（光标/raw/监听器）；用于 SIGINT 兜底 */
function cancelActivePrompts() {
  for (const fn of [..._activeCleanups]) {
    try { fn(); } catch { /* 忽略 */ }
  }
  _activeCleanups.clear();
}

/**
 * 统一键序列读取：兼容 CSI（\x1b[A）与 SS3（\x1bOA）方向键、分块到达的 ESC 序列；
 * 单独 Esc 在 50ms 内无后续字符时判定为取消（参考 clack escapeCodeTimeout）
 * @param {any} stdin
 * @param {(key: string) => void} onKey key ∈ up/down/left/right/enter/space/cancel/单个字符
 * @returns {() => void} 停止监听
 */
function readKeys(stdin, onKey) {
  let buf = '';
  let escTimer = null;
  const onData = chunk => {
    if (escTimer) { clearTimeout(escTimer); escTimer = null; }
    buf += chunk;
    for (;;) {
      if (!buf) break;
      const seq = buf.slice(0, 3);
      if (seq === '\x1b[A' || seq === '\x1bOA') { buf = buf.slice(3); onKey('up'); continue; }
      if (seq === '\x1b[B' || seq === '\x1bOB') { buf = buf.slice(3); onKey('down'); continue; }
      if (seq === '\x1b[C' || seq === '\x1bOC') { buf = buf.slice(3); onKey('right'); continue; }
      if (seq === '\x1b[D' || seq === '\x1bOD') { buf = buf.slice(3); onKey('left'); continue; }
      const ch = buf[0];
      if (ch === '\x1b') {
        if (buf.length === 1) {
          escTimer = setTimeout(() => {
            escTimer = null;
            const s = buf; buf = '';
            if (s === '\x1b') onKey('cancel');
          }, 50);
          return;
        }
        const nextEsc = buf.indexOf('\x1b', 1); // 未知序列（Home/End 等）：整体丢弃
        buf = nextEsc === -1 ? '' : buf.slice(nextEsc);
        continue;
      }
      buf = buf.slice(1);
      if (ch === '\r' || ch === '\n') onKey('enter');
      else if (ch === '\x03' || ch === '\x04') onKey('cancel');
      else if (ch === '\x7f' || ch === '\x08') onKey('backspace');
      else if (ch === ' ') onKey('space');
      else onKey(ch);
    }
  };
  stdin.on('data', onData);
  return () => {
    if (escTimer) { clearTimeout(escTimer); escTimer = null; }
    stdin.removeListener('data', onData);
  };
}

function ask(question, def) {
  return new Promise(resolve => {
    if (!_rl) { resolve(CANCEL); return; }
    const suffix = def !== undefined && def !== '' ? C.dim(` [${def}]`) : '';
    const onSigint = () => { _rl.removeListener('SIGINT', onSigint); resolve(CANCEL); };
    _rl.once('SIGINT', onSigint);
    _rl.question(`${C.bold(C.pink('❯'))} ${C.cyan(question)}${suffix} `, ans => {
      _rl.removeListener('SIGINT', onSigint);
      const v = ans.trim();
      resolve(v === '' ? def : v);
    });
  });
}

/** 带校验的 ask：非法输入就地报错并重问，直到合法或取消（返回 CANCEL） */
async function askValidated(question, def, validate) {
  for (;;) {
    const v = await ask(question, def);
    if (v === CANCEL) return CANCEL;
    const err = validate ? validate(v) : null;
    if (!err) return v;
    console.log(`  ${C.red(`✗ ${err}`)}`);
  }
}

/**
 * 掩码输入（密码/Cookie 等敏感值）：不回显原文，仅逐字符显示 *；Ctrl+C/Esc 取消返回 CANCEL
 * 实现要点：raw 模式自绘提示行，并临时屏蔽 readline 回显
 * @param {string} question 提问文本
 * @returns {Promise<string|typeof CANCEL>}
 */
function askSecret(question, io = { stdin: process.stdin, stdout: process.stdout }) {
  return new Promise(resolve => {
    if (!_rl) { resolve(CANCEL); return; }
    const stdin = io.stdin;
    const stdout = io.stdout;
    const tty = !!stdout.isTTY;
    let value = '';
    let done = false;
    const prompt = `${C.bold(C.pink('❯'))} ${C.cyan(question)} `;
    const render = () => { stdout.write(`\x1b[2K\r${prompt}${C.pink('*'.repeat(value.length))}`); };
    const origWrite = _rl._writeToOutput;
    _rl._writeToOutput = () => { /* 屏蔽 readline 回显 */ };
    const noopSigint = () => { /* noop */ };
    _rl.on('SIGINT', noopSigint);
    const stopKeys = readKeys(stdin, key => {
      if (key === 'enter') finish(value);
      else if (key === 'cancel') finish(CANCEL);
      else if (key === 'backspace') { value = value.slice(0, -1); render(); }
      else if (key === 'space') { value += ' '; render(); }
      else if (key.length === 1 && key >= ' ') { value += key; render(); }
    });
    const cleanup = () => {
      stopKeys();
      _rl._writeToOutput = origWrite;
      _rl.removeListener('SIGINT', noopSigint);
      if (tty) stdout.write('\x1b[?25h');
      try { stdin.setRawMode(wasRaw); } catch { /* noop */ }
      _activeCleanups.delete(cleanup);
    };
    function finish(v) {
      if (done) return;
      done = true;
      cleanup();
      stdout.write('\n');
      resolve(v);
    }
    const wasRaw = stdin.isRaw;
    _activeCleanups.add(cleanup);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    if (tty) stdout.write('\x1b[?25l');
    render();
  });
}

/**
 * 终端加载动画（零依赖 ora 风格）：仅在 TTY 下渲染，返回 { stop, fail } 均会清除动画
 * @param {string} text 提示文本
 * @returns {{stop: (msg?: string) => void, fail: (msg?: string) => void}}
 */
function startSpinner(text, io = { stdout: process.stdout }) {
  const stdout = io.stdout;
  if (!stdout.isTTY) return { stop: () => {}, fail: () => {} };
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  stdout.write('\x1b[?25l');
  const timer = setInterval(() => {
    stdout.write(`\x1b[2K\r${C.pink(frames[i = (i + 1) % frames.length])} ${C.dim(text)}`);
  }, 80);
  const clear = () => { clearInterval(timer); stdout.write('\x1b[2K\r\x1b[?25h'); };
  return {
    stop: msg => { clear(); if (msg) stdout.write(`${msg}\n`); },
    fail: msg => { clear(); if (msg) stdout.write(`${msg}\n`); },
  };
}

/** 掩码输入 + 校验重问（敏感值，不回显原文） */
async function askSecretValidated(question, validate) {
  for (;;) {
    const v = await askSecret(question);
    if (v === CANCEL) return CANCEL;
    const err = validate ? validate(v) : null;
    if (!err) return v;
    console.log(`  ${C.red(`✗ ${err}`)}`);
  }
}
/** 交互分区标题：┌─ 标题 ─────────────────┐ */
function section(title) {
  const fill = '─'.repeat(Math.max(2, BOX_W - displayWidth(title) - 4));
  console.log(`\n${C.pink('┌─ ')}${C.bold(title)}${C.pink(` ${fill}┐`)}`);
}
/** 交互完成汇总行（带键值对齐） */
function summaryRow(k, v) {
  console.log(`  ${C.dim(k.padEnd(4))}${C.bold(String(v))}`);
}
/**
 * 方向键选择器：↑/↓ 移动高亮光标，回车确认；数字键（选项 key 为单个数字时）直达；
 * Ctrl+C / Ctrl+D / Esc 取消并返回 CANCEL
 * @param {Array<{key:string, label:string, desc?:string}>} options
 * @param {number} defaultIndex 初始高亮位置
 * @returns {Promise<string|typeof CANCEL>} 选中项的 key 或 CANCEL
 */
function select(options, defaultIndex = 0, io = { stdin: process.stdin, stdout: process.stdout }) {
  return new Promise(resolve => {
    const stdin = io.stdin;
    const stdout = io.stdout;
    const tty = !!stdout.isTTY;
    let idx = Math.min(Math.max(defaultIndex, 0), options.length - 1);
    let done = false;
    const isNumKey = k => /^\d$/.test(k);
    const line = i => {
      const num = isNumKey(options[i].key) ? C.dim(`${options[i].key}) `) : '   ';
      return i === idx
        ? `  ${C.bold(C.pink('❯'))} ${num}${C.bold(options[i].label)}${options[i].desc ? `  ${C.dim(options[i].desc)}` : ''}`
        : `     ${num}${C.dim(options[i].label)}${options[i].desc ? `  ${C.dim(options[i].desc)}` : ''}`;
    };
    const render = () => {
      stdout.write(`\x1b[${options.length}A`); // 光标回到选项区顶部
      for (let i = 0; i < options.length; i++) {
        stdout.write(`\x1b[2K${line(i)}\n`);   // 清行并重绘
      }
    };
    for (let i = 0; i < options.length; i++) stdout.write(`${line(i)}\n`);
    // 存在监听即可阻止 readline 收到 Ctrl+C 时自行 close；取消由 readKeys / 外部 SIGINT 处理
    const noopSigint = () => { /* noop */ };
    if (_rl) _rl.on('SIGINT', noopSigint);
    const stopKeys = readKeys(stdin, key => {
      if (key === 'up') { idx = (idx - 1 + options.length) % options.length; render(); }
      else if (key === 'down') { idx = (idx + 1) % options.length; render(); }
      else if (key === 'enter') finish(options[idx].key);
      else if (key === 'cancel') finish(CANCEL);
      else if (isNumKey(key)) {
        const hit = options.findIndex(o => o.key === key);
        if (hit >= 0) { idx = hit; render(); finish(options[hit].key); }
      }
    });
    const cleanup = () => {
      stopKeys();
      if (_rl) _rl.removeListener('SIGINT', noopSigint);
      if (tty) stdout.write('\x1b[?25h'); // 恢复光标
      try { stdin.setRawMode(wasRaw); } catch { /* noop */ }
      // 注意：不能 pause stdin——readline 后续 rl.question 依赖 data 事件继续流动
      _activeCleanups.delete(cleanup);
    };
    function finish(key) {
      if (done) return;
      done = true;
      cleanup();
      stdout.write('\n');
      resolve(key);
    }
    const wasRaw = stdin.isRaw;
    _activeCleanups.add(cleanup);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    if (tty) stdout.write('\x1b[?25l'); // 选择期间隐藏光标
  });
}
/**
 * 横排 是/否 选择器：←/→（或 ↑/↓、空格、y/n）切换，回车确认；Ctrl+C / Ctrl+D / Esc 取消返回 CANCEL
 * 设计语言：行首单个 ❯ 表示「当前提问行」，选中项以加粗粉色高亮（不再叠加第二个 ❯）
 * @param {string} question 提问文本
 * @param {boolean} def 默认值
 * @returns {Promise<boolean|typeof CANCEL>}
 */
function selectYN(question, def = false, io = { stdin: process.stdin, stdout: process.stdout }) {
  return new Promise(resolve => {
    const stdin = io.stdin;
    const stdout = io.stdout;
    const tty = !!stdout.isTTY;
    let yes = !!def;
    let done = false;
    // 是/否 等宽渲染：选中=加粗粉色，未选中=灰色；无色环境用 [x] 标记选中
    const yn = v => {
      const active = (v === '是') === yes;
      if (!useColor) return active ? `[${v}]` : ` ${v} `;
      return active ? C.bold(C.pink(v)) : C.dim(v);
    };
    const render = () => {
      stdout.write(`\x1b[2K${C.bold(C.pink('❯'))} ${C.cyan(question)}  ${yn('是')}  ${yn('否')}\r`);
    };
    render();
    const noopSigint = () => { /* noop */ };
    if (_rl) _rl.on('SIGINT', noopSigint);
    const stopKeys = readKeys(stdin, key => {
      if (key === 'enter') finish(yes);
      else if (key === 'cancel') finish(CANCEL);
      else if (key === 'y' || key === 'Y') { yes = true; render(); }
      else if (key === 'n' || key === 'N') { yes = false; render(); }
      else if (key === 'left') { yes = true; render(); }
      else if (key === 'right') { yes = false; render(); }
      else if (key === 'up' || key === 'down' || key === 'space') { yes = !yes; render(); }
    });
    const cleanup = () => {
      stopKeys();
      if (_rl) _rl.removeListener('SIGINT', noopSigint);
      if (tty) stdout.write('\x1b[?25h'); // 恢复光标
      try { stdin.setRawMode(wasRaw); } catch { /* noop */ }
      // 注意：不能 pause stdin——readline 后续 rl.question 依赖 data 事件继续流动
      stdout.write('\n');
      _activeCleanups.delete(cleanup);
    };
    function finish(v) {
      if (done) return;
      done = true;
      cleanup();
      resolve(v);
    }
    const wasRaw = stdin.isRaw;
    _activeCleanups.add(cleanup);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    if (tty) stdout.write('\x1b[?25l'); // 选择期间隐藏光标
  });
}

module.exports = {
  useColor, C, ts, log, stripAnsi, displayWidth, BOX_W, boxBorder, boxLine,
  makeBanner, attach, ask, askValidated, askSecret, askSecretValidated, startSpinner, CANCEL, cancelActivePrompts, readKeys,
  section, summaryRow, select, selectYN,
};
