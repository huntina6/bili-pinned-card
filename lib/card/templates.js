'use strict';
/** 四类卡片模板：置顶 / 互动回顾 / UP热评 / 动态更新（组装 + 生成文件） */
const fs = require('fs');
const path = require('path');
const {
  W, PAD, CARD_W, CARD_RX, INNER_X, INNER_W,
  TEXT_DIM, W_NAME,
  AVATAR_SIZE, AVATAR_TOP, AUTHOR_GAP,
  BODY_FS, AUTHOR_FS, TIME_FS, LINE_H,
  ROW_INNER_W, ROW_FS,
  SECTION_GAP_TOP, IMG_GAP_TOP,
  MAX_LINES, maxCardHForScale,
} = require('./constants');
const { esc, fmtCount, fmtTime, wrapTokens, toFileTs, truncateTokensToLines } = require('./text');
const { dataUri, picSize, prepareImages, prepareChainItems, prepareUpTopCard, picVariant, avatarVariant } = require('./image');
const {
  svgShell, defsSvg, renderTitleBar, renderSectionHeader, renderLines, pictureBlock,
  renderItemList, chainNodes, renderReplyRow, renderMainCard, renderFooter, renderChainBlock, renderNote,
} = require('./layout');

/** 单个互动项 → 若干互动块（被UP回复 + UP回复 / UP回复 / 被UP点赞） */
function renderChainItem(els, y, it) {
  for (const [node, role, isUp] of chainNodes(it)) y = renderChainBlock(els, y, node, role, isUp);
  return y;
}

/** 落盘 PNG（主文件 + latest 副本）；ts 为空时用生成时间兜底，返回主文件路径 */
function saveCard(png, { outDir, prefix, id, latest, ts }) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = ts || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(outDir, `${prefix}_${stamp}_${id}.png`);
  fs.writeFileSync(file, png);
  fs.writeFileSync(path.join(outDir, latest), png);
  return file;
}

function defaultFontFamily() {
  switch (process.platform) {
    case 'darwin': return 'PingFang SC';
    case 'win32':  return 'Microsoft YaHei';
    default:       return 'Noto Sans CJK SC';
  }
}

// resvg 惰性加载：仅真正渲染时加载原生二进制（--help/--login/交互配置阶段零开销）
let _Resvg = null;
/** 渲染 SVG → PNG Buffer（2x 输出保证清晰度） */
function renderPng(svg, scale = 2) {
  if (!_Resvg) {
    try {
      _Resvg = require('@resvg/resvg-js').Resvg;
    } catch (e) {
      // 依赖缺失（如未 npm install 的源码副本）时给出明确指引，而非裸 require stack
      throw new Error('缺少渲染依赖 @resvg/resvg-js：请在项目目录运行 npm install 后重试', { cause: e });
    }
  }
  const r = new _Resvg(svg, {
    fitTo: { mode: 'width', value: Math.round(W * scale) },
    font: { loadSystemFonts: true, defaultFontFamily: defaultFontFamily() },
  });
  return r.render().asPng();
}

/**
 * @param {any} comment getPinnedComment 返回值（B站原始结构 + 渲染期注入字段）
 * @param {any[]} replies getReplies 返回值
 * @param {{upName?: string, upMid?: number|string, showReplies?: boolean, oid?: number|string, scale?: number}} [opts]
 * @returns {Promise<string>} SVG 字符串
 */
async function buildSvg(comment, replies, opts = {}) {
  const { upName = '', upMid = 0, showReplies = false, oid = 0 } = opts;
  const maxH = maxCardHForScale(opts.scale); // 高度预算随分辨率收紧
  const els = [];
  const defs = defsSvg();
  let y = PAD;

  // 1. 标题栏
  y = renderTitleBar(els, y, '置顶评论', `动态 · ${upName || 'B站动态'}`);

  // 2. 主评论卡片
  const mc = renderMainCard(comment, y, upMid);
  els.push(...mc.els);
  y = mc.cardBottom;

  // 3. 回复区
  if (showReplies && replies.length) {
    y += SECTION_GAP_TOP;
    y = renderSectionHeader(els, y, '精彩回复', `${replies.length}/${fmtCount(comment.rcount)}`);
    y = renderItemList(els, y, replies, maxH, (e2, yy, r) => renderReplyRow(e2, yy, r, upMid), '回复');
  }

  // 4. 页脚（右下角显示动态完整链接）
  const footRight = oid ? `https://t.bilibili.com/${oid}` : `#${String(comment.rpid).slice(-8)}`;
  y = renderFooter(els, y, 'BILI PINNED COMMENT', footRight);

  return svgShell(defs, els, y);
}

