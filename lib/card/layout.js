'use strict';
/** 布局原语：SVG 外壳 / 标题栏 / 区块标题 / 正文行 / 图片块 / 列表渲染 / 主评论卡 / 互动链块 / 提示块 / 页脚 */
const {
  W, PAD, CARD_W, CARD_RX, INNER_X, INNER_W,
  TEXT_INNER, TEXT_DIM, TEXT_DIMMER, TEXT_SUB, PINK,
  TITLE_FS, BADGE_FS, AUTHOR_FS, REPLY_AUTHOR_FS, BODY_FS,
  META_FS, TIME_FS, ROLE_FS, SECTION_FS,
  W_TITLE, W_SECTION, W_NAME, W_NAME_S,
  AVATAR_SIZE, AVATAR_TOP, AUTHOR_GAP, LINE_H,
  ROW_W, ROW_PAD_X, ROW_AVATAR, ROW_AVATAR_GAP, ROW_NAME_X, ROW_INNER_W, ROW_FS, ROW_LH,
  ROW_PAD_TOP, ROW_NAME_DY, ROW_BODY_DY, ROW_META_BOTTOM, ROW_PAD_BOTTOM, ROW_MIN_BODY_H,
  SECTION_GAP_TOP, SECTION_GAP_BOTTOM, BADGE_H, BADGE_PAD, BADGE_DY, BADGE_TEXT_DY,
  IMG_GAP, IMG_GAP_TOP, IMG_MAX_W, IMG_CLIP_RX,
  NOTE_H, NOTE_PAD_TOP, NOTE_ADVANCE, NOTE_TEXT_DY, FONT_STACK,
} = require('./constants');
const { esc, fmtCount, fmtTime, measureText, wrapTokens, lineToSvg } = require('./text');
const { fitSinglePic } = require('./image');

const CHAIN_IMG_DY = 10; // 互动链中图片与正文最后一行基线的间距

/** SVG 外壳：统一 defs / 背景 / 元素缩进（四类卡片共用） */
function svgShell(defs, els, height) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="${FONT_STACK}">
  <defs>${defs}</defs>
  <rect x="0" y="0" width="${W}" height="${height}" fill="url(#bg)"/>
  ${els.join('\n  ')}
