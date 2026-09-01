'use strict';
/** 布局原语：SVG defs / 标题栏 / 主评论卡 / 互动链块 / 页脚 */
const {
  W, PAD, CARD_W, CARD_RX, INNER_X, INNER_W,
  TEXT_INNER, TEXT_DIM, TEXT_DIMMER, TEXT_SUB, PINK,
  TITLE_FS, BADGE_FS, AUTHOR_FS, REPLY_AUTHOR_FS, BODY_FS,
  META_FS, TIME_FS, ROLE_FS, SECTION_FS,
  W_TITLE, W_SECTION, W_NAME, W_NAME_S,
  AVATAR_SIZE, AVATAR_TOP, AUTHOR_GAP, LINE_H,
} = require('./constants');
const { esc, fmtCount, fmtTime, measureText, wrapTokens, lineToSvg } = require('./text');
const { fitSinglePic } = require('./image');

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

/** 主评论卡片区域（头像/作者/正文/图片网格/统计栏），返回元素与卡片底边 */
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
  const bodyLh = bodyFs * LINE_H;
  for (const line of bodyLines) {
    y += bodyLh;
    els.push(lineToSvg(line, bodyFs, INNER_X, y, comment._emoteImgs || {}));
  }

  if (comment.pictures && comment.pictures.length) {
    y += 12;
    const pics = comment.pictures;
    const picImgs = comment._picImgs || [];
    if (pics.length === 1) {
      // 单图：按原图比例完整展开（竖图不再被 320x240 裁剪）
      const sz = (comment._picSizes || [])[0] || null;
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
  y += 12;
  const rTop = y;
  const rw = CARD_W - 28;
  const rInnerW = rw - 34 - 10;
  const rFs = 13.5;
  const rLh = rFs * 1.7;
  const lines = wrapTokens(item._tokens || [], rInnerW, rFs);
  const textH = Math.max(lines.length * rLh, 34);
  const nameX = PAD + 14 + 34 + 10;
  // 评论自带图片（互动链中此前丢失，现补全渲染）
  const pics = item.pictures || [];
  const picImgs = item._picImgs || [];
  let imgH = 0;
  let imgBlock = '';
  if (pics.length) {
    const maxImgW = (PAD + rw - 14) - nameX;   // 图片可用宽度
    const lastBase = rTop + 34 + lines.length * rLh; // 正文最后一行基线
    const imgY = lastBase + 10;
    if (pics.length === 1) {
      const sz = (item._picSizes || [])[0] || null;
      const f = fitSinglePic(sz?.width, sz?.height, maxImgW, 400);
      imgH = f.h;
      imgBlock += `<image href="${esc(picImgs[0] || '')}" x="${nameX}" y="${imgY}" width="${f.w}" height="${f.h}" clip-path="url(#imgClipBig)" preserveAspectRatio="xMidYMid slice"/>`;
      if (!picImgs[0]) imgBlock += `<rect x="${nameX}" y="${imgY}" width="${f.w}" height="${f.h}" rx="10" fill="rgba(255,255,255,0.06)"/>`;
    } else {
      const cell = Math.min(169, (maxImgW - 12) / 3);
      const rows = Math.ceil(pics.length / 3);
      imgH = rows * (cell + 6) - 6;
      pics.forEach((_, i) => {
        const cx = nameX + (i % 3) * (cell + 6);
        const cy = imgY + Math.floor(i / 3) * (cell + 6);
        imgBlock += `<image href="${esc(picImgs[i] || '')}" x="${cx}" y="${cy}" width="${cell}" height="${cell}" clip-path="url(#imgClip)" preserveAspectRatio="xMidYMid slice"/>`;
        if (!picImgs[i]) imgBlock += `<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="10" fill="rgba(255,255,255,0.06)"/>`;
      });
    }
  }
  // itemH：上边距 + 名字区 + 正文 + 图片(如有) + 元信息行 + 下边距
  const itemH = 12 + 12 + textH + (imgH ? imgH + 10 : 0) + 16 + 22;
  const bg = isUp ? 'rgba(251,114,153,0.08)' : 'rgba(255,255,255,0.05)';
  const border = isUp ? 'rgba(251,114,153,0.35)' : 'rgba(255,255,255,0.08)';
  els.push(`<rect x="${PAD}" y="${rTop}" width="${rw}" height="${itemH}" rx="12" fill="${bg}" stroke="${border}" stroke-width="1"/>`);
  if (isUp) els.push(`<rect x="${PAD}" y="${rTop}" width="3.5" height="${itemH}" rx="1.75" fill="${PINK}"/>`);
  els.push(`<image href="${esc(item.avatar)}" x="${PAD + 14}" y="${rTop + 12}" width="34" height="34" clip-path="url(#avatarClipSm)" preserveAspectRatio="xMidYMid slice"/>`);
  els.push(`<text x="${nameX}" y="${rTop + 24}" font-size="${REPLY_AUTHOR_FS}" font-weight="${W_NAME_S}" fill="${TEXT_SUB}">${esc(item.author)}</text>`);
  const nw = measureText(item.author, REPLY_AUTHOR_FS);
  const roleW = measureText(role, ROLE_FS) + 12;
  const roleX = nameX + nw + 6;
  const roleBg = isUp ? 'rgba(251,114,153,0.25)' : 'rgba(153,147,184,0.25)';
  const roleColor = isUp ? PINK : TEXT_SUB;
  els.push(`<rect x="${roleX}" y="${rTop + 12}" width="${roleW}" height="16" rx="8" fill="${roleBg}"/>`);
  els.push(`<text x="${roleX + roleW / 2}" y="${rTop + 23.5}" font-size="${ROLE_FS}" fill="${roleColor}" text-anchor="middle">${esc(role)}</text>`);
  let ly = rTop + 12 + 18 + 4;
  for (const line of lines) {
    ly += rLh;
    els.push(lineToSvg(line, rFs, nameX, ly, item._emoteImgs || {}));
  }
  if (imgBlock) els.push(imgBlock);
  els.push(`<text x="${nameX}" y="${rTop + itemH - 16}" font-size="${META_FS}" fill="${TEXT_DIMMER}">${fmtTime(item.ctime)} · ${fmtCount(item.like)} 赞</text>`);
  return rTop + itemH;
}

module.exports = {
  defsSvg, renderTitleBar, renderMainCard, renderFooter, renderChainBlock,
};
