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

// UP 热评卡安全上限
const MAX_ITEMS_SAFE = 200; // 区域一全量渲染的安全硬上限（防 SVG 超高崩溃）
const MAX_LINES = 6;        // 单块正文行数上限

module.exports = {
  W, PAD, CARD_W, CARD_RX, INNER_PAD, INNER_X, INNER_W,
  TEXT_INNER, TEXT_DIM, TEXT_DIMMER, TEXT_SUB, PINK, LINE_H,
  TITLE_FS, BADGE_FS, AUTHOR_FS, REPLY_AUTHOR_FS, BODY_FS, REPLY_FS,
  SECTION_FS, META_FS, TIME_FS, ROLE_FS,
  W_TITLE, W_SECTION, W_NAME, W_NAME_S, W_BODY,
  AVATAR_SIZE, AVATAR_TOP, AUTHOR_GAP, FONT_STACK,
  MAX_ITEMS_SAFE, MAX_LINES,
};
