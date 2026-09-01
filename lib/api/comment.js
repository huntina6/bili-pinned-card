'use strict';
/** 评论相关：置顶/子回复/一级评论/UP 互动筛选（匿名可用为主） */
const { BiliError, apiGet, mergeCookie, anonCookie, httpJson } = require('./client');
const { wbiQuery } = require('./wbi');
const { normUrl } = require('./image');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** B站原始评论 → 映射结构（一级评论与子回复共用） */
function mapTopReply(r) {
  const c = r.content || {};
  return {
    rpid: String(r.rpid),
    mid: r.mid,
    author: r.member?.uname || '',
    avatar: normUrl(r.member?.avatar || ''),
    ctime: r.ctime || 0,
    message: c.message || '',
    emote: c.emote || {},
    pictures: (c.pictures || []).map(p => normUrl(p.img_src)),
    like: r.like ?? 0,
    rcount: r.rcount ?? 0,
  };
}

/** 降级判定：接口仅返回极少评论但评论区总量巨大 → 被限流降级 */
function isDegraded(repliesLen, total) {
  return repliesLen < 5 && total > 100;
}

/** pagination_str 构造：首页 {"offset":""}，翻页 {"offset":"<cursor>"} */
function buildPaginationStr(offset) {
  return `{"offset":"${offset || ''}"}`;
}

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

/**
 * 分页拉取全部子回复（B站每页最多返回 20 条；匿名只给第一页，需 Cookie 翻页）
 * 注意：必须带 web_location=333.788 才能翻页（2026 实测，缺失时只返回第一页）
 */
async function getAllSubReplies(oid, type, rootRpid, cookie, maxPages = 5) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    // ps=20：B站 v2 reply 接口实际每页上限 20（传更大值会被服务端截断）
    let data;
    try {
      data = await apiGet(`/x/v2/reply/reply?type=${type}&oid=${oid}&root=${rootRpid}&pn=${page}&ps=20&web_location=333.788`, {
        cookie,
        referer: `https://t.bilibili.com/${oid}`,
      });
    } catch (err) {
      if (page === 1) { await sleep(1000); } // 单页失败重试 1 次（间隔 1s）
      try {
        data = await apiGet(`/x/v2/reply/reply?type=${type}&oid=${oid}&root=${rootRpid}&pn=${page}&ps=20&web_location=333.788`, {
          cookie,
          referer: `https://t.bilibili.com/${oid}`,
        });
      } catch (e2) { throw err; } // 重试仍失败则抛原始错误
    }
    const replies = data.data?.replies;
    if (!replies?.length) break;
    all.push(...replies);
    if (replies.length < 20) break;
    if (page < maxPages) await sleep(300); // 页间节流防风控
  }
  return all;
}

/**
 * WBI 版一级评论全量拉取（/x/v2/reply/wbi/main，游标翻页）
 * 2026 实测：老接口对 opus 评论区仅返回热门 3 条（被降级），wbi/main + pagination_str 游标可拉全量
 * @returns {Promise<{replies: Array, total: number, degraded: boolean}>}
 */
async function getAllTopCommentsWbi(oid, type, cookie, maxPages = 10) {
  const all = [];
  let offset = '';
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const params = {
      mode: '3',
      oid: String(oid),
      type: String(type),
      pagination_str: buildPaginationStr(offset),
      plat: '1',
      web_location: '1315875',
    };
    if (page === 1) params.seek_rpid = ''; // 首页必带（空值）
    const qs = await wbiQuery(params, cookie);
    const url = `https://api.bilibili.com/x/v2/reply/wbi/main?${qs}`;
    const full = mergeCookie(await anonCookie(), cookie);
    const d = await httpJson(url, { cookie: full, referer: 'https://www.bilibili.com/' });
    if (d.code !== 0) throw new BiliError(`API code=${d.code}: ${d.message || ''}`, d.code);
    const data = d.data || {};
    const replies = data.replies;
    total = data.cursor?.all_count ?? total; // 先取总量（降级时 3 条即 break，总量必须已记录）
    if (replies?.length) all.push(...replies.map(mapTopReply));
    // wbi 是游标分页：第一页可能不足 20 条但仍有下一页，仅凭 is_end/游标判定终止
    const next = data.cursor?.pagination_reply?.next_offset;
    if (data.cursor?.is_end || !next) break;
    offset = next;
    if (page < maxPages) await sleep(500); // 页间节流防风控
  }
  return { replies: all, total, degraded: isDegraded(all.length, total) };
}

/**
 * 老接口一级评论分页（/x/v2/reply sort=2，无 wbi；opus 评论区会被降级到 3 条）
 * @returns {Promise<{replies: Array, total: number, degraded: boolean}>}
 */
async function getAllTopCommentsLegacy(oid, type, cookie, maxPages = 10) {
  const all = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const data = await apiGet(`/x/v2/reply?type=${type}&oid=${oid}&sort=2&pn=${page}&ps=20`, {
      cookie,
      referer: `https://t.bilibili.com/${oid}`,
    });
    const replies = data.data?.replies;
    if (!replies?.length) break;
    all.push(...replies.map(mapTopReply));
    total = data.data?.page?.count ?? total;
    if (replies.length < 20) break;
    if (page < maxPages) await sleep(300);
  }
  return { replies: all, total, degraded: isDegraded(all.length, total) };
}

/**
 * 拉取评论区一级评论：优先 wbi/main（全量），失败或被降级时回退老接口
 * @returns {Promise<{replies: Array, total: number, degraded: boolean}>}
 */
async function getAllTopComments(oid, type, cookie, maxPages = 10) {
  try {
    const r = await getAllTopCommentsWbi(oid, type, cookie, maxPages);
    if (!r.degraded) return r;
    // wbi 结果被降级（极少条数+巨大总量）→ 回退老接口确认（可能同样降级，保留标记）
    const legacy = await getAllTopCommentsLegacy(oid, type, cookie, maxPages);
    return { ...legacy, degraded: legacy.degraded || r.degraded };
  } catch (err) {
    // wbi 失败（风控 -352/-412、签名异常、网络）→ 回退老接口（老接口 opus 可能降级，但视频等类型正常）
    const legacy = await getAllTopCommentsLegacy(oid, type, cookie, maxPages);
    return legacy;
  }
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
  getAllTopCommentsWbi,
  getAllTopCommentsLegacy,
  isDegraded,
  buildPaginationStr,
  filterUpComments,
  buildUpContextItems,
  pickReply,
  pickTopFanReplies,
  filterUpInteractions,
};
