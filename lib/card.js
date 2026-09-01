'use strict';
/**
 * 置顶评论卡片渲染器聚合出口 —— 分层于 lib/card/ 目录
 * constants（设计常量）/ text（文本工具）/ image（图片预处理）/ layout（布局原语）/ templates（四类卡模板）
 * 保留本文件 re-export 以兼容 cli.js / scripts / test 的现有 require 路径。
 */
module.exports = {
  ...require('./card/constants'),
  ...require('./card/text'),
  ...require('./card/image'),
  ...require('./card/layout'),
  ...require('./card/templates'),
};
