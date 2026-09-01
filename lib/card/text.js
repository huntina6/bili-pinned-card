'use strict';
/** 文本工具：转义/格式化/度量/分词/换行/单行 SVG 输出 */
const { normUrl } = require('../api');
const { W_BODY, TEXT_INNER } = require('./constants');

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function fmtCount(n) {
  if (n == null) return '0';
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Unix 秒 → yyyyMMddHHmmss（文件名用） */
function toFileTs(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ====== 文本度量与换行（CJK 全角近似，够用且跨平台稳定） ======
function charWpx(ch, fs) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x2e80 && cp <= 0x9fff) return fs;         // CJK 统一表意/假名/谚文
  if (cp >= 0xf900 && cp <= 0xfaff) return fs;         // CJK 兼容
  if (cp >= 0xff00 && cp <= 0xffef) return fs;         // 全角符号
  if (cp >= 0x20000 && cp <= 0x2ffff) return fs * 2;   // CJK 扩展
  if (cp >= 0x20 && cp <= 0x7e) return fs * 0.55;      // ASCII
  return fs * 0.6;
}

function measureText(s, fs) {
  let w = 0;
  for (const ch of String(s)) w += charWpx(ch, fs);
  return w;
}

/** 消息 → token 流（文本 / 表情图片） */
function tokenize(message, emoteMap) {
  const tokens = [];
  const msg = String(message || '');
  const keys = Object.keys(emoteMap || {}).filter(k => k && msg.includes(k));
  if (!keys.length) {
    if (msg) tokens.push({ type: 'text', text: msg });
    return tokens;
  }
  let i = 0;
  while (i < msg.length) {
    let best = null;
    for (const key of keys) {
      const idx = msg.indexOf(key, i);
      if (idx >= 0 && (best === null || idx < best.idx)) best = { idx, key };
    }
    if (!best) {
      tokens.push({ type: 'text', text: msg.slice(i) });
      break;
    }
    if (best.idx > i) tokens.push({ type: 'text', text: msg.slice(i, best.idx) });
    const e = emoteMap[best.key];
    tokens.push({ type: 'emote', key: best.key, text: e?.text || best.key, url: normUrl(e?.url || '') });
    i = best.idx + best.key.length;
  }
  return tokens;
}

/** token 流 → 行（支持 '\n' 硬换行与超宽软换行） */
function wrapTokens(tokens, maxW, fs, emoteW = 36) {
  const lines = [];
  let cur = [];
  let curW = 0;
  const flush = () => {
    if (cur.length) { lines.push(cur); cur = []; curW = 0; }
  };
  for (const t of tokens) {
    if (t.type === 'emote') {
      if (cur.length && curW + emoteW + 4 > maxW) flush();
      cur.push({ ...t, w: emoteW + 4 });
      curW += emoteW + 4;
      continue;
    }
    for (const ch of t.text) {
      if (ch === '\n') { flush(); continue; }
      const w = charWpx(ch, fs);
      if (cur.length && curW + w > maxW) flush();
      cur.push({ type: 'char', ch, w });
      curW += w;
    }
  }
  flush();
  return lines;
}

/** 单行 SVG 输出：连续字符合成 <text>，表情插 <image> */
function lineToSvg(line, fs, x0, baseline, emoteImgs) {
  let out = '';
  let buf = '';
  const flushText = () => {
    if (buf) {
      out += `<text x="${x0}" y="${baseline}" font-size="${fs}" font-weight="${W_BODY}" fill="${TEXT_INNER}">${esc(buf)}</text>`;
      x0 += measureText(buf, fs);
      buf = '';
    }
  };
  for (const t of line) {
    if (t.type === 'char') {
      buf += t.ch;
    } else {
      flushText();
      const dataUri = emoteImgs[t.key];
      if (dataUri) {
        const size = t.w - 4;
        out += `<image href="${dataUri}" x="${x0}" y="${baseline - fs + (fs - size) / 2}" width="${size}" height="${size}"/>`;
        x0 += t.w;
      } else {
        buf += `[${t.text}]`;
        x0 += measureText(`[${t.text}]`, fs);
      }
    }
  }
  flushText();
  return out;
}

/** 按渲染行数上限截断 token 流（与 wrapTokens 规则一致；超限追加省略号；输出仍为 text/emote token 流） */
function truncateTokensToLines(tokens, maxW, fs, maxLines, emoteW = 36) {
  const out = [];
  let curW = 0;
  let lines = 1;
  let truncated = false;
  let buf = '';
  const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } };
  for (const t of tokens) {
    if (truncated) break;
    if (t.type === 'emote') {
      if ((out.length || buf) && curW + emoteW + 4 > maxW) { lines++; curW = 0; if (lines > maxLines) { truncated = true; break; } }
      flush();
      out.push({ ...t });
      curW += emoteW + 4;
      continue;
    }
    for (const ch of t.text) {
      if (ch === '\n') { lines++; curW = 0; if (lines > maxLines) { truncated = true; break; } flush(); continue; }
      const w = charWpx(ch, fs);
      if ((out.length || buf) && curW + w > maxW) { lines++; curW = 0; if (lines > maxLines) { truncated = true; break; } flush(); }
      buf += ch;
      curW += w;
    }
  }
  if (truncated) { flush(); out.push({ type: 'text', text: '…' }); }
  else flush();
  return out;
}

module.exports = {
  esc, fmtCount, fmtTime, toFileTs, charWpx, measureText,
  tokenize, wrapTokens, lineToSvg, truncateTokensToLines,
};