</svg>`;
}

/** 区块标题 + 粉色胶囊徽标；y 为标题基线，返回内容起始 y */
function renderSectionHeader(els, y, title, badgeText) {
  els.push(`<text x="${PAD}" y="${y}" font-size="${SECTION_FS}" font-weight="${W_SECTION}" fill="${TEXT_SUB}">${esc(title)}</text>`);
  const badgeW = measureText(badgeText, META_FS) + BADGE_PAD;
  const badgeX = PAD + measureText(title, SECTION_FS) + 8;
  els.push(`<rect x="${badgeX}" y="${y - BADGE_DY}" width="${badgeW}" height="${BADGE_H}" rx="${BADGE_H / 2}" fill="rgba(251,114,153,0.2)"/>`);
  els.push(`<text x="${badgeX + badgeW / 2}" y="${y + BADGE_TEXT_DY}" font-size="${META_FS}" fill="${PINK}" text-anchor="middle">${esc(badgeText)}</text>`);
  return y + SECTION_GAP_BOTTOM;
}

/**
 * 逐行渲染正文
 * @param {number} y 起始 y（首个基线为 y + lineH）
 * @param {Array<Array<any>>} lines wrapTokens 输出
 * @param {{x:number, fs:number, lineH:number, emoteImgs?:Record<string,string>, maxH?:number}} o
 * @returns {{y:number, cut:number}} 渲染后的 y 与因高度预算未渲染的行数
 */
function renderLines(els, y, lines, o) {
  let cut = 0;
  for (let i = 0; i < lines.length; i++) {
    if (o.maxH != null && y + o.lineH > o.maxH) { cut = lines.length - i; break; }
    y += o.lineH;
    els.push(lineToSvg(lines[i], o.fs, o.x, y, o.emoteImgs || {}));
  }
  return { y, cut };
}

/**
 * 图片块（单图按原图比例展开 / 多图三列网格；缺图补占位矩形）
 * @param {any[]} pics 原始 pictures（判断数量）
 * @param {string[]} picImgs data URI 列表
 * @param {Array<{width:number,height:number}|null>} picSizes 原图尺寸
 * @param {{x:number, y:number, maxW:number, maxSingleH:number, cellMax?:number}} o
 * @returns {{svg:string, h:number}} 元素片段与占用高度
 */
function pictureBlock(pics, picImgs, picSizes, o) {
  const { x, y, maxW, maxSingleH } = o;
  const fallback = `fill="rgba(255,255,255,0.06)" rx="${IMG_CLIP_RX}"`;
  if (pics.length === 1) {
    const sz = (picSizes || [])[0] || null;
    const f = fitSinglePic(sz?.width, sz?.height, maxW, maxSingleH);
    let svg = `<image href="${esc(picImgs[0] || '')}" x="${x}" y="${y}" width="${f.w}" height="${f.h}" clip-path="url(#imgClipBig)" preserveAspectRatio="xMidYMid slice"/>`;
    if (!picImgs[0]) svg += `<rect x="${x}" y="${y}" width="${f.w}" height="${f.h}" ${fallback}/>`;
    return { svg, h: f.h };
  }
  const cell = o.cellMax ? Math.min(o.cellMax, (maxW - IMG_GAP * 2) / 3) : (maxW - IMG_GAP * 2) / 3;
  let svg = '';
  pics.forEach((_, i) => {
    const cx = x + (i % 3) * (cell + IMG_GAP);
    const cy = y + Math.floor(i / 3) * (cell + IMG_GAP);
    svg += `<image href="${esc(picImgs[i] || '')}" x="${cx}" y="${cy}" width="${cell}" height="${cell}" clip-path="url(#imgClip)" preserveAspectRatio="xMidYMid slice"/>`;
    if (!picImgs[i]) svg += `<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" ${fallback}/>`;
  });
  return { svg, h: Math.ceil(pics.length / 3) * (cell + IMG_GAP) - IMG_GAP };
}

/**
 * 列表渲染（带高度预算截断）
 * @param {any[]} items 待渲染项
 * @param {(els:any[], y:number, item:any)=>number} renderOne 单项渲染（返回新 y）
 * @param {string} cutWord 截断提示名词（「回复」→ …还有 N 条回复未展示）
 */
function renderItemList(els, y, items, maxH, renderOne, cutWord) {
  let cut = 0;
  for (let i = 0; i < items.length; i++) {
    if (y > maxH) { cut = items.length - i; break; }
    y = renderOne(els, y, items[i]);
  }
  if (cut) y = renderNote(els, y, `…还有 ${cut} 条${cutWord}未展示（已达卡片高度上限）`);
  return y;
}

/** 互动项 → 待渲染区块清单（被UP回复 / UP回复 / 被UP点赞） */
function chainNodes(it) {
  if (it.kind === 'reply' && it.parent) return [[it.parent, '被UP回复', false], [it.upReply, 'UP回复', true]];
  if (it.kind === 'reply') return [[it.upReply, 'UP回复', true]];
  return [[it.parent, '被UP点赞', false]];
}

