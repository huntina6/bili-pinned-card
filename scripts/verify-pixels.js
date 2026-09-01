'use strict';
/**
 * 像素级验证：检查卡片 PNG 中头像区域与正文起始位置
 * 用法: node scripts/verify-pixels.js <png路径>
 * 输出 JSON：头像区域是否有非背景像素、正文首行起始 x、文本行像素占比
 */
const fs = require('fs');
const { parsePng } = require('../lib/png');

function regionStats(px, W, x0, y0, w, h) {
  let n = 0, r = 0, g = 0, b = 0, bright = 0;
  for (let y = y0; y < Math.min(y0 + h, W.height); y++) {
    for (let x = Math.max(0, x0); x < Math.min(x0 + w, W.width); x++) {
      const i = (y * W.width + x) * 4;
      const R = px[i], G = px[i + 1], B = px[i + 2], A = px[i + 3];
      if (A < 128) continue;
      n++; r += R; g += G; b += B;
      if (R + G + B > 400) bright++;
    }
  }
  return { n, bright, avg: n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null };
}

const file = process.argv[2];
const { width, height, px } = parsePng(fs.readFileSync(file));
// 布局常量（与 lib/card.js 保持同源，避免硬编码漂移）
const card = require('../lib/card');
const { PAD, INNER_PAD, INNER_X, AVATAR_SIZE, AVATAR_TOP, BODY_FS } = card;
const scale = width / 680; // 2x 输出
const s = v => Math.round(v * scale);

// 1. 头像区域：标题栏 y=30+24+18=72，cardTop=72，avatarY=72+22=94（B站 实测 22px 顶部内边距、40px 头像）
const avX = s(INNER_X), avY = s(72 + AVATAR_TOP), avW = s(AVATAR_SIZE);
const av = regionStats(px, { width, height }, avX, avY, avW, avW);
// 背景色大约 #2b2140~#1a1530（平均约 (36,27,56)），头像应明显不同（肤色/彩色/白色）
const bgDiff = av.avg ? Math.abs(av.avg[0] - 36) + Math.abs(av.avg[1] - 27) + Math.abs(av.avg[2] - 56) : -1;

// 2. 正文首行：baseline = 94+40+15*1.8 = 161 → 文字像素在 y≈154~162
const baseline = 72 + AVATAR_TOP + AVATAR_SIZE + BODY_FS * 1.8;
const bodyY0 = s(baseline - 7), bodyY1 = s(baseline + 1);
let firstTextX = -1, lastTextX = -1;
for (let x = s(40); x < s(620); x++) {
  let hit = false;
  for (let y = bodyY0; y <= bodyY1; y++) {
    const i = (y * width + x) * 4;
    if (px[i] + px[i + 1] + px[i + 2] > 500) { hit = true; break; }
  }
  if (hit) { if (firstTextX < 0) firstTextX = x; lastTextX = x; }
}
const expectStart = s(INNER_X); // 文字应从 52 开始
const drift = firstTextX >= 0 ? firstTextX - expectStart : -1;

console.log(JSON.stringify({
  size: `${width}x${height}`,
  avatar: { avgColor: av.avg, brightPixels: av.bright, total: av.n, bgDiff },
  avatarVisible: bgDiff > 30,
  bodyFirstLine: { firstTextX, expectStart, driftPx: drift },
  bodyAligned: drift >= 0 && drift <= 4,
}, null, 2));
