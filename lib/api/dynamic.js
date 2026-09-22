'use strict';
/** 动态相关：评论对象参数提取、opus 链接转换、置顶/全账号动态检索 */
const { BiliError, apiGet } = require('./client');
const { isOpusLink, isDynamicLink, isBareDynamicId, extractId } = require('./util');
const { normUrl } = require('./image');

/**
 * 提取动态对应的评论对象参数（oid/type）
 * 优先取 basic.comment_id_str/comment_type（B站 权威评论对象参数）：
 * opus/图文动态的 id_str ≠ 评论 oid（如 id_str=1232243387332034584 vs comment_id_str=407750907），
 * 仅按 major.type 推断会取到动态 ID，导致拉到空评论区。
 */
function extractReplyParams(item) {
  const dynId = item.id_str || String(item.id);
  const basic = item.basic;
  if (basic?.comment_id_str) {
    const t = Number(basic.comment_type);
    return { oid: String(basic.comment_id_str), type: Number.isFinite(t) && t > 0 ? t : 11 };
  }
  const major = item.modules?.module_dynamic?.major;
  if (!major || major.type === 'MAJOR_TYPE_NONE') return { oid: dynId, type: 11 };
  switch (major.type) {
    case 'MAJOR_TYPE_DRAW':    return { oid: String(major.draw.id), type: 11 };
    case 'MAJOR_TYPE_ARCHIVE': return { oid: String(major.archive.aid || major.archive.id), type: 1 };
    case 'MAJOR_TYPE_ARTICLE': return { oid: String(major.article.id), type: 12 };
    case 'MAJOR_TYPE_MUSIC':   return { oid: String(major.music.id), type: 14 };
    default:                   return { oid: dynId, type: 11 };
  }
}

/**
 * 解析动态链接/ID → 评论区 oid（opus/t.bilibili.com 链接自动查动态详情转换）
 *
 * 行为一致性保证（修复 P1）：链接输入与「裸动态 ID 数字」输入走同一条转换路径。
 * 此前裸数字直接透传 dynId，导致同一动态用链接输 vs 用裸数字输结果不一致
 * （dynId ≠ 评论 oid，会拉到空评论区且不报错）。
 *
 * 回退策略：裸数字的详情转换失败时（该 oid 本就是评论 oid / 网络异常 /
 * 风控 -352·-412），安全回退为原值透传，保持 `--oid 404135596` 等既有用法可用。
 *
 * @param {string} input 动态链接或 ID（支持 t.bilibili.com / bilibili.com/dynamic / bilibili.com/opus / 裸动态 ID）
 * @param {string} [cookie] 可选 Cookie（匿名详情接口易被风控 -352，带 Cookie 成功率更高）
 * @returns {Promise<{oid: string, type: number|null}>} type 为 null 表示无需转换（非链接输入）
 */
async function resolveCommentOid(input, cookie) {
  const s = String(input || '');
  const isLink = isOpusLink(s) || isDynamicLink(s);
  const isBare = isBareDynamicId(s);
  if (!isLink && !isBare) return { oid: extractId(s), type: null }; // 评论 oid 等：零开销向后兼容
  // 注意：链接分支必须直取 dynId，不能复用 extractId——
  // extractId 的评论 ID 正则最先匹配，若链接带 ?comment_root_id= 会误提取 rpid
  const dynId = isLink
    ? s.match(/(?:bilibili\.com\/(?:opus|dynamic)\/|t\.bilibili\.com\/)(\d+)/)?.[1]
    : s.trim();
  if (!dynId) throw new BiliError('动态链接无法解析动态 ID');
  let data;
  try {
    data = await apiGet(`/x/polymer/web-dynamic/v1/detail?id=${dynId}`, { cookie });
  } catch (err) {
    if (isLink) {
      // 链接输入：用户明确提供的是动态链接，转换失败即确认为错误（保留原有友好提示）
      // 注意：必须判断 err.code（apiGet 抛的 message 形如 "API code=-400: ..."，
      // 用 /^-400/ 匹配 message 永远不成立——原实现此处为死代码，v1.4.1 修正）
      if (err.code === -400) {
        throw new BiliError(`链接中的动态 ID（${dynId}）无法被 B站 接口解析（可能链接无效、已删除或为 App 内新版 ID），请从 B站 重新复制动态链接后重试`);
      }
      throw err;
    }
    // 裸数字输入：无法确认是动态 ID（可能就是评论 oid）或接口异常 → 安全回退透传
    return { oid: dynId, type: null };
  }
  const item = data.data?.item;
  if (!item) {
    // 详情查无此对象：链接输入报错；裸数字输入回退透传（可能是评论 oid）
    if (isLink) throw new BiliError(`动态 ${dynId} 详情获取失败（可能已删除）`);
    return { oid: dynId, type: null };
  }
  return extractReplyParams(item);
}

const SPACE_FEATURES = 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,forwardListHidden,decorationCard,commentsNewVersion,onlyfansAssetsV2,ugcDelete,onlyfansQaCard';

