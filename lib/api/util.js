'use strict';
/** 链接/ID 解析工具（纯函数） */

/** 从链接/裸输入中提取动态 ID 或评论 ID（提取失败原样返回） */
function extractId(v) {
  const s = String(v || '').trim();
  if (!s) return s;
  // 评论 ID 优先：评论分享链接形如 t.bilibili.com/<oid>?comment_root_id=<rpid>，
  // 若先匹配动态 ID 会把 rpid 误提取为 oid（评论链接模式失效）
  const rep = s.match(/comment_root_id=(\d+)|comment_id=(\d+)|#reply(\d+)/);
  if (rep) return rep[1] || rep[2] || rep[3];
  const dyn = s.match(/(?:t\.bilibili\.com|bilibili\.com)\/(?:dynamic\/)?(\d+)/);
  if (dyn) return dyn[1];
  // B站 新版 Opus 动态链接：bilibili.com/opus/<dynId>（dynId ≠ 评论 oid，需 resolveCommentOid 转换）
  const opus = s.match(/bilibili\.com\/opus\/(\d+)/);
  if (opus) return opus[1];
  return s;
}

/** 是否为 B站 新版 Opus 动态链接（其 dynId ≠ 评论 oid，需 resolveCommentOid 转换） */
function isOpusLink(v) {
  return /bilibili\.com\/opus\//i.test(String(v || ''));
}

module.exports = {
  extractId,
  isOpusLink,
};
