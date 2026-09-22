'use strict';
/** 图片下载缓存与卡片图片预处理（唯一触碰 lib/api 图片能力的模块） */
const { downloadImage, mimeFromBuffer, imageSize, imgVariant } = require('../api');
const { tokenize } = require('./text');
const { isEmojiUrl, disableEmoji, emojiEnabled } = require('./emoji');
const logger = require('../logger');

// 下载失败 URL 告警去重（防监控长跑反复刷屏；上限防内存无界）
const _failedLogged = new Set();
function warnDownloadFailed(url) {
  if (_failedLogged.has(url)) return;
  if (_failedLogged.size >= 200) _failedLogged.clear();
  _failedLogged.add(url);
  logger.warn('图片下载失败已降级: ' + logger.sanitizeUrl(url));
}

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
      warnDownloadFailed(url); // 记录失败 URL（去重），便于排查哪张图挂了
      if (isEmojiUrl(url)) disableEmoji(); // emoji CDN 不可达 → 熔断，后续回退文本
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
/** 按原图比例计算单图显示尺寸（不裁剪；不超过原图宽度，超长等比缩到 maxH） */
function fitSinglePic(w, h, maxW, maxH) {
  if (!w || !h) return { w: Math.min(320, maxW), h: Math.min(320, maxW) * 0.75 };
  let iw = Math.max(1, Math.min(320, maxW, w));
  let ih = Math.max(1, Math.round(iw * (h / w)));
  if (ih > maxH) { ih = maxH; iw = Math.max(1, Math.round(ih * (w / h))); }
  return { w: iw, h: ih };
}

// ====== 图床缩略图（降低下载量/内存/SVG 体积；CDN 的 w/h 为最大限制，不会放大原图） ======
const AVATAR_REQ = 80; // 40px 头像 × 2x
const PIC_REQ = 640;   // 单图/网格显示最大 320 逻辑宽 × 2x
function picVariant(url) { return imgVariant(url, { w: PIC_REQ }); }
function avatarVariant(url) { return imgVariant(url, { w: AVATAR_REQ, h: AVATAR_REQ, crop: true }); }

/** 预下载单个评论节点的表情/头像/配图（并发；幂等，防止同一节点被多个分组重复处理） */
async function prepareNode(node) {
  if (!node || node._prepared) return;
  node._prepared = true;
  node._tokens = tokenize(node.message, node.emote);
  node._emoteImgs = {};
  const emotes = node._tokens.filter(t => t.type === 'emote' && t.url && (!t.unicode || emojiEnabled()));
  const pics = (node.pictures || []).map(picVariant);
  const [emoteImgs, picImgs, picSizes] = await Promise.all([
    Promise.all(emotes.map(t => dataUri(t.url))),
    Promise.all(pics.map(u => dataUri(u))),
    Promise.all(pics.map(u => picSize(u))),
  ]);
  emotes.forEach((t, i) => { node._emoteImgs[t.key] = emoteImgs[i]; });
  node._picImgs = picImgs;
  node._picSizes = picSizes;
  if (node.avatar) node.avatar = await dataUri(avatarVariant(node.avatar));
}

/**
 * 预下载所有远程图片并注入 comment/replies（下载失败置空，渲染时降级为占位/文本）
 */
async function prepareImages(comment, replies) {
  await Promise.all([comment, ...replies].map(prepareNode));
}

/** 预下载互动链中所有头像/表情/图片（并发 + 节点去重） */
async function prepareChainItems(items) {
  const nodes = [];
  for (const it of items) {
    for (const node of [it.parent, it.upReply]) if (node) nodes.push(node);
  }
  await Promise.all(nodes.map(prepareNode));
}

/** 预下载 UP 热评卡所需全部图片（comment + fans 走 prepareImages，items 走 prepareChainItems） */
async function prepareUpTopCard(comment, items, fans) {
  await prepareImages(comment, fans);
  await prepareChainItems(items);
}

module.exports = {
  imgCache, bufCache, CACHE_MAX, cacheSet, fetchBuf, dataUri, picSize,
  fitSinglePic, picVariant, avatarVariant, prepareNode,
  prepareImages, prepareChainItems, prepareUpTopCard,
};
