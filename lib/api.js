'use strict';
/**
 * B站 API 层聚合出口 —— 按域拆分于 lib/api/ 目录
 * client（请求层）/ util（ID 解析）/ image（图片）/ dynamic（动态）/ comment（评论）/ wbi（签名）
 * 保留本文件 re-export 以兼容 cli.js / scripts / test 的现有 require 路径。
 */
module.exports = {
  ...require('./api/client'),
  ...require('./api/util'),
  ...require('./api/image'),
  ...require('./api/dynamic'),
  ...require('./api/comment'),
  ...require('./api/wbi'),
};