/**
 * 生成置顶评论卡片
 * @returns {Promise<{ file: string, png: Buffer, svg: string }>}
 */
async function generateCard({ comment, replies, opts, outDir }) {
  await prepareImages(comment, replies);
  const svg = await buildSvg(comment, replies, opts);
  const png = renderPng(svg, opts?.scale || 2);
  // 文件名时间戳 = 评论发布时间（ctime 异常时兜底生成时间）
  const file = saveCard(png, { outDir, prefix: 'pinned-card', id: comment.rpid, latest: 'latest.png', ts: toFileTs(comment.ctime) });
  return { file, png, svg };
}

// ====== 取消置顶：UP 互动上下文卡片 ======

/** 取消置顶 → UP 互动回顾卡片 SVG */
async function buildUnpinnedSvg(comment, items, opts = {}) {
  const { upName = '', oid = 0, upMid = 0 } = opts;
  const maxH = maxCardHForScale(opts.scale); // 高度预算随分辨率收紧
  const els = [];
  const defs = defsSvg();
  let y = PAD;
  y = renderTitleBar(els, y, '置顶评论', `UP互动回顾 · ${upName || comment.author || 'B站动态'}`);

  const mc = renderMainCard(comment, y, upMid);
  els.push(...mc.els);
  y = mc.cardBottom;

  // 互动链区
  y += SECTION_GAP_TOP;
  y = renderSectionHeader(els, y, 'UP互动回顾', `${items.length} 条互动`);
  if (!items.length) {
    y = renderNote(els, y, '该评论区暂无 UP 互动');
  } else {
    y = renderItemList(els, y, items, maxH, renderChainItem, '互动');
  }

  y = renderFooter(els, y, 'BILI UP INTERACTION', oid ? `https://t.bilibili.com/${oid}` : `#${String(comment.rpid).slice(-8)}`);
  return svgShell(defs, els, y);
}

/** 生成取消置顶互动回顾卡片 */
async function generateUnpinnedCard({ comment, items, opts, outDir }) {
  await prepareImages(comment, []);
  await prepareChainItems(items);
  const svg = await buildUnpinnedSvg(comment, items, opts);
  const png = renderPng(svg, opts?.scale || 2);
  // 评论发布时间（兜底生成时间）
  const file = saveCard(png, { outDir, prefix: 'unpinned-context', id: comment.rpid, latest: 'latest-unpinned.png', ts: toFileTs(comment.ctime) });
  return { file, png, svg };
}

// ====== UP 热评 TOP 卡（--up-top）：UP 评论 + UP 回复上下文 + 粉丝高赞 TOP N ======

/** UP 热评卡 SVG：UP 评论块 → 区域一（UP回复上下文）→ 区域二（高赞回复 TOP N） */
async function buildUpTopSvg(comment, items, fans, opts = {}) {
  const { upName = '', oid = 0, topN = 10 } = opts;
  const maxH = maxCardHForScale(opts.scale); // 高度预算随分辨率收紧
  const els = [];
  const defs = defsSvg();
  let y = PAD;

  // 与 renderChainBlock 一致的正文度量（用于行数截断）
  for (const node of [comment, ...items.flatMap(it => [it.parent, it.upReply]), ...fans]) {
    if (!node?._tokens) continue;
    node._tokens = truncateTokensToLines(node._tokens, ROW_INNER_W, ROW_FS, MAX_LINES);
  }

  y = renderTitleBar(els, y, 'UP评论', `UP热评 · ${upName || comment.author || 'B站动态'}`);

  // UP 评论上下文块（粉色高亮）
  y = renderChainBlock(els, y, comment, 'UP', true);

  // 区域一：UP 回复上下文（全量，按时间排列）
  y += SECTION_GAP_TOP;
  y = renderSectionHeader(els, y, 'UP回复上下文', `${items.length} 条互动`);
  if (!items.length) {
    y = renderNote(els, y, '暂无 UP 互动');
  } else {
    y = renderItemList(els, y, items, maxH, renderChainItem, '互动');
  }

  // 区域二：高赞回复 TOP N（仅粉丝，点赞降序）
  y += SECTION_GAP_TOP;
  y = renderSectionHeader(els, y, `高赞回复 TOP${topN}`, `${fans.length} 条`);
  if (!fans.length) {
    y = renderNote(els, y, '暂无高赞回复');
  } else {
    y = renderItemList(els, y, fans, maxH, (e2, yy, f) => renderChainBlock(e2, yy, f, '粉丝', false), '高赞回复');
  }

  y = renderFooter(els, y, 'BILI UP TOP', oid ? `https://t.bilibili.com/${oid}` : `#${String(comment.rpid).slice(-8)}`);
  return svgShell(defs, els, y);
}

