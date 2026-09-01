'use strict';
/** 评论相关：置顶/子回复/一级评论/UP 互动筛选（匿名可用为主） */
const { BiliError, apiGet } = require('./client');
const { normUrl } = require('./image');

/** 获取置顶评论（匿名可用；评论对象不存在/已删除时返回 null） */
async function getPinnedComment(oid, type, cookie) {
  let data;
  try {
    data = await apiGet(`/x/v2/reply?type=${type}&oid=${oid}&sort=2&ps=1`, {
      cookie,
      referer: `https://t.bilibili.com/${oid}`,
    });
  } catch (err) {
    // -404：评论区/对象不存在（如动态已删），视为"无置顶评论"，与上层降级路径一致
    if (err instanceof BiliError && err.code === -404) return null;
    throw err;
  }
  const top = data.data?.top_replies?.[0];
  if (!top) return null;
  const c = top.content || {};
  return {
    rpid: String(top.rpid),
    author: top.member?.uname || '',
    avatar: normUrl(top.member?.avatar || ''),
    mid: top.mid,
    ctime: top.ctime || 0,
    message: c.message || '',
    emote: c.emote || {},
    pictures: (c.pictures || []).map(p => normUrl(p.img_src)),
    like: top.like ?? 0,
    rcount: top.rcount ?? 0,
  };
}

/** 获取置顶评论下的子回复（匿名可用） */
async function getReplies(oid, type, rootRpid, max, cookie) {
  const data = await apiGet(`/x/v2/reply/reply?type=${type}&oid=${oid}&root=${rootRpid}&pn=1&ps=${max}`, {
    cookie,
    referer: `https://t.bilibili.com/${oid}`,
  });
  return (data.data?.replies || []).slice(0, max).map(r => ({
    rpid: String(r.rpid),
    author: r.member?.uname || '',
    avatar: normUrl(r.member?.avatar || ''),
    mid: r.mid,
    ctime: r.ctime || 0,
    message: r.content?.message || '',
    emote: r.content?.emote || {},
    like: r.like ?? 0,
  }));
}

/** 获取指定评论本体（detail 接口，root 参数；评论存在时匿名可用） */
async function getCommentDetail(oid, type, rpid, cookie) {
  const data = await apiGet(`/x/v2/reply/detail?type=${type}&oid=${oid}&root=${rpid}`, {
    cookie,
    referer: `https://t.bilibili.com/${oid}`,
  });
  const r = data.data?.root;
  if (!r) return null;
  const c = r.content || {};
  return {
    rpid: String(r.rpid),
    author: r.member?.uname || '',
    avatar: normUrl(r.member?.avatar || ''),
    mid: r.mid,
    ctime: r.ctime || 0,
    message: c.message || '',
    emote: c.emote || {},
    pictures: (c.pictures || []).map(p => normUrl(p.img_src)),
    like: r.like ?? 0,
    rcount: r.rcount ?? 0,
  };
}

/** 获取评论目标动态的 UP 信息（评论接口 upper 字段，匿名可用） */
async function getDynamicUpper(oid, type, cookie) {
  const data = await apiGet(`/x/v2/reply?type=${type}&oid=${oid}&sort=2&ps=1`, {
    cookie,
    referer: `https://t.bilibili.com/${oid}`,
  });
  const u = data.data?.upper;
  return u ? { mid: u.mid, name: u.name } : null;
}

/** 分页拉取全部子回复（B站每页最多返回 20 条；匿名只给第一页，需 Cookie 翻页） */
async function getAllSubReplies(oid, type, rootRpid, cookie, maxPages = 5) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    // ps=20：B站 v2 reply 接口实际每页上限 20（传更大值会被服务端截断）
    const data = await apiGet(`/x/v2/reply/reply?type=${type}&oid=${oid}&root=${rootRpid}&pn=${page}&ps=20`, {
      cookie,
      referer: `https://t.bilibili.com/${oid}`,
    });
    const replies = data.data?.replies;
    if (!replies?.length) break;
    all.push(...replies);
    if (replies.length < 20) break;
  }
  return all;
}

/**
 * 分页拉取评论区一级评论（sort=2 热门排序，UP 高赞评论靠前；匿名可用）
 * @returns {Promise<Array<{rpid,author,avatar,mid,ctime,message,emote,pictures,like,rcount}>>}
 */