/** 置顶卡的回复条（与互动链同节奏，UP 名后跟 · UP 而非胶囊角标），返回新 y */
function renderReplyRow(els, y, r, upMid) {
  y += ROW_PAD_TOP;
  const rTop = y;
  const lines = wrapTokens(r._tokens, ROW_INNER_W, ROW_FS);
  const bodyH = Math.max(lines.length * ROW_LH, ROW_MIN_BODY_H);
  const itemH = ROW_PAD_TOP + ROW_PAD_TOP + bodyH + ROW_META_BOTTOM + ROW_PAD_BOTTOM; // 上内边距 + 文本 + 元信息行 + 下内边距
  els.push(`<rect x="${PAD}" y="${rTop}" width="${ROW_W}" height="${itemH}" rx="12" fill="rgba(255,255,255,0.05)"/>`);
  els.push(`<image href="${esc(r.avatar)}" x="${PAD + ROW_PAD_X}" y="${rTop + ROW_PAD_TOP}" width="${ROW_AVATAR}" height="${ROW_AVATAR}" clip-path="url(#avatarClipSm)" preserveAspectRatio="xMidYMid slice"/>`);
  let nameEl = `<text x="${ROW_NAME_X}" y="${rTop + ROW_NAME_DY * 2}" font-size="${REPLY_AUTHOR_FS}" font-weight="${W_NAME_S}" fill="${TEXT_SUB}">${esc(r.author)}</text>`;
  if (upMid && String(r.mid) === String(upMid)) {
    const nw = measureText(r.author, REPLY_AUTHOR_FS);
    nameEl += `<text x="${ROW_NAME_X + nw + 4}" y="${rTop + ROW_NAME_DY * 2}" font-size="${META_FS}" fill="${PINK}">· UP</text>`;
  }
  els.push(nameEl);
  renderLines(els, rTop + ROW_BODY_DY, lines, { x: ROW_NAME_X, fs: ROW_FS, lineH: ROW_LH, emoteImgs: r._emoteImgs });
  els.push(`<text x="${ROW_NAME_X}" y="${rTop + itemH - ROW_META_BOTTOM}" font-size="${META_FS}" fill="${TEXT_DIMMER}">${fmtTime(r.ctime)} · ${fmtCount(r.like)} 赞</text>`);
  return rTop + itemH;
}

function defsSvg() {
  return `
    <linearGradient id="bg" x1="0" y1="0" x2="0.94" y2="1">
      <stop offset="0" stop-color="#2b2140"/>
      <stop offset="0.6" stop-color="#1a1530"/>
      <stop offset="1" stop-color="#141126"/>
    </linearGradient>
    <linearGradient id="pink" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FB7299"/>
      <stop offset="1" stop-color="#FF5C8A"/>
    </linearGradient>
    <clipPath id="avatarClip" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5"/></clipPath>
    <clipPath id="avatarClipSm" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5"/></clipPath>
    <clipPath id="imgClip" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="1" height="1" rx="0.053"/></clipPath>
    <clipPath id="imgClipBig" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="1" height="1" rx="0.03"/></clipPath>
  `;
}

/** 标题栏：粉色徽标 + 标题文字，返回更新后的 y */
function renderTitleBar(els, y, badge, title) {
  const badgeW = 74, badgeH = 24;
  els.push(`<rect x="${PAD}" y="${y}" width="${badgeW}" height="${badgeH}" rx="12" fill="url(#pink)"/>`);
  els.push(`<text x="${PAD + 12}" y="${y + 16.5}" font-size="${BADGE_FS}" font-weight="${W_TITLE}" fill="#fff" letter-spacing="1">${esc(badge)}</text>`);
  els.push(`<text x="${PAD + badgeW + 10}" y="${y + 18}" font-size="${TITLE_FS}" font-weight="${W_TITLE}" fill="#fff" letter-spacing="0.5">${esc(title)}</text>`);
  return y + badgeH + 18;
}

/**
 * 主评论卡片区域（头像/作者/正文/图片网格/统计栏），返回元素与卡片底边
 * @param {any} comment 评论对象
 * @param {number} startY 起始 y
 * @param {number|string} [upMid] UP mid（用于「UP」徽标高亮，运行时按字符串比较）
 */
