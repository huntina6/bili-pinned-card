'use strict';
/**
 * Unicode emoji → Twemoji 内联图（resvg 不支持彩色字体，见 resvg-js issue #316）
 * - 按 grapheme 切分（Intl.Segmenter，Node ≥18），支持 ZWJ/肤色/区域旗帜序列
 * - 下载失败一次即进程级熔断（disableEmoji），后续 emoji 回退为文本渲染
 * - CDN 可用环境变量 BILI_EMOJI_CDN 覆盖（默认 cdnjs twemoji 14.0.2）
 */
const DEFAULT_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/';
let _cdn = process.env.BILI_EMOJI_CDN || DEFAULT_CDN;
let _disabled = false;
const _segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
  : null;

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const RI_RE = /\p{Regional_Indicator}/u;

/** 是否为 emoji grapheme（表情符号或区域旗帜；纯数字/字母/汉字为 false） */
function isEmoji(g) {
  if (!g) return false;
  return EMOJI_RE.test(g) || RI_RE.test(g);
}

/** grapheme → twemoji 文件名（去掉变体选择符 FE0F；多码点用 '-' 连接小写十六进制） */
function emojiKey(g) {
  const cps = [...String(g)].map(c => c.codePointAt(0)).filter(cp => cp !== 0xfe0f);
  if (!cps.length) return '';
  return cps.map(cp => cp.toString(16)).join('-');
}

/** grapheme → 内联图片 URL（熔断/无法映射时返回空） */
function emojiUrl(g) {
  if (_disabled) return '';
  const k = emojiKey(g);
  return k ? `${_cdn}${k}.png` : '';
}

/** 文本 → grapheme 段（emoji 段带 url；供分词器使用） */
function segmentText(text) {
  const s = String(text || '');
  if (!_segmenter) return s ? [{ text: s, emoji: false }] : [];
  const out = [];
  for (const { segment } of _segmenter.segment(s)) {
    const url = isEmoji(segment) ? emojiUrl(segment) : '';
    out.push(url ? { text: segment, emoji: true, url } : { text: segment, emoji: false });
  }
  return out;
}

function isEmojiUrl(url) { return !!url && String(url).startsWith(_cdn); }
function disableEmoji() { _disabled = true; }
function emojiEnabled() { return !_disabled; }
function setEnabled(v) { _disabled = !v; }
/** 测试钩子：覆盖 CDN 基址 */
function setCdn(base) { _cdn = String(base || DEFAULT_CDN); }

module.exports = {
  DEFAULT_CDN, isEmoji, emojiKey, emojiUrl, segmentText, isEmojiUrl,
  emojiEnabled, disableEmoji, setEnabled, setCdn,
};
