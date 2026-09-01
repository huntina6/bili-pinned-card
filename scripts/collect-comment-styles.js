'use strict';
/**
 * 采集 B站 Opus 页面评论区真实布局（CDP 直连 Edge 调试端口，零依赖）
 * 用法: node scripts/collect-comment-styles.js [oid]
 * 输出: output/comment-styles.json（source: "live" | "reference"）+ output/comment-styles.png（截图）
 */
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[3] || '9223', 10); // 默认 9223（全新 profile 调试实例）
const oid = process.argv[2] || '404135596';
const URL = `https://t.bilibili.com/${oid}`;
const OUT = path.join(__dirname, '..', 'output');

let ws = null;
let msgId = 0;
const pending = new Map();

function connect(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    ws.onopen = () => resolve();
    ws.onerror = e => reject(new Error('WebSocket 连接失败: ' + (e.message || e)));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    };
  });
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 在页面执行 JS（返回 JSON 解析后的值） */
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result?.value;
}

/** 等待页面 readyState 完成 */
async function waitLoaded(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const st = await evalJs('document.readyState');
      if (st === 'complete') return;
    } catch { /* 页面可能还在导航 */ }
    await sleep(800);
  }
  throw new Error('页面加载超时');
}

/** 阶段 A：探测评论区候选节点（防 B站 改版） */
const PROBE_JS = `(() => {
  const out = new Set();
  document.querySelectorAll('*').forEach(el => {
    const c = String(el.className || '');
    if (/reply|comment|sub-reply|uname|content|time|like|input/i.test(c)) {
      const r = el.getBoundingClientRect();
      if (r.width > 10 && r.height > 10) out.add(el.tagName + '.' + c.trim().split(/\\s+/).join('.'));
    }
  });
  return JSON.stringify([...out].slice(0, 40));
})()`;

/** 阶段 B：采集评论元素计算样式 */
const COLLECT_JS = `(() => {
  const g = el => el ? (s => ({ fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight,
    lineHeight: s.lineHeight, color: s.color, letterSpacing: s.letterSpacing }))(getComputedStyle(el)) : null;
  const root = document.querySelector('.root-reply') || document.querySelector('.reply-item') || document.querySelector('.list-item');
  const sub  = document.querySelector('.sub-reply-item') || document.querySelector('.sub-reply-list .reply-item');
  const inp  = document.querySelector('.reply-input') || document.querySelector('textarea[placeholder]');
  const pick = (scope, ...sels) => { if (!scope) return null; for (const s of sels) { const el = scope.querySelector(s); if (el) return el; } return null; };
  const doc = document;
  return JSON.stringify({
    url: location.href,
    rootBody: g(pick(root, '.reply-content', '[class*="content"]', '.root-reply-container')),
    subBody: g(pick(sub, '.reply-content', '[class*="content"]')),
    userName: g(pick(root, '.reply-uname', '[class*="uname"]', '.user-name', '.name')),
    meta: g(pick(root, '.reply-time', '[class*="time"]', '.reply-info')),
    likeBtn: g(doc.querySelector('.reply-like') || doc.querySelector('[class*="like"]') || null),
    inputPh: g(inp),
    nodes: { root: !!root, sub: !!sub, input: !!inp },
  }, null, 2);
})()`;

const SCROLL_JS = `(async () => {
  const before = document.querySelectorAll('[class*="reply"], [class*="comment"]').length;
  window.scrollTo(0, document.body.scrollHeight);
  return before;
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // 1. 找/建标签页（用 127.0.0.1：Node 解析 localhost 可能走 IPv6 ::1，Edge 仅监听 IPv4）
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  let target = list.find(t => t.type === 'page' && t.url === URL) || list.find(t => t.type === 'page');
  if (!target) {
    const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`, { method: 'PUT' })).json();
    target = created;
  }
  console.log('目标标签页:', target.url || URL);
  await connect(target.webSocketDebuggerUrl);
  await send('Page.enable');
  await send('Runtime.enable');

  // 2. 导航到目标页
  await send('Page.navigate', { url: URL });
  await waitLoaded();
  await sleep(3000); // 等首屏渲染

  // 3. 阶段 A：探测
  let probe = [];
  try { probe = JSON.parse(await evalJs(PROBE_JS)); } catch { probe = []; }
  console.log('—— 阶段A 探测候选节点 ——');
  probe.forEach(c => console.log('  ' + c));

  const hit = probe.some(c => /root-reply|reply-item|sub-reply|reply-content/i.test(c));
  if (!hit) console.log('⚠ 未命中评论区节点（可能需登录/风控/改版），尝试滚动后重探...');

  // 4. 滚动破懒加载（最多 12 轮，节点数不再增长即停）
  let last = -1, stable = 0;
  for (let i = 0; i < 12; i++) {
    const before = await evalJs(SCROLL_JS).catch(() => 0);
    await sleep(1200);
    const now = await evalJs(`document.querySelectorAll('[class*="reply"], [class*="comment"]').length`).catch(() => 0);
    console.log(`  滚动 ${i + 1}/12: 评论相关节点 ${now}`);
    if (now === before) stable++;
    else stable = 0;
    if (stable >= 3) break;
    last = now;
  }

  // 5. 阶段 B：采集
  let data = null;
  try { data = JSON.parse(await evalJs(COLLECT_JS)); } catch (e) { console.log('采集 JS 异常:', e.message); }
  if (!data || !data.rootBody) {
    // 降级：使用 B站 通用参考值
    console.log('⚠ 采集失败，降级为参考值（source: reference）');
    data = {
      url: URL,
      source: 'reference',
      rootBody: { fontFamily: "'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, 'Hiragino Sans GB', 'Heiti SC', 'Malgun Gothic'", fontSize: '14px', fontWeight: '500', lineHeight: '1.6', color: '#18191C', letterSpacing: 'normal' },
      subBody: { fontFamily: "same", fontSize: '13px', fontWeight: '500', lineHeight: '1.6', color: '#18191C', letterSpacing: 'normal' },
      userName: { fontFamily: "same", fontSize: '13px', fontWeight: '500', lineHeight: 'normal', color: '#61666D', letterSpacing: 'normal' },
      meta: { fontFamily: "same", fontSize: '12px', fontWeight: '400', lineHeight: 'normal', color: '#9499A0', letterSpacing: 'normal' },
      likeBtn: { fontFamily: "same", fontSize: '12px', fontWeight: '400', lineHeight: 'normal', color: '#9499A0', letterSpacing: 'normal' },
      inputPh: { fontFamily: "same", fontSize: '14px', fontWeight: '400', lineHeight: 'normal', color: '#9499A0', letterSpacing: 'normal' },
      nodes: { root: false, sub: false, input: false },
    };
  } else {
    data.source = 'live';
  }

  // 6. 截图留档
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'comment-styles.png'), Buffer.from(shot.data, 'base64'));
    console.log('截图已保存: output/comment-styles.png');
  } catch { /* 截图失败不阻塞 */ }

  fs.writeFileSync(path.join(OUT, 'comment-styles.json'), JSON.stringify(data, null, 2));
  console.log('采集结果已保存: output/comment-styles.json (source: ' + data.source + ')');
  console.log('—— 采集结果 ——');
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'fontSize' in v) {
      console.log(`  ${k.padEnd(10)} ${v.fontSize} / ${v.fontWeight} / ${v.color} / ${String(v.fontFamily).slice(0, 60)}`);
    }
  }
  ws.close();
  process.exit(0);
})().catch(e => { console.error('采集失败:', e.message); process.exit(1); });