/** 生成 UP 热评卡（一卡一评论；文件名 = 该 UP 评论发布时间） */
async function generateUpTopCard({ comment, items, fans, opts, outDir }) {
  await prepareUpTopCard(comment, items, fans);
  const svg = await buildUpTopSvg(comment, items, fans, opts);
  const png = renderPng(svg, opts?.scale || 2);
  const file = saveCard(png, { outDir, prefix: 'up-top', id: comment.rpid, latest: 'latest-up-top.png', ts: toFileTs(comment.ctime) });
  return { file, png, svg };
}

// ====== 普通动态更新卡片 ======

async function buildDynamicSvg(dyn, opts = {}) {
  const { upName = '', oid = 0 } = opts;
  const maxH = maxCardHForScale(opts.scale); // 高度预算随分辨率收紧
  const els = [];
  const defs = defsSvg();
  let y = PAD;
  y = renderTitleBar(els, y, '动态更新', `最新动态 · ${upName || dyn.latestAuthor || 'B站动态'}`);

  const cardTop = y;
  const avatarY = cardTop + AVATAR_TOP;
  const avatarR = AVATAR_SIZE / 2;
  const authorX = INNER_X + AVATAR_SIZE + AUTHOR_GAP;
  els.push(`<image href="${esc(dyn.latestFace || '')}" x="${INNER_X}" y="${avatarY}" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" clip-path="url(#avatarClip)" preserveAspectRatio="xMidYMid slice"/>
    <circle cx="${INNER_X + avatarR}" cy="${avatarY + avatarR}" r="${avatarR}" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/>`);
  els.push(`<text x="${authorX}" y="${avatarY + 15}" font-size="${AUTHOR_FS}" font-weight="${W_NAME}" fill="#fff">${esc(dyn.latestAuthor || upName || '')}</text>`);
  els.push(`<text x="${authorX}" y="${avatarY + 32}" font-size="${TIME_FS}" fill="${TEXT_DIM}">${fmtTime(dyn.latestTs)} · 最新动态 #${String(dyn.latestId).slice(-8)}</text>`);
  y = cardTop + AVATAR_TOP + AVATAR_SIZE;

  const bodyFs = BODY_FS;
  const lines = wrapTokens([{ type: 'text', text: dyn.latestDesc }], INNER_W, bodyFs);
  const body = renderLines(els, y, lines, { x: INNER_X, fs: bodyFs, lineH: bodyFs * LINE_H, maxH });
  y = body.y;
  if (body.cut) y = renderNote(els, y, `…正文还有 ${body.cut} 行未展示（已达卡片高度上限）`);

  if (dyn.latestImages && dyn.latestImages.length && y <= maxH) {
    y += IMG_GAP_TOP;
    // 单图按原图比例完整展开（与主评论卡片一致，不再固定 320x240 裁剪）
    const pb = pictureBlock(dyn.latestImages, dyn._picImgs || [], dyn._picSizes, { x: INNER_X, y, maxW: INNER_W, maxSingleH: 480 });
    els.push(pb.svg);
    y += pb.h;
  }
  y += 18;
  const cardBottom = y;
  els.push(`<rect x="${PAD}" y="${cardTop}" width="${CARD_W}" height="${cardBottom - cardTop}" rx="${CARD_RX}" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`);

  y = renderFooter(els, y, 'BILI DYNAMIC UPDATE', oid ? `https://t.bilibili.com/${oid}` : `#${String(dyn.latestId).slice(-8)}`);
  return svgShell(defs, els, y);
}

/** 生成普通动态更新卡片 */
async function generateDynamicCard({ dyn, opts, outDir }) {
  const picUrls = dyn.latestImages.map(picVariant);
  dyn._picImgs = await Promise.all(picUrls.map(u => dataUri(u)));
  dyn._picSizes = await Promise.all(picUrls.map(u => picSize(u))); // 供单图按比例展开
  if (dyn.latestFace) dyn.latestFace = await dataUri(avatarVariant(dyn.latestFace));
  const svg = await buildDynamicSvg(dyn, opts);
  const png = renderPng(svg, opts?.scale || 2);
  // 动态发布时间（兜底生成时间）
  const file = saveCard(png, { outDir, prefix: 'dynamic-update', id: dyn.latestId, latest: 'latest-dynamic.png', ts: toFileTs(dyn.latestTs) });
  return { file, png, svg };
}

module.exports = {
  defaultFontFamily, renderPng, saveCard,
  buildSvg, buildUnpinnedSvg, buildUpTopSvg, buildDynamicSvg,
  generateCard, generateUnpinnedCard, generateUpTopCard, generateDynamicCard,
};