function renderMainCard(comment, startY, upMid = 0) {
  const els = [];
  let y = startY;
  const cardTop = y;
  const avatarY = cardTop + AVATAR_TOP;   // B站 实测 #body padding-top 22px
  const avatarR = AVATAR_SIZE / 2;        // 20
  const authorX = INNER_X + AVATAR_SIZE + AUTHOR_GAP; // 52+40+20=112（B站 80px 缩进节奏）
  // mid 统一转 String 比较（API 返回 number，调用方可能是字符串）
  const isUp = !!(comment.mid && upMid) && String(comment.mid) === String(upMid);

  els.push(`<image href="${esc(comment.avatar)}" x="${INNER_X}" y="${avatarY}" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" clip-path="url(#avatarClip)" preserveAspectRatio="xMidYMid slice"/>
    <circle cx="${INNER_X + avatarR}" cy="${avatarY + avatarR}" r="${avatarR}" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/>`);
  els.push(`<text x="${authorX}" y="${avatarY + 15}" font-size="${AUTHOR_FS}" font-weight="${W_NAME}" fill="#fff">${esc(comment.author)}</text>`);
  const authorW = measureText(comment.author, AUTHOR_FS);
  if (isUp) {
    const tagX = authorX + authorW + 6;
    els.push(`<rect x="${tagX}" y="${avatarY + 1}" width="40" height="16" rx="8" fill="url(#pink)"/>`);
    els.push(`<text x="${tagX + 20}" y="${avatarY + 12}" font-size="10" font-weight="${W_TITLE}" fill="#fff" text-anchor="middle">UP主</text>`);
  }
  els.push(`<text x="${authorX}" y="${avatarY + 32}" font-size="${TIME_FS}" fill="${TEXT_DIM}">${fmtTime(comment.ctime)}</text>`);

  y = cardTop + AVATAR_TOP + AVATAR_SIZE;

  const bodyFs = BODY_FS;   // B站 实测正文字号 15px
  const bodyLines = wrapTokens(comment._tokens, INNER_W, bodyFs);
  y = renderLines(els, y, bodyLines, { x: INNER_X, fs: bodyFs, lineH: bodyFs * LINE_H, emoteImgs: comment._emoteImgs }).y;

  if (comment.pictures && comment.pictures.length) {
    y += IMG_GAP_TOP;
    // 单图按原图比例完整展开（竖图不再被 320x240 裁剪）
    const pb = pictureBlock(comment.pictures, comment._picImgs || [], comment._picSizes, { x: INNER_X, y, maxW: INNER_W, maxSingleH: 480 });
    els.push(pb.svg);
    y += pb.h;
  }

  y += 18; // 底部留白（统计栏已移除）
  const cardBottom = y;
  els.push(`<rect x="${PAD}" y="${cardTop}" width="${CARD_W}" height="${cardBottom - cardTop}" rx="${CARD_RX}" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`);
  return { els, cardBottom };
}

/** 页脚，返回更新后的 y */
function renderFooter(els, y, left, right) {
  y += 16;
  els.push(`<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="rgba(255,255,255,0.15)" stroke-width="1" stroke-dasharray="4 4"/>`);
  y += 16;
  els.push(`<text x="${PAD}" y="${y}" font-size="${META_FS}" fill="${TEXT_DIMMER}" letter-spacing="1">${esc(left)}</text>`);
  els.push(`<text x="${W - PAD}" y="${y}" font-size="${META_FS}" fill="${TEXT_DIMMER}" text-anchor="end">${esc(right)}</text>`);
  return y + PAD;
}

