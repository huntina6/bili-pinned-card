'use strict';
/** 四类卡片模板：置顶 / 互动回顾 / UP热评 / 动态更新（组装 + 生成文件） */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const {
  W, PAD, CARD_W, CARD_RX, INNER_X, INNER_W,
  TEXT_DIM, TEXT_SUB, TEXT_DIMMER, PINK,
  SECTION_FS, META_FS, FONT_STACK, LINE_H,
  W_SECTION, W_NAME, W_NAME_S,
  AVATAR_SIZE, AVATAR_TOP, AUTHOR_GAP,
  BODY_FS, AUTHOR_FS, TIME_FS, REPLY_AUTHOR_FS,
  MAX_ITEMS_SAFE, MAX_LINES,
} = require('./constants');
const { esc, fmtCount, fmtTime, measureText, wrapTokens, lineToSvg, toFileTs, truncateTokensToLines } = require('./text');
const { dataUri, picSize, fitSinglePic, prepareImages, prepareChainItems, prepareUpTopCard } = require('./image');
const { defsSvg, renderTitleBar, renderMainCard, renderFooter, renderChainBlock } = require('./layout');

function defaultFontFamily() {
  switch (process.platform) {
    case 'darwin': return 'PingFang SC';
    case 'win32':  return 'Microsoft YaHei';
    default:       return 'Noto Sans CJK SC';
  }
}

/** 渲染 SVG → PNG Buffer（2x 输出保证清晰度） */
function renderPng(svg, scale = 2) {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: W * scale },
    font: { loadSystemFonts: true, defaultFontFamily: defaultFontFamily() },
  });
  return r.render().asPng();
}

/**
 * @param {object} comment getPinnedComment 返回值
 * @param {object[]} replies getReplies 返回值
 * @param {object} opts { upName, upMid, showReplies, oid }
 * @returns {Promise<string>} SVG 字符串
 */
async function buildSvg(comment, replies, opts = {}) {
  const { upName = '', upMid = 0, showReplies = false, oid = 0 } = opts;
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
    y += 16;
    els.push(`<text x="${PAD}" y="${y}" font-size="${SECTION_FS}" font-weight="${W_SECTION}" fill="${TEXT_SUB}">精彩回复</text>`);
    const badgeText = `${replies.length}/${fmtCount(comment.rcount)}`;
    const badgeW2 = measureText(badgeText, 11) + 16;
    els.push(`<rect x="${PAD + measureText('精彩回复', 13) + 8}" y="${y - 12}" width="${badgeW2}" height="18" rx="9" fill="rgba(251,114,153,0.2)"/>`);
    els.push(`<text x="${PAD + measureText('精彩回复', 13) + 8 + badgeW2 / 2}" y="${y + 1}" font-size="${META_FS}" fill="${PINK}" text-anchor="middle">${badgeText}</text>`);
    y += 8;

    const rw = CARD_W - 28;              // 回复条宽度
    const rInnerW = rw - 34 - 10;        // 去掉头像与间距
    const rFs = 13.5;
    const rLh = rFs * 1.7;
    for (const r of replies) {
      y += 12;
      const rTop = y;
      const lines = wrapTokens(r._tokens, rInnerW, rFs);
      const textH = lines.length * rLh;
      const bodyH = Math.max(textH, 34);
      const itemH = 12 + 12 + bodyH + 16 + 22; // 上内边距 + 文本 + 元信息行 + 下内边距
      els.push(`<rect x="${PAD}" y="${rTop}" width="${rw}" height="${itemH}" rx="12" fill="rgba(255,255,255,0.05)"/>`);
      // 头像
      els.push(`<image href="${esc(r.avatar)}" x="${PAD + 14}" y="${rTop + 12}" width="34" height="34" clip-path="url(#avatarClipSm)" preserveAspectRatio="xMidYMid slice"/>`);
      // 名字（B站 用户名 500）
      const nameX = PAD + 14 + 34 + 10;
      let nameEl = `<text x="${nameX}" y="${rTop + 24}" font-size="${REPLY_AUTHOR_FS}" font-weight="${W_NAME_S}" fill="${TEXT_SUB}">${esc(r.author)}</text>`;
      if (String(r.mid) === String(upMid)) {
        const nw = measureText(r.author, REPLY_AUTHOR_FS);
        nameEl += `<text x="${nameX + nw + 4}" y="${rTop + 24}" font-size="${META_FS}" fill="${PINK}">· UP</text>`;
      }
      els.push(nameEl);
      // 正文
      let ly = rTop + 12 + 18 + 4;
      for (const line of lines) {
        ly += rLh;
        els.push(lineToSvg(line, rFs, nameX, ly, r._emoteImgs || {}));
      }
      // 元信息
      const metaY = rTop + itemH - 16;
      els.push(`<text x="${nameX}" y="${metaY}" font-size="${META_FS}" fill="${TEXT_DIMMER}">${fmtTime(r.ctime)} · ${fmtCount(r.like)} 赞</text>`);
      y = rTop + itemH;
    }
  }

  // 4. 页脚（右下角显示动态完整链接）
  const footRight = oid ? `https://t.bilibili.com/${oid}` : `#${String(comment.rpid).slice(-8)}`;
  y = renderFooter(els, y, 'BILI PINNED COMMENT', footRight);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" font-family="${FONT_STACK}">
  <defs>${defs}</defs>
  <rect x="0" y="0" width="${W}" height="${y}" fill="url(#bg)"/>
  ${els.join('\n  ')}