/** 用户空间动态请求路径（features/web_location 为 B站 web 端标准参数，保证 opus 条目结构稳定） */
function spaceFeedPath(uid, offset) {
  return `/x/polymer/web-dynamic/v1/feed/space?host_mid=${uid}&features=${SPACE_FEATURES}&web_location=333.1387${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`;
}

/** 是否为置顶动态（置顶条目自带「置顶」标签） */
function isPinnedItem(it) {
  return (it.modules?.module_tag?.text || '').includes('置顶');
}

/**
 * 获取指定 UP 的置顶动态（需要 Cookie，匿名会被风控 -352）
 * 注意：置顶条目排在 items 最前（不一定是最新），latest* 必须选未标记置顶的第一条
 * @returns {Promise<{dynId: string, oid: string, type: number|null, author: string, authorMid: (number|string|null), pinned: boolean,
 *   latestId: string, latestDesc: string, latestImages: string[], latestTs: number,
 *   latestAuthor: string, latestMid: (number|string|null), latestFace: string}>}
 */
async function getPinnedDynamic(uid, cookie) {
  const data = await apiGet(spaceFeedPath(uid), {
    cookie,
    referer: `https://space.bilibili.com/${uid}`,
  });
  const items = data.data?.items || [];
  if (!items.length) throw new BiliError('动态列表为空（该用户可能没有动态）');
  const pinnedItem = items.find(isPinnedItem) || items[0];
  const latest = items.find(it => !isPinnedItem(it)) || pinnedItem;
  const { oid, type } = extractReplyParams(pinnedItem);
  const lc = extractDynamicContent(latest);
  return {
    dynId: pinnedItem.id_str || String(pinnedItem.id),
    oid,
    type,
    author: pinnedItem.modules?.module_author?.name || '',
    authorMid: pinnedItem.modules?.module_author?.mid ?? null,
    pinned: isPinnedItem(pinnedItem),
    latestId: latest.id_str || String(latest.id),
    latestDesc: lc.desc,
    latestImages: lc.images,
    latestTs: latest.modules?.module_author?.pub_ts || 0,
    latestAuthor: latest.modules?.module_author?.name || '',
    latestMid: latest.modules?.module_author?.mid ?? null,
    latestFace: normUrl(latest.modules?.module_author?.face || ''),
  };
}

/**
 * 分页拉取指定账号的全部动态（需要 Cookie，匿名会被风控 -352）
 * @param {number|string} uid 账号 UID
 * @param {string} cookie SESSDATA Cookie
 * @param {number} maxDyns 最大拉取条数（默认不限制）
 * @returns {Promise<{dyns: Array<{dynId,oid,type,author,authorMid,ctime}>, total: number}>}
 */
async function getAllDynamics(uid, cookie, maxDyns = Infinity) {
  const dyns = [];
  let offset = '';
  for (;;) {
    const data = await apiGet(spaceFeedPath(uid, offset), { cookie, referer: `https://space.bilibili.com/${uid}` });
    const items = data.data?.items || [];
    for (const it of items) {
      const { oid, type } = extractReplyParams(it);
      dyns.push({
        dynId: it.id_str || String(it.id),
        oid,
        type,
        author: it.modules?.module_author?.name || '',
        authorMid: it.modules?.module_author?.mid ?? null,
        ctime: it.modules?.module_author?.pub_ts || 0,
      });
    }
    if (dyns.length >= maxDyns) { dyns.length = maxDyns; break; }
    if (!data.data?.has_more || !data.data?.offset) break;
    offset = data.data.offset;
  }
  return { dyns, total: dyns.length };
}

/** 从动态条目提取展示内容（正文/图片），供普通动态更新卡片使用 */
function extractDynamicContent(item) {
  const major = item.modules?.module_dynamic?.major;
  const desc = item.modules?.module_dynamic?.desc?.text || '';
  if (!major || major.type === 'MAJOR_TYPE_NONE') {
    // 纯文本动态：desc 即正文
    return { desc: desc || '（纯文本动态）', images: [] };
  }
  switch (major.type) {
    case 'MAJOR_TYPE_DRAW':
      return {
        desc: desc || (major.draw.items?.[0]?.description || '（图片动态）'),
        images: (major.draw.items || []).map(i => normUrl(i.src)).filter(Boolean),
      };
    case 'MAJOR_TYPE_ARCHIVE':
      return {
        desc: desc || major.archive.title || '',
        images: [normUrl(major.archive.cover || '')].filter(Boolean),
      };
    case 'MAJOR_TYPE_ARTICLE':
      return { desc: desc || major.article.title || '', images: [] };
    case 'MAJOR_TYPE_OPUS': {
      const opus = major.opus || {};
      return {
        desc: desc || opus.summary?.text || opus.title || '（图文动态）',
        images: (opus.pics || []).map(i => normUrl(i.url)).filter(Boolean),
      };
    }
    default:
      return { desc: desc || '（动态）', images: [] };
  }
}

module.exports = {
  extractReplyParams,
  resolveCommentOid,
  getPinnedDynamic,
  getAllDynamics,
  extractDynamicContent,
};