/** 互动链中的单个评论块（被UP回复/UP回复/被UP点赞），返回更新后的 y */
function renderChainBlock(els, y, item, role, isUp) {
  y += ROW_PAD_TOP;
  const rTop = y;
  const lines = wrapTokens(item._tokens || [], ROW_INNER_W, ROW_FS);
  const textH = Math.max(lines.length * ROW_LH, ROW_MIN_BODY_H);
  // 评论自带图片（互动链中此前丢失，现补全渲染）
  const pics = item.pictures || [];
  let imgH = 0;
  let imgBlock = '';
  if (pics.length) {
    const maxImgW = (PAD + ROW_W - ROW_PAD_X) - ROW_NAME_X;   // 图片可用宽度
    const lastBase = rTop + ROW_BODY_DY + lines.length * ROW_LH; // 正文最后一行基线
    const pb = pictureBlock(pics, item._picImgs || [], item._picSizes, {
      x: ROW_NAME_X, y: lastBase + CHAIN_IMG_DY, maxW: maxImgW, maxSingleH: 400, cellMax: 169,
    });
    imgH = pb.h;
    imgBlock = pb.svg;
  }
  // itemH：上内边距 + 名字区 + 正文 + 图片(如有) + 元信息行 + 下内边距
  const itemH = ROW_PAD_TOP + ROW_PAD_TOP + textH + (imgH ? imgH + CHAIN_IMG_DY : 0) + ROW_META_BOTTOM + ROW_PAD_BOTTOM;
  const bg = isUp ? 'rgba(251,114,153,0.08)' : 'rgba(255,255,255,0.05)';
  const border = isUp ? 'rgba(251,114,153,0.35)' : 'rgba(255,255,255,0.08)';
  els.push(`<rect x="${PAD}" y="${rTop}" width="${ROW_W}" height="${itemH}" rx="12" fill="${bg}" stroke="${border}" stroke-width="1"/>`);
  if (isUp) els.push(`<rect x="${PAD}" y="${rTop}" width="3.5" height="${itemH}" rx="1.75" fill="${PINK}"/>`);
  els.push(`<image href="${esc(item.avatar)}" x="${PAD + ROW_PAD_X}" y="${rTop + ROW_PAD_TOP}" width="${ROW_AVATAR}" height="${ROW_AVATAR}" clip-path="url(#avatarClipSm)" preserveAspectRatio="xMidYMid slice"/>`);
  els.push(`<text x="${ROW_NAME_X}" y="${rTop + ROW_NAME_DY * 2}" font-size="${REPLY_AUTHOR_FS}" font-weight="${W_NAME_S}" fill="${TEXT_SUB}">${esc(item.author)}</text>`);
  const nw = measureText(item.author, REPLY_AUTHOR_FS);
  const roleW = measureText(role, ROLE_FS) + 12;
  const roleX = ROW_NAME_X + nw + 6;
  const roleBg = isUp ? 'rgba(251,114,153,0.25)' : 'rgba(153,147,184,0.25)';
  const roleColor = isUp ? PINK : TEXT_SUB;
  els.push(`<rect x="${roleX}" y="${rTop + ROW_PAD_TOP}" width="${roleW}" height="16" rx="8" fill="${roleBg}"/>`);
  els.push(`<text x="${roleX + roleW / 2}" y="${rTop + ROW_PAD_TOP + 11.5}" font-size="${ROLE_FS}" fill="${roleColor}" text-anchor="middle">${esc(role)}</text>`);
  renderLines(els, rTop + ROW_BODY_DY, lines, { x: ROW_NAME_X, fs: ROW_FS, lineH: ROW_LH, emoteImgs: item._emoteImgs });
  if (imgBlock) els.push(imgBlock);
  els.push(`<text x="${ROW_NAME_X}" y="${rTop + itemH - ROW_META_BOTTOM}" font-size="${META_FS}" fill="${TEXT_DIMMER}">${fmtTime(item.ctime)} · ${fmtCount(item.like)} 赞</text>`);
  return rTop + itemH;
}

/** 提示块（高度预算触顶截断 / 空态占位，两者视觉一致），返回更新后的 y */
function renderNote(els, y, text) {
  y += NOTE_PAD_TOP;
  els.push(`<rect x="${PAD}" y="${y}" width="${CARD_W}" height="${NOTE_H}" rx="12" fill="rgba(255,255,255,0.05)"/>`);
  els.push(`<text x="${PAD + ROW_PAD_X}" y="${y + NOTE_TEXT_DY}" font-size="${SECTION_FS}" fill="${TEXT_DIM}">${esc(text)}</text>`);
  return y + NOTE_ADVANCE;
}

module.exports = {
  svgShell, defsSvg, renderTitleBar, renderSectionHeader, renderLines, pictureBlock,
  renderItemList, chainNodes, renderReplyRow,
  renderMainCard, renderFooter, renderChainBlock, renderNote,
};
