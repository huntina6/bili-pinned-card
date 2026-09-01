'use strict';
/** 图片下载缓存与卡片图片预处理（唯一触碰 lib/api 图片能力的模块） */
const { downloadImage, mimeFromBuffer, imageSize } = require('../api');
const { tokenize } = require('./text');

// ====== 图片下载缓存（有界 LRU，防止监控长跑内存无界增长） ======
const imgCache = new Map();       // url -> data URI（Promise）
const bufCache = new Map();       // url -> Buffer（Promise，供尺寸解析复用）
const CACHE_MAX = 200;            // 单缓存容量上限（超出淘汰最旧）
/** 写入缓存并按容量淘汰最旧条目（两张缓存同步淘汰同 key） */
function cacheSet(map, url, p) {
  if (map.has(url)) map.delete(url); // 重复写入刷新为最近使用
  map.set(url, p);
  if (map.size > CACHE_MAX) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
    const other = map === imgCache ? bufCache : imgCache;
    if (other.has(oldest)) other.delete(oldest);
  }
}
/** 下载原始图片 buffer（带缓存；失败返回 null 且不缓存，允许下次重试） */
function fetchBuf(url) {
  if (!url) return Promise.resolve(null);
  if (bufCache.has(url)) return bufCache.get(url);
  const p = downloadImage(url).then(b => {
    if (!b) { // 失败不缓存，避免网络瞬时故障导致图片在本进程内永久缺失
      bufCache.delete(url);
      imgCache.delete(url);
      return null;
    }
    return b;
  });
  cacheSet(bufCache, url, p);
  return p;
}
/** 下载图片并转 data URI（带缓存；失败返回 ''） */
async function dataUri(url) {
  if (!url) return '';
  if (imgCache.has(url)) return imgCache.get(url);
  const p = fetchBuf(url).then(buf => {
    if (!buf) return '';
    return `data:${mimeFromBuffer(buf)};base64,${buf.toString('base64')}`;
  });
  cacheSet(imgCache, url, p);
  return p;
}
/** 解析图片实际尺寸（带缓存；失败返回 null） */
async function picSize(url) {
  const buf = await fetchBuf(url);
  return buf ? imageSize(buf) : null;
}
/** 按原图比例计算单图显示尺寸（不裁剪；超长等比缩到 maxH） */
function fitSinglePic(w, h, maxW, maxH) {
  if (!w || !h) return { w: Math.min(320, maxW), h: Math.min(320, maxW) * 0.75 };
  let iw = Math.min(320, maxW);
  let ih = Math.round(iw * (h / w));
  if (ih > maxH) { ih = maxH; iw = Math.round(ih * (w / h)); }
  return { w: iw, h: ih };
}

/**
 * 预下载所有远程图片并注入 comment/replies（下载失败置空，渲染时降级为占位/文本）
 */
async function prepareImages(comment, replies) {
  comment._tokens = tokenize(comment.message, comment.emote);
  comment._emoteImgs = {};
  for (const t of comment._tokens) {
    if (t.type === 'emote' && t.url) comment._emoteImgs[t.key] = await dataUri(t.url);
  }
  comment._picImgs = await Promise.all((comment.pictures || []).map(u => dataUri(u)));
  comment._picSizes = await Promise.all((comment.pictures || []).map(u => picSize(u)));
  if (comment.avatar) comment.avatar = await dataUri(comment.avatar);
  for (const r of replies) {
    r._tokens = tokenize(r.message, r.emote);
    r._emoteImgs = {};
    for (const t of r._tokens) {
      if (t.type === 'emote' && t.url) r._emoteImgs[t.key] = await dataUri(t.url);
    }
    r._picImgs = await Promise.all((r.pictures || []).map(u => dataUri(u)));
    r._picSizes = await Promise.all((r.pictures || []).map(u => picSize(u)));
    if (r.avatar) r.avatar = await dataUri(r.avatar);
  }
}

/** 预下载互动链中所有头像/表情/图片 */
async function prepareChainItems(items) {
  for (const it of items) {
    for (const node of [it.parent, it.upReply]) {
      if (!node) continue;
      node._tokens = tokenize(node.message, node.emote);
      node._emoteImgs = {};
      for (const t of node._tokens) {
        if (t.type === 'emote' && t.url) node._emoteImgs[t.key] = await dataUri(t.url);
      }
      if (node.avatar) node.avatar = await dataUri(node.avatar);
      node._picImgs = await Promise.all((node.pictures || []).map(u => dataUri(u)));
      node._picSizes = await Promise.all((node.pictures || []).map(u => picSize(u)));
    }
  }
}

/** 预下载 UP 热评卡所需全部图片（comment + fans 走 prepareImages，items 走 prepareChainItems） */
async function prepareUpTopCard(comment, items, fans) {
  await prepareImages(comment, fans);
  await prepareChainItems(items);
}

module.exports = {
  imgCache, bufCache, CACHE_MAX, cacheSet, fetchBuf, dataUri, picSize,
  fitSinglePic, prepareImages, prepareChainItems, prepareUpTopCard,
};
