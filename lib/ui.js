'use strict';
/** 终端样式与交互（颜色/日志/横幅/对齐/ask/选择器）；rl 由 cli.js 通过 attach() 注入 */

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
${boxLine(C.dim('全平台独立版 · 无需浏览器 · 无需登录'))}
${boxBorder('╚', '╝')}
`;
}

// ====== 交互提示（rl 由 cli.js attach 注入，避免模块级 readline 耦合） ======
let _rl = null;
function attach(rl) { _rl = rl; }

function ask(question, def) {
  return new Promise(resolve => {
    const suffix = def !== undefined && def !== '' ? C.dim(` [${def}]`) : '';
    _rl.question(`${C.bold(C.pink('➤'))} ${C.cyan(question)}${suffix} `, ans => {
      const v = ans.trim();
      resolve(v === '' ? def : v);
    });
  });
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
 * 方向键选择器：↑/↓ 移动高亮光标，回车确认
 * @param {Array<{key:string, label:string, desc?:string}>} options
 * @param {number} defaultIndex 初始高亮位置
 * @returns {Promise<string>} 选中项的 key
 */
function select(options, defaultIndex = 0, io = { stdin: process.stdin, stdout: process.stdout }) {
  return new Promise(resolve => {
    const stdin = io.stdin;
    const stdout = io.stdout;
    let idx = Math.min(Math.max(defaultIndex, 0), options.length - 1);
    const line = i => (i === idx
      ? `  ${C.bold(C.pink('❯'))} ${C.bold(options[i].label)}${options[i].desc ? `  ${C.dim(options[i].desc)}` : ''}`
      : `    ${C.dim(options[i].label)}${options[i].desc ? `  ${C.dim(options[i].desc)}` : ''}`);
    const render = () => {
      stdout.write(`\x1b[${options.length}A`); // 光标回到选项区顶部
      for (let i = 0; i < options.length; i++) {
        stdout.write(`\x1b[2K${line(i)}\n`);   // 清行并重绘
      }
    };
    for (let i = 0; i < options.length; i++) stdout.write(`${line(i)}\n`);
    const cleanup = () => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(wasRaw); } catch { /* noop */ }
      // 注意：不能 pause stdin——readline 后续 rl.question 依赖 data 事件继续流动
    };
    const onData = ch => {
      if (ch === '\r' || ch === '\n') {
        cleanup();
        stdout.write('\n');
        resolve(options[idx].key);
      } else if (ch === '\x1b[A') {            // ↑
        idx = (idx - 1 + options.length) % options.length;
        render();
      } else if (ch === '\x1b[B') {            // ↓
        idx = (idx + 1) % options.length;
        render();
      }
    };
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}
/**
 * 横排 是/否 选择器：←/→（或 ↑/↓、空格）切换，回车确认
 * @param {string} question 提问文本
 * @param {boolean} def 默认值
 * @returns {Promise<boolean>}
 */
function selectYN(question, def = false, io = { stdin: process.stdin, stdout: process.stdout }) {
  return new Promise(resolve => {
    const stdin = io.stdin;
    const stdout = io.stdout;
    let yes = !!def;
    const render = () => {
      const yesTxt = yes ? `${C.bold(C.pink('❯ 是'))}` : C.dim('  是');
      const noTxt = yes ? C.dim('  否') : `${C.bold(C.pink('❯ 否'))}`;
      stdout.write(`\x1b[2K${C.bold(C.pink('➤'))} ${C.cyan(question)}  ${yesTxt}  ${noTxt}\r`);
    };
    render();
    const cleanup = () => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(wasRaw); } catch { /* noop */ }
      // 注意：不能 pause stdin——readline 后续 rl.question 依赖 data 事件继续流动
      stdout.write('\n');
    };
    const onData = ch => {
      if (ch === '\r' || ch === '\n') {
        cleanup();
        resolve(yes);
      } else if (ch === 'y' || ch === 'Y' || ch === '\x1b[C' || ch === '\x1b[B' || ch === ' ') {
        if (ch === 'y' || ch === 'Y') yes = true;
        else yes = !yes;
        render();
      } else if (ch === 'n' || ch === 'N' || ch === '\x1b[D' || ch === '\x1b[A') {
        if (ch === 'n' || ch === 'N') yes = false;
        else yes = !yes;
        render();
      }
    };
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

module.exports = {
  useColor, C, ts, log, stripAnsi, displayWidth, BOX_W, boxBorder, boxLine,
  makeBanner, attach, ask, section, summaryRow, select, selectYN,
};
