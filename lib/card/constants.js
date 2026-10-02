'use strict';
/**
 * 设计常量（逻辑像素 680 宽，渲染时 2x 输出保证清晰度）
 * 布局参考：B站 Opus 评论区实测（ego-browser 采集 2026-09-02）——
 * 主楼 #body padding 22px 0 0 80px、头像 40×40、正文字号 15px（--bili-comments-font-size-content）
 */

const W = 680;
const PAD = 30;
const CARD_W = W - PAD * 2;          // 620
const CARD_RX = 18;
const INNER_PAD = 22;                // 卡片内边距
const INNER_X = PAD + INNER_PAD;     // 52
const INNER_W = CARD_W - INNER_PAD * 2; // 576
const TEXT_INNER = '#f5f3fc';
const TEXT_DIM = '#9a93b8';
const TEXT_DIMMER = '#8a84a8';       // 贴近 B站 #9499A0 亮度（时间/赞可读性）
const TEXT_SUB = '#c9c2e0';
const PINK = '#FB7299';
const LINE_H = 1.8;
// 字号（对齐 B站 实测：正文 15px；其余为卡片层级）
const TITLE_FS = 16, BADGE_FS = 12, AUTHOR_FS = 14.5, REPLY_AUTHOR_FS = 12.5,
      BODY_FS = 15, REPLY_FS = 13.5, SECTION_FS = 13, META_FS = 11, TIME_FS = 11.5, ROLE_FS = 10.5;
// 字重（对齐 B站：正文/用户名 500，标题/主作者 700）
const W_TITLE = 700, W_SECTION = 600, W_NAME = 700, W_NAME_S = 500, W_BODY = 500;
// 布局（对齐 B站 实测：头像 40×40、80px 缩进节奏 20+40+20、顶部内边距 22px）
const AVATAR_SIZE = 40;
const AVATAR_TOP = 22;
const AUTHOR_GAP = 20;
// 字体栈（B站 风格，含 Windows 双别名与兜底；resvg defaultFontFamily 兜底未命中）
const FONT_STACK = `'PingFang SC','Microsoft YaHei','微软雅黑','Hiragino Sans GB','Heiti SC','Helvetica Neue','Malgun Gothic',Arial,sans-serif`;

// ====== 回复条 / 互动块（置顶卡回复区与互动链共用同一套节奏） ======
const ROW_W = CARD_W - 28;                       // 回复条/互动块宽度 592
const ROW_PAD_X = 14;                            // 左内边距
const ROW_AVATAR = 34;                           // 头像尺寸
const ROW_AVATAR_GAP = 10;                       // 头像与正文间距
const ROW_NAME_X = PAD + ROW_PAD_X + ROW_AVATAR + ROW_AVATAR_GAP; // 88
const ROW_INNER_W = ROW_W - ROW_AVATAR - ROW_AVATAR_GAP;          // 548
const ROW_FS = REPLY_FS;                         // 正文 13.5
const ROW_LH = REPLY_FS * 1.7;                   // 行高 ≈23
const ROW_PAD_TOP = 12;                          // 上内边距
const ROW_NAME_DY = 12;                          // 名字基线相对块顶
const ROW_BODY_DY = 12 + 18 + 4;                 // 正文首行基线相对块顶 34
const ROW_META_BOTTOM = 16;                      // 元信息基线距块底
const ROW_PAD_BOTTOM = 22;                       // 下内边距
const ROW_MIN_BODY_H = 34;                       // 正文区最小高度（单行也保持与头像等高）

// ====== 区块标题与图片 ======
const SECTION_GAP_TOP = 16;                      // 区块与前文间距
const SECTION_GAP_BOTTOM = 8;                    // 标题到内容间距
const BADGE_H = 18;
const BADGE_PAD = 16;                            // 胶囊左右内边距
const BADGE_DY = 12;                             // 胶囊顶相对标题基线
const BADGE_TEXT_DY = 1;                         // 胶囊文字基线相对标题基线
const IMG_GAP = 6;                               // 图片网格间距
const IMG_GAP_TOP = 12;                          // 图片区与正文间距
const IMG_MAX_W = 320;                           // 单图最大显示宽
const IMG_CLIP_RX = 10;                          // 图片占位圆角
const NOTE_H = 42;                               // 提示块高度
const NOTE_PAD_TOP = 12;                         // 提示块与前文间距
const NOTE_ADVANCE = 54;                         // 提示块占用总高度（含间距）
const NOTE_TEXT_DY = 26;                         // 提示文字基线相对块顶

// UP 热评卡安全上限
const MAX_ITEMS_SAFE = 200; // 区域一全量渲染的安全硬上限（防 SVG 超高崩溃）
const MAX_LINES = 6;        // 单块正文行数上限
const MAX_CARD_H = 12000;   // 卡片逻辑高度预算（2x 渲染 ≈ 24000px；实测 12k 高约 260MB 内存，防 OOM）

/**
 * 按渲染倍率换算高度预算：保持总像素量与「2x/12000 逻辑高」相当，并限制物理高度 ≤ 40000px
 * （高倍率下自动收紧，防自定义分辨率导致内存暴涨/查看器打不开）
 * @param {number} [scale] 渲染倍率（默认 2）
 * @returns {number} 该倍率下允许的最大逻辑高度
 */
function maxCardHForScale(scale) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 2;
  const byPixels = (MAX_CARD_H * 4) / (s * s); // 总像素预算不变：W·MAX_CARD_H·4 / (W·s²)
  const byViewer = 40000 / s;                  // 物理高度上限 40000px
  return Math.max(1000, Math.round(Math.min(byPixels, byViewer)));
}

module.exports = {
  W, PAD, CARD_W, CARD_RX, INNER_PAD, INNER_X, INNER_W,
  TEXT_INNER, TEXT_DIM, TEXT_DIMMER, TEXT_SUB, PINK, LINE_H,
  TITLE_FS, BADGE_FS, AUTHOR_FS, REPLY_AUTHOR_FS, BODY_FS, REPLY_FS,
  SECTION_FS, META_FS, TIME_FS, ROLE_FS,
  W_TITLE, W_SECTION, W_NAME, W_NAME_S, W_BODY,
  AVATAR_SIZE, AVATAR_TOP, AUTHOR_GAP, FONT_STACK,
  ROW_W, ROW_PAD_X, ROW_AVATAR, ROW_AVATAR_GAP, ROW_NAME_X, ROW_INNER_W, ROW_FS, ROW_LH,
  ROW_PAD_TOP, ROW_NAME_DY, ROW_BODY_DY, ROW_META_BOTTOM, ROW_PAD_BOTTOM, ROW_MIN_BODY_H,
  SECTION_GAP_TOP, SECTION_GAP_BOTTOM, BADGE_H, BADGE_PAD, BADGE_DY, BADGE_TEXT_DY,
  IMG_GAP, IMG_GAP_TOP, IMG_MAX_W, IMG_CLIP_RX,
  NOTE_H, NOTE_PAD_TOP, NOTE_ADVANCE, NOTE_TEXT_DY,
  MAX_ITEMS_SAFE, MAX_LINES, MAX_CARD_H, maxCardHForScale,
};