</svg>`;
  return svg;
}

/**
 * 生成置顶评论卡片
 * @returns {Promise<{ file: string, png: Buffer, svg: string }>}
 */
async function generateCard({ comment, replies, opts, outDir }) {
  await prepareImages(comment, replies);
  const svg = await buildSvg(comment, replies, opts);
  const png = renderPng(svg);

  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(outDir, `pinned-card_${ts}_${comment.rpid}.png`);
  fs.writeFileSync(file, png);
  fs.writeFileSync(path.join(outDir, 'latest.png'), png);
  return { file, png, svg };
}

// ====== 取消置顶：UP 互动上下文卡片 ======

/** 取消置顶 → UP 互动回顾卡片 SVG */
async function buildUnpinnedSvg(comment, items, opts = {}) {
  const { upName = '', oid = 0, upMid = 0 } = opts;
  const els = [];
  const defs = defsSvg();
  let y = PAD;
  y = renderTitleBar(els, y, '置顶评论', `UP互动回顾 · ${upName || comment.author || 'B站动态'}`);

  const mc = renderMainCard(comment, y, upMid);
  els.push(...mc.els);
  y = mc.cardBottom;

  // 互动链区
  y += 16;
  els.push(`<text x="${PAD}" y="${y}" font-size="${SECTION_FS}" font-weight="${W_SECTION}" fill="${TEXT_SUB}">UP互动回顾</text>`);
  const badgeText = `${items.length} 条互动`;
  const badgeW2 = measureText(badgeText, 11) + 16;
  els.push(`<rect x="${PAD + measureText('UP互动回顾', 13) + 8}" y="${y - 12}" width="${badgeW2}" height="18" rx="9" fill="rgba(251,114,153,0.2)"/>`);
  els.push(`<text x="${PAD + measureText('UP互动回顾', 13) + 8 + badgeW2 / 2}" y="${y + 1}" font-size="${META_FS}" fill="${PINK}" text-anchor="middle">${badgeText}</text>`);
  y += 8;

  if (!items.length) {
    y += 12;
    els.push(`<rect x="${PAD}" y="${y}" width="${CARD_W}" height="42" rx="12" fill="rgba(255,255,255,0.05)"/>`);
    els.push(`<text x="${PAD + 14}" y="${y + 26}" font-size="${SECTION_FS}" fill="${TEXT_DIM}">该评论区暂无 UP 互动</text>`);
    y += 54;
  } else {
    for (const it of items) {
      if (it.kind === 'reply' && it.parent) {
        y = renderChainBlock(els, y, it.parent, '被UP回复', false);
        y = renderChainBlock(els, y, it.upReply, 'UP回复', true);
      } else if (it.kind === 'reply') {
        y = renderChainBlock(els, y, it.upReply, 'UP回复', true);
      } else {
        y = renderChainBlock(els, y, it.parent, '被UP点赞', false);
      }
    }
  }

  y = renderFooter(els, y, 'BILI UP INTERACTION', oid ? `https://t.bilibili.com/${oid}` : `#${String(comment.rpid).slice(-8)}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" font-family="${FONT_STACK}">
  <defs>${defs}</defs>
  <rect x="0" y="0" width="${W}" height="${y}" fill="url(#bg)"/>
  ${els.join('\n  ')}
