'use strict';
/**
 * 导出当前置顶评论卡片的 SVG 源码，供视觉模型/设计参考
 * 用法: node scripts/export-svg.js [oid] [输出路径]
 * 输出: output/card-debug.svg（默认）
 */
const fs = require('fs');
const path = require('path');
const api = require('../lib/api');
const card = require('../lib/card');

(async () => {
  const oid = process.argv[2] || '404135596';
  const outFile = process.argv[3] || path.join(__dirname, '..', 'output', 'card-debug.svg');

  const comment = await api.getPinnedComment(oid, 11); // type=11: 动态（与 cli.js 默认一致）
  if (!comment) {
    console.error('未获取到置顶评论（可能未置顶或风控）');
    process.exit(1);
  }
  // 与 cli.js 一致：先下载图片注入（头像/表情/评论图转 data URI）
  await card.prepareImages(comment, []);
  const svg = await card.buildSvg(comment, [], { upName: comment.author, upMid: 0, oid: Number(oid) });
  fs.writeFileSync(outFile, svg);
  console.log(`SVG 已导出: ${outFile} (${svg.length} 字节, ${svg.match(/height="(\d+)"/)[1]} 高)`);
})().catch(e => { console.error(e); process.exit(1); });