async function getAllTopComments(oid, type, cookie, maxPages = 10) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await apiGet(`/x/v2/reply?type=${type}&oid=${oid}&sort=2&pn=${page}&ps=20`, {
      cookie,
      referer: `https://t.bilibili.com/${oid}`,
    });
    const replies = data.data?.replies;
    if (!replies?.length) break;
    all.push(...replies.map(r => {
      const c = r.content || {};
      return {
        rpid: String(r.rpid),
        author: r.member?.uname || '',
        avatar: normUrl(r.member?.avatar || ''),
        mid: r.mid,
        ctime: r.ctime || 0,
        message: c.message || '',
        emote: c.emote || {},
        pictures: (c.pictures || []).map(p => normUrl(p.img_src)),
        like: r.like ?? 0,
        rcount: r.rcount ?? 0,
      };
    }));
    if (replies.length < 20) break;
  }
  return all;
}

/** 筛选一级评论中指定 UP（mid 统一 String 比较）发的评论 */
function filterUpComments(replies, upMid) {
  return replies.filter(r => String(r.mid ?? '') === String(upMid ?? ''));
}

/**
 * 区域一：构建 UP 回复上下文（全量不截断）
 * UP 自己的回复形成对话对（被回复粉丝评论 + UP 回复），仅被 UP 点赞未回复的子评论为 like 项；
 * 按时间升序排列（排序键 = parent.ctime ?? upReply.ctime），同时间按 rpid 稳定。
 * @returns {Promise<Array<{kind:'reply'|'like', parent:object|null, upReply:object|null}>>}
 */
function buildUpContextItems(replies, upMid) {
  const items = filterUpInteractions(replies, upMid);
  items.sort((a, b) => {
    const ta = a.parent?.ctime ?? a.upReply?.ctime ?? 0;
    const tb = b.parent?.ctime ?? b.upReply?.ctime ?? 0;
    if (ta !== tb) return ta - tb;
    const ra = String(a.upReply?.rpid ?? a.parent?.rpid ?? '');
    const rb = String(b.upReply?.rpid ?? b.parent?.rpid ?? '');
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
  return items;
}

/**
 * 原始回复结构 → 渲染用映射结构（mid 统一保留；isUp 按 upMid 判断）
 * 注意：必须保留 mid 字段，供后续 mid 过滤/比对使用
 */
function pickReply(r, upMid) {
  return {
    rpid: String(r.rpid),
    mid: r.mid,
    author: r.member?.uname || '',
    avatar: normUrl(r.member?.avatar || ''),
    isUp: String(r.mid ?? '') === String(upMid ?? ''),
    message: r.content?.message || '',
    emote: r.content?.emote || {},
    pictures: (r.content?.pictures || []).map(p => normUrl(p.img_src)),
    ctime: r.ctime || 0,
    like: r.like ?? 0,
  };
}

/** 区域二：仅粉丝（非 UP）回复按点赞降序取前 n（同分按 rpid 稳定） */
function pickTopFanReplies(replies, upMid, n) {
  const fans = replies.map(r => pickReply(r, upMid)).filter(r => String(r.mid ?? '') !== String(upMid ?? ''));
  fans.sort((a, b) => {
    if ((b.like ?? 0) !== (a.like ?? 0)) return (b.like ?? 0) - (a.like ?? 0);
    return String(a.rpid) < String(b.rpid) ? -1 : String(a.rpid) > String(b.rpid) ? 1 : 0;
  });
  return fans.slice(0, n);
}

/**
 * 筛选 UP 互动：UP 回复的评论（含对话链）+ UP 点赞的评论
 * @returns {Array<{kind:'reply'|'like', parent:object|null, upReply:object|null}>}
 */
function filterUpInteractions(replies, uid) {
  const byRpid = new Map(replies.map(r => [String(r.rpid), r]));
  // 注意：B站 API 返回的 mid 是 number，而调用方（cli.js）传入的 uid 是字符串，
  // 必须统一 String 后再比较，否则 UP 互动永远识别不到（P0 修复）
  const isUp = r => String(r.mid ?? '') === String(uid ?? '');
  const upReplies = replies.filter(isUp);
  const upLiked = replies.filter(r => r.up_action && r.up_action.like);
  const items = [];
  for (const ur of upReplies) {
    const parentRpid = String(ur.parent || '');
    const parent = parentRpid && byRpid.get(parentRpid) ? byRpid.get(parentRpid) : null;
    items.push({ kind: 'reply', parent: parent ? pickReply(parent, uid) : null, upReply: pickReply(ur, uid) });
  }
  for (const lk of upLiked) {
    if (isUp(lk)) continue; // UP 自己的回复不重复算点赞
    items.push({ kind: 'like', parent: pickReply(lk, uid), upReply: null });
  }
  return items;
}

module.exports = {
  getPinnedComment,
  getReplies,
  getCommentDetail,
  getDynamicUpper,
  getAllSubReplies,
  getAllTopComments,
  filterUpComments,
  buildUpContextItems,
  pickReply,
  pickTopFanReplies,
  filterUpInteractions,
};