</svg>`;
}

/** 生成取消置顶互动回顾卡片 */
async function generateUnpinnedCard({ comment, items, opts, outDir }) {
  await prepareImages(comment, []);
  await prepareChainItems(items);
  const svg = await buildUnpinnedSvg(comment, items, opts);
  const png = renderPng(svg);
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(outDir, `unpinned-context_${ts}_${comment.rpid}.png`);
  fs.writeFileSync(file, png);
  fs.writeFileSync(path.join(outDir, 'latest-unpinned.png'), png);
  return { file, png, svg };
}

// ====== UP 热评 TOP 卡（--up-top）：UP 评论 + UP 回复上下文 + 粉丝高赞 TOP N ======

/** UP 热评卡 SVG：UP 评论块 → 区域一（UP回复上下文）→ 区域二（高赞回复 TOP N） */
async function buildUpTopSvg(comment, items, fans, opts = {}) {
  const { upName = '', oid = 0, topN = 10 } = opts;
  const els = [];
  const defs = defsSvg();
  let y = PAD;

  // 与 renderChainBlock 一致的正文度量（用于行数截断）
  const rw = CARD_W - 28;
  const rInnerW = rw - 34 - 10;
  const rFs = 13.5;
  for (const node of [comment, ...items.flatMap(it => [it.parent, it.upReply]), ...fans]) {
    if (!node?._tokens) continue;
    node._tokens = truncateTokensToLines(node._tokens, rInnerW, rFs, MAX_LINES);
  }

  y = renderTitleBar(els, y, 'UP评论', `UP热评 · ${upName || comment.author || 'B站动态'}`);

  // UP 评论上下文块（粉色高亮）
  y = renderChainBlock(els, y, comment, 'UP', true);

  // 区域一：UP 回复上下文（全量，按时间排列）
  y += 16;
  els.push(`<text x="${PAD}" y="${y}" font-size="${SECTION_FS}" font-weight="${W_SECTION}" fill="${TEXT_SUB}">UP回复上下文</text>`);
  const badge1Text = `${items.length} 条互动`;
  const badge1W = measureText(badge1Text, 11) + 16;
  els.push(`<rect x="${PAD + measureText('UP回复上下文', 13) + 8}" y="${y - 12}" width="${badge1W}" height="18" rx="9" fill="rgba(251,114,153,0.2)"/>`);
  els.push(`<text x="${PAD + measureText('UP回复上下文', 13) + 8 + badge1W / 2}" y="${y + 1}" font-size="${META_FS}" fill="${PINK}" text-anchor="middle">${badge1Text}</text>`);
  y += 8;

  if (!items.length) {
    y += 12;
    els.push(`<rect x="${PAD}" y="${y}" width="${CARD_W}" height="42" rx="12" fill="rgba(255,255,255,0.05)"/>`);
    els.push(`<text x="${PAD + 14}" y="${y + 26}" font-size="${SECTION_FS}" fill="${TEXT_DIM}">暂无 UP 互动</text>`);
    y += 54;
  } else {
    for (const it of items) {
      if (it.kind === 'reply' && it.parent) {
        y = renderChainBlock(els, y, it.parent, '被UP回复', false);
        y = renderChainBlock(els, y, it.upReply, 'UP回复', true);
      } else if (it.kind === 'reply') {
        y = renderChainBlock(els, y, it.upReply, 'UP回复', true);
      } else {
        y = renderChainBlock(els, y, it.parent, '被UP点赞', false);
      }
    }
  }

  // 区域二：高赞回复 TOP N（仅粉丝，点赞降序）
  y += 16;
  const sec2Title = `高赞回复 TOP${topN}`;
  els.push(`<text x="${PAD}" y="${y}" font-size="${SECTION_FS}" font-weight="${W_SECTION}" fill="${TEXT_SUB}">${sec2Title}</text>`);
  const badge2Text = `${fans.length} 条`;
  const badge2W = measureText(badge2Text, 11) + 16;
  els.push(`<rect x="${PAD + measureText(sec2Title, 13) + 8}" y="${y - 12}" width="${badge2W}" height="18" rx="9" fill="rgba(251,114,153,0.2)"/>`);
  els.push(`<text x="${PAD + measureText(sec2Title, 13) + 8 + badge2W / 2}" y="${y + 1}" font-size="${META_FS}" fill="${PINK}" text-anchor="middle">${badge2Text}</text>`);
  y += 8;

  if (!fans.length) {
    y += 12;
    els.push(`<rect x="${PAD}" y="${y}" width="${CARD_W}" height="42" rx="12" fill="rgba(255,255,255,0.05)"/>`);
    els.push(`<text x="${PAD + 14}" y="${y + 26}" font-size="${SECTION_FS}" fill="${TEXT_DIM}">暂无高赞回复</text>`);
    y += 54;
  } else {
    for (const fan of fans) {
      y = renderChainBlock(els, y, fan, '粉丝', false);
    }
  }

  y = renderFooter(els, y, 'BILI UP TOP', oid ? `https://t.bilibili.com/${oid}` : `#${String(comment.rpid).slice(-8)}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" font-family="${FONT_STACK}">
  <defs>${defs}</defs>
  <rect x="0" y="0" width="${W}" height="${y}" fill="url(#bg)"/>
  ${els.join('\n  ')}
</svg>`;
}

/** 生成 UP 热评卡（一卡一评论；文件名 = 该 UP 评论发布时间） */
async function generateUpTopCard({ comment, items, fans, opts, outDir }) {
  await prepareUpTopCard(comment, items, fans);
  const svg = await buildUpTopSvg(comment, items, fans, opts);
  const png = renderPng(svg);
  fs.mkdirSync(outDir, { recursive: true });
  const ts = toFileTs(comment.ctime) || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(outDir, `up-top_${ts}_${comment.rpid}.png`);
  fs.writeFileSync(file, png);
  fs.writeFileSync(path.join(outDir, 'latest-up-top.png'), png);
  return { file, png, svg };
}

// ====== 普通动态更新卡片 ======

async function buildDynamicSvg(dyn, opts = {}) {
  const { upName = '', oid = 0 } = opts;
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
  const bodyLh = bodyFs * LINE_H;
  for (const line of lines) {
    y += bodyLh;
    els.push(lineToSvg(line, bodyFs, INNER_X, y, {}));
  }

  if (dyn.latestImages && dyn.latestImages.length) {
    y += 12;
    const pics = dyn.latestImages;
    const picImgs = dyn._picImgs || [];
    if (pics.length === 1) {
      // 单图：按原图比例完整展开（与主评论卡片一致，不再固定 320x240 裁剪）
      const sz = (dyn._picSizes || [])[0] || null;
      const f = fitSinglePic(sz?.width, sz?.height, INNER_W, 480);
      els.push(`<image href="${esc(picImgs[0] || '')}" x="${INNER_X}" y="${y}" width="${f.w}" height="${f.h}" clip-path="url(#imgClipBig)" preserveAspectRatio="xMidYMid slice"/>`);
      if (!picImgs[0]) els.push(`<rect x="${INNER_X}" y="${y}" width="${f.w}" height="${f.h}" rx="10" fill="rgba(255,255,255,0.06)"/>`);
      y += f.h;
    } else {
      const cell = (INNER_W - 12) / 3;
      pics.forEach((_, i) => {
        const cx = INNER_X + (i % 3) * (cell + 6);
        const cy = y + Math.floor(i / 3) * (cell + 6);
        els.push(`<image href="${esc(picImgs[i] || '')}" x="${cx}" y="${cy}" width="${cell}" height="${cell}" clip-path="url(#imgClip)" preserveAspectRatio="xMidYMid slice"/>`);
        if (!picImgs[i]) els.push(`<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="10" fill="rgba(255,255,255,0.06)"/>`);
      });
      y += Math.ceil(pics.length / 3) * (cell + 6) - 6;
    }
  }
  y += 18;
  const cardBottom = y;
  els.push(`<rect x="${PAD}" y="${cardTop}" width="${CARD_W}" height="${cardBottom - cardTop}" rx="${CARD_RX}" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`);

  y = renderFooter(els, y, 'BILI DYNAMIC UPDATE', oid ? `https://t.bilibili.com/${oid}` : `#${String(dyn.latestId).slice(-8)}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" font-family="${FONT_STACK}">
  <defs>${defs}</defs>
  <rect x="0" y="0" width="${W}" height="${y}" fill="url(#bg)"/>
  ${els.join('\n  ')}
</svg>`;
}

/** 生成普通动态更新卡片 */
async function generateDynamicCard({ dyn, opts, outDir }) {
  dyn._picImgs = await Promise.all(dyn.latestImages.map(u => dataUri(u)));
  dyn._picSizes = await Promise.all(dyn.latestImages.map(u => picSize(u))); // 供单图按比例展开
  if (dyn.latestFace) dyn.latestFace = await dataUri(dyn.latestFace);
  const svg = await buildDynamicSvg(dyn, opts);
  const png = renderPng(svg);
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(outDir, `dynamic-update_${ts}_${dyn.latestId}.png`);
  fs.writeFileSync(file, png);
  fs.writeFileSync(path.join(outDir, 'latest-dynamic.png'), png);
  return { file, png, svg };
}

module.exports = {
  defaultFontFamily, renderPng,
  buildSvg, buildUnpinnedSvg, buildUpTopSvg, buildDynamicSvg,
  generateCard, generateUnpinnedCard, generateUpTopCard, generateDynamicCard,
};
