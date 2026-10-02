'use strict';
/**
 * 核心检查（checkOnce）：按模式分派到三个独立流程。
 * - runUpTopMode：--up-top UP 热评 TOP 卡（模式 A --oid 单动态 / 模式 B --uid 全账号检索）
 * - runRpidMode：--rpid 指定评论出图（含 --context UP 互动回顾）
 * - runMonitorOnce：置顶监测（无置顶归属 / 动态更新 / 换新出卡）
 * cfg 由调用方传入，日志/状态经 ui/state 共享。
 */
const fs = require('fs');
const path = require('path');
const {
  BiliError, getPinnedDynamic, getPinnedComment, getReplies, getCommentDetail,
  getDynamicUpper, getAllSubReplies, filterUpInteractions,
  getAllDynamics, getAllTopComments, filterUpComments, buildUpContextItems, pickTopFanReplies,
  MAX_SUB_PAGES,
} = require('./api');
const { generateCard, generateUnpinnedCard, generateDynamicCard, generateUpTopCard, MAX_ITEMS_SAFE } = require('./card');
const { C, log, selectYN } = require('./ui');
const jsonout = require('./jsonout'); // 机器可读输出（--json 未启用时全部为 no-op）
const { loadState, saveState } = require('./state');
const { matchRules } = require('./rule');

const MAX_CHAIN_ITEMS = 30; // 互动回顾图最多渲染条数（防超长 SVG）

/** 静默模式（--quiet）下跳过日志 */
function vlog(cfg, msg) {
  if (!cfg.quiet) log(msg);
}

/** 机器可读的卡片产出事件（--json；未启用时零开销） */
function emitCard(kind, file, extra) {
  jsonout.emit({ type: 'card', kind, file, ...extra });
}

/** 查找已生成的 UP 热评卡（文件名 up-top_<评论时间>_<rpid>.png），用于断点续传跳过重复出图 */
function findExistingUpTopCard(outDir, rpid) {
  try {
    const suffix = `_${rpid}.png`;
    const name = fs.readdirSync(outDir).find(f => f.startsWith('up-top_') && f.endsWith(suffix));
    return name ? path.join(outDir, name) : null;
  } catch { return null; }
}

/**
 * 解析「UP 身份」mid（纯函数，便于单测）
 * 优先级：显式 --uid > 接口识别的 mid（评论响应 upper.mid / 空间动态作者 mid）> 已保存 UID。
 * buildConfig 在未显式指定 uid 时会兜底 DEFAULT_UID（供匿名自动识别置顶动态用），
 * 它是「默认账号」而非用户指定的身份：一旦被当身份用，就会压掉接口识别出的真实 UP mid。
 * @param {{uid?: string, uidExplicit?: boolean, uidDefaulted?: boolean}} cfg
 * @param {...(number|string|null|undefined)} candidates 接口识别的候选 mid（按可信度排序）
 * @returns {number|string|null} 未识别到返回 null（调用方按「无身份」处理，不猜人）
 */
function resolveUpMid(cfg, ...candidates) {
  if (cfg.uidExplicit && cfg.uid) return cfg.uid;
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') return c;
  }
  if (!cfg.uidDefaulted && cfg.uid) return cfg.uid;
  return null;
}

/**
 * 公共互动拉取链路：子回复 → UP 互动过滤 → 条数截断（旧评论回顾图 / --context 共用）
 * @returns {Promise<{replies:any[], items:any[], replyN:number, likeN:number}>}
 */
async function fetchInteractionItems(cfg, oid, type, rpid, cookie, upMid, startMsg) {
  vlog(cfg, startMsg);
  const replies = await getAllSubReplies(oid, type, rpid, cookie, MAX_SUB_PAGES);
  let items = filterUpInteractions(replies, upMid);
  if (items.length > MAX_CHAIN_ITEMS) {
    items = items.slice(0, MAX_CHAIN_ITEMS); // 互动过多时截断，避免 SVG 超高/渲染缓慢
    vlog(cfg, C.dim(`互动过多，仅展示前 ${MAX_CHAIN_ITEMS} 条`));
  }
  const replyN = items.filter(i => i.kind === 'reply').length;
  const likeN = items.filter(i => i.kind === 'like').length;
  return { replies, items, replyN, likeN };
}

/**
 * 取消置顶/换新时：拉取旧评论互动并出回顾图（失败降级为日志，不影响主流程）
 * @param {any} st 上次运行状态（lastRpid/oid/type）
 * @param {any} cfg 运行配置
 * @param {string} reason 触发原因（日志用）
 * @param {number|string|null} [upMid] UP 身份（调用方按 resolveUpMid 解析）；缺省时用该动态评论区 upper.mid 兜底
 */
async function generateUnpinnedIfPossible(st, cfg, reason, upMid = null) {
  const oldRpid = st?.lastRpid;
  const oldOid = st?.oid || cfg.oid;
  const oldType = st?.type || cfg.type;
  if (!oldRpid || !oldOid) return null;
  try {
    const detail = await getCommentDetail(oldOid, oldType, oldRpid, cfg.cookie);
    if (!detail) {
      vlog(cfg, C.dim(`旧评论 ${oldRpid} 已不可查（可能已删除），跳过互动图`));
      return null;
    }
    // 身份兜底：调用方未给出可用 mid 时，用该动态评论区响应的 upper.mid 识别（避免用错人筛选出空图）
    const mid = upMid || (await getDynamicUpper(oldOid, oldType, cfg.cookie).catch(() => null))?.mid || null;
    const { items, replyN, likeN } = await fetchInteractionItems(
      cfg, oldOid, oldType, oldRpid, cfg.cookie, mid, C.dim(`拉取旧评论 ${oldRpid} 的子回复...`),
    );
    vlog(cfg, C.dim(`UP 回复 ${replyN} 条, UP 点赞 ${likeN} 条, 共 ${items.length} 条互动`));
    const { file } = await generateUnpinnedCard({
      comment: detail,
      items,
      opts: { upName: cfg.upName, oid: oldOid, upMid: mid, scale: cfg.scale },
      outDir: cfg.outDir,
    });
    vlog(cfg, `${C.green('✅ 互动回顾图')} (${reason}): ${file}`);
    emitCard('unpinned', file, { rpid: String(oldRpid), oid: String(oldOid), reason });
    return file;
  } catch (err) {
    vlog(cfg, C.red(`✗ 互动图生成失败（${reason}）: ${err.message}`));
    return null;
  }
}

/** 入口：按模式分派（互斥，命中即返回） */
async function checkOnce(cfg) {
  if (cfg.upTop) return runUpTopMode(cfg);
  if (cfg.rpid) return runRpidMode(cfg);
  return runMonitorOnce(cfg);
}

/** --up-top：UP 热评 TOP 卡（模式 A --oid 单动态 / 模式 B --uid 全账号自动检索） */
async function runUpTopMode(cfg) {
  const { uid, oid, type, cookie, upName, outDir, force } = cfg;
  const topN = Math.max(1, Math.floor(cfg.upTop));
  let dyns = [];
  if (oid) {
    // 模式 A：单条动态
    dyns = [{ oid, type: type || 11, author: upName || '' }];
  } else if (uid) {
    // 模式 B：先分页检索全部动态，询问确认（防误触）
    if (!cookie) {
      vlog(cfg, C.red('✗ 全账号检索需提供 --cookie（匿名会被风控 -352）'));
      return { event: 'error', oid: null };
    }
    vlog(cfg, C.dim(`正在检索账号 ${uid} 的全部动态...`));
    const { dyns: all, total } = await getAllDynamics(uid, cookie, cfg.maxDyns);
    if (!total) {
      vlog(cfg, C.dim('该账号暂无动态'));
      return { event: 'none', oid: null };
    }
    let ok = cfg.yes;
    if (!ok && cfg.dryRun) ok = true; // 演练不落任何产物，无需确认
    else if (!ok && process.stdin.isTTY && !jsonout.enabled()) {
      ok = await selectYN(`该账号共有 ${total} 条动态，确认逐条处理？`, false);
    }
    if (!ok) {
      // 机器可读/非交互模式绝不弹窗等待：明确取消并告诉调用方怎么继续
      vlog(cfg, C.yellow(`已取消（共 ${total} 条动态未处理；非交互自动处理请加 --确认）`));
      return { event: 'cancel', oid: null, total, hint: '加 --确认（--yes）后重跑即可自动逐条处理' };
    }
    vlog(cfg, C.dim(`确认，逐条处理 ${total} 条动态...`));
    dyns = all;
  } else {
    vlog(cfg, C.red('✗ --up-top 模式需指定 --oid（单动态）或 --uid（全账号）'));
    return { event: 'error', oid: null };
  }

  let cards = 0, skipped = 0;
  const plan = []; // 演练（--dry-run）时的计划清单
  for (let di = 0; di < dyns.length; di++) {
    const d = dyns[di];
    const dPrefix = dyns.length > 1 ? C.dim(`[${di + 1}/${dyns.length}] `) : '';
    try {
      vlog(cfg, dPrefix + C.dim(`动态 ${d.oid}（${d.author || d.authorMid || ''}）：拉取一级评论...`));
      const { replies: tops, total: topTotal, degraded, fallback, upperMid } = await getAllTopComments(d.oid, d.type, cookie);
      if (fallback && !cfg.quiet) {
        log(dPrefix + C.dim(`（wbi 签名接口被限流或不可用，已自动回退老接口拉取评论）`));
      }
      if (degraded && !cfg.quiet) {
        log(dPrefix + C.yellow(`⚠ 评论区可能被 B站 限流（仅获取 ${tops.length}/共 ${topTotal ?? tops.length} 条），结果不完整，建议 --login 刷新 Cookie 后重试`));
      }
      // UP mid 复用链：显式 --uid > 空间动态作者 mid > 评论响应 upper.mid > 单独请求识别
      // 注意不能直接用 uid：未显式 --uid 时它是 DEFAULT_UID 兜底值（会筛不到 UP 一级评论 → 静默 0 张卡）
      let upMid = resolveUpMid(cfg, d.authorMid, upperMid);
      if (!upMid) {
        upMid = (await getDynamicUpper(d.oid, d.type, cookie).catch(() => null))?.mid ?? null;
      }
      if (!upMid) {
        vlog(cfg, dPrefix + C.dim(`动态 ${d.oid}：无法识别 UP，跳过`));
        continue;
      }
      const upComments = filterUpComments(tops, upMid);
      if (!upComments.length) {
        vlog(cfg, dPrefix + C.dim(`动态 ${d.oid}：无 UP 一级评论，跳过`));
        continue;
      }
      if (cfg.dryRun) {
        // 演练：只统计将出哪些卡，不拉子回复、不渲染、不写 state
        plan.push({
          oid: String(d.oid), type: d.type, author: d.author || '',
          upMid: upMid == null ? null : String(upMid),
          comments: upComments.map(c => ({ rpid: c.rpid, author: c.author, ctime: c.ctime, like: c.like ?? 0 })),
        });
        continue;
      }
      vlog(cfg, dPrefix + C.dim(`动态 ${d.oid}：UP 一级评论 ${upComments.length} 条，逐条出卡...`));
      for (let ci = 0; ci < upComments.length; ci++) {
        const comment = upComments[ci];
        const cPrefix = upComments.length > 1 ? C.dim(`[${ci + 1}/${upComments.length}] `) : '';
        try {
          // 断点续传：已生成过同一评论的卡则跳过（长跑/全账号模式中断后重跑不重复出图）
          const existing = force ? null : findExistingUpTopCard(outDir, comment.rpid);
          if (existing) {
            skipped++;
            vlog(cfg, dPrefix + cPrefix + C.dim(`已存在，跳过 ${path.basename(existing)}（--force 可重出）`));
            continue;
          }
          // 子回复：有 Cookie 翻页拉全量（10 页 ≈ 200 条，覆盖高互动楼层）；匿名仅第一页 20 条
          const maxPages = cookie ? MAX_SUB_PAGES : 1;
          const replies = await getAllSubReplies(d.oid, d.type, comment.rpid, cookie, maxPages);
          if (!cookie && !cfg.quiet) log(dPrefix + cPrefix + C.dim(`（匿名仅取 ${replies.length} 条子回复，建议 --cookie 获取完整互动）`));
          // 区域一：UP 回复上下文（全量，按时间；超安全上限截断）
          let items = buildUpContextItems(replies, upMid);
          if (items.length > MAX_ITEMS_SAFE) {
            items = items.slice(0, MAX_ITEMS_SAFE);
            vlog(cfg, dPrefix + cPrefix + C.dim(`UP 互动过多，仅展示前 ${MAX_ITEMS_SAFE} 条`));
          }
          // 区域二：粉丝高赞 TOP N
          const fans = pickTopFanReplies(replies, upMid, topN);
          const { file } = await generateUpTopCard({
            comment,
            items,
            fans,
            opts: { upName: comment.author, oid: d.oid, upMid, topN, scale: cfg.scale },
            outDir,
          });
          cards++;
          emitCard('up-top', file, { rpid: comment.rpid, oid: String(d.oid), index: cards, total: upComments.length });
          vlog(cfg, `${dPrefix}${cPrefix}${C.green('✅ UP热评卡:')} ${file}`);
        } catch (err) {
          vlog(cfg, dPrefix + cPrefix + C.red(`✗ 评论 ${comment.rpid} 出卡失败: ${err.message}`));
        }
      }
    } catch (err) {
      vlog(cfg, C.red(`✗ 动态 ${d.oid} 处理失败: ${err.message}`));
    }
    if (dyns.length > 1) await new Promise(r => setTimeout(r, 1000)); // 模式 B 动态间延时防风控
  }
  if (cfg.dryRun) {
    const total = plan.reduce((s, p) => s + p.comments.length, 0);
    vlog(cfg, C.dim(`演练：${plan.length} 条动态、共 ${total} 条 UP 一级评论将出卡（未渲染、未写 state）`));
    return { event: 'dry-run', oid: oid || null, plan: { mode: oid ? 'single' : 'account', dynamics: plan, cards: total } };
  }
  if (!cfg.quiet) {
    const skipTxt = skipped ? C.dim(`（跳过已存在 ${skipped} 张，--force 可重出）`) : '';
    log(`${C.green('✔ 完成:')} 共生成 ${cards} 张 UP 热评卡${skipTxt}`);
  }
  return { event: 'up-top', oid, file: null, cards, skipped };
}

/** --rpid：指定评论 ID 直接出图（--context 走 UP 互动回顾图；否则出置顶评论卡） */
async function runRpidMode(cfg) {
  const { oid, rpid, type, cookie, upName, showReplies, outDir } = cfg;
  if (!oid) {
    // 说清楚怎么补救：评论属于哪条动态必须有来源（评论分享链接里自带）
    vlog(cfg, C.red('✗ 出图需要知道这条评论属于哪条动态：'));
    vlog(cfg, C.dim('  ① 直接粘完整评论分享链接：node cli.js 出图 "<评论链接>"'));
    vlog(cfg, C.dim('  ② 或同时给出动态：node cli.js --动态 <动态链接> --评论 <评论ID>'));
    return { event: 'error', oid: null };
  }
  let comment;
  try {
    comment = await getCommentDetail(oid, type || 11, rpid, cookie);
  } catch (err) {
    // 12089「评论不属于该评论区」：oid 与该评论所属评论区不匹配（最常见是把评论 oid 当动态 ID 且 type 用了 17）
    if (err?.code === 12089) {
      throw new BiliError(`评论 ${rpid} 不属于该评论区（oid=${oid}, type=${type || 11}）：oid 与 type 可能不配对（图文/动态评论区通常为 type=11），建议重新粘贴动态/评论分享链接`, 12089);
    }
    throw err;
  }
  if (!comment) throw new BiliError(`评论 ${rpid} 不存在或不可访问`);
  if (cfg.dryRun) {
    vlog(cfg, C.dim(`演练：将${cfg.context ? '生成 UP 互动回顾图' : '出评论卡片'} rpid=${comment.rpid}（未渲染、未写 state）`));
    return {
      event: 'dry-run', oid, type: type || 11, comment,
      plan: { kind: cfg.context ? 'context' : 'card', rpid: comment.rpid, author: comment.author, hasPictures: (comment.pictures || []).length },
    };
  }
  // UP 身份：显式 --uid > 接口识别（评论接口 upper，按 oid 进程内缓存）> 已保存 UID。
  // 不能把 DEFAULT_UID 兜底值当身份：--context 会按错误的人筛选互动（出「暂无 UP 互动」空图），
  // 普通卡则会给错「UP主」徽标。普通卡识别失败时降级为不显示徽标（不猜人）。
  let identityMid = null;
  let upLabel = upName || '';
  if (cfg.uidExplicit && cfg.uid) {
    identityMid = cfg.uid;
  } else {
    const upper = await getDynamicUpper(oid, type || 11, cookie).catch(() => null);
    if (upper) { identityMid = upper.mid; upLabel = upLabel || upper.name; }
    else if (!cfg.uidDefaulted) identityMid = cfg.uid || null; // 已保存过的 UID 可兜底
  }

  // --context：绘制 UP 互动回顾图（UP 回复/点赞对话链），参考 2568x unpinned-context
  if (cfg.context) {
    // 自动识别失败且无可用身份：明确提示中止，不静默按错误的人筛选
    if (identityMid == null || identityMid === '') {
      vlog(cfg, C.red('✗ 无法自动识别该动态的 UP，请用 --uid <UP主UID> 显式指定后再试'));
      return { event: 'error', oid };
    }
    const upMid = identityMid;
    const { replies, items, replyN, likeN } = await fetchInteractionItems(
      cfg, oid, type || 11, rpid, cookie, upMid, C.dim(`拉取评论 ${rpid} 的全部子回复（UP: ${upLabel || upMid}）...`),
    );
    vlog(cfg, C.dim(`子回复 ${replies.length} 条, UP 回复 ${replyN} 条, UP 点赞 ${likeN} 条`));
    const { file } = await generateUnpinnedCard({
      comment,
      items,
      opts: { upName: upLabel || comment.author, oid, upMid, scale: cfg.scale },
      outDir,
    });
    vlog(cfg, `${C.green('✅ UP互动回顾图已生成:')} ${file}`);
    emitCard('unpinned', file, { rpid: comment.rpid, oid: String(oid), items: items.length });
    return { event: 'context', oid, type: type || 11, comment, file, items: items.length };
  }
  let replies = [];
  if (showReplies) replies = await getReplies(oid, type || 11, comment.rpid, 5, cookie);
  const name = upName || comment.author;
  const { file } = await generateCard({
    comment,
    replies,
    opts: { upName: name, upMid: cfg.uid, showReplies, oid, scale: cfg.scale },
    outDir,
  });
  vlog(cfg, `${C.green('✅ 评论卡片已生成:')} ${file}`);
  emitCard('pinned', file, { rpid: comment.rpid, oid: String(oid) });
  return { event: 'manual', oid, type: type || 11, comment, file };
}

/** 置顶监测：识别置顶动态 → 变化判定 → 出图（换新/取消置顶时的旧评论回顾图） */
async function runMonitorOnce(cfg) {
  let { oid, type } = cfg;
  const { uid, cookie, upName, showReplies, outDir, force, trackDyn } = cfg;
  let dyn = null;

  // 1. 确定 oid（未指定时用 Cookie 自动识别置顶动态）
  if (!oid) {
    dyn = await getPinnedDynamic(uid, cookie);
    oid = dyn.oid;
    type = dyn.type;
    vlog(cfg, `${C.dim('自动识别置顶动态:')} ${dyn.dynId} (type=${type})${dyn.pinned ? '' : C.yellow(' [未标记置顶，取最新动态]')}`);
  }

  // 2. 取置顶评论（withReason：区分「确实没有置顶」与「拉取失败/对象不存在」，见下方归因）
  /** @type {{comment: any, reason: string}} */
  // @ts-ignore tsc 无法从 opts 字面量收窄 getPinnedComment 的联合返回类型
  const { comment, reason: commentReason, upperMid: pinnedUpperMid } = await getPinnedComment(oid, type, cookie, { withReason: true });
  // 2.5 UP 身份：显式 --uid > 接口识别（评论响应 upper.mid / 空间动态作者 mid）> 已保存 UID。
  // DEFAULT_UID 兜底值不是身份（见 resolveUpMid），否则互动回顾图会按错误的人筛选。
  const identityMid = resolveUpMid(cfg, pinnedUpperMid, dyn?.authorMid);

  // 2.6 目标隔离：state.json 只按输出目录存放，可能属于「另一条动态」。
  // 用户显式换了 --oid 时，上次的 lastRpid 与当前目标无关，直接复用会把「换目标」误判成
  // 「换新 / 取消置顶」——为别的动态出互动图，并向 Webhook 推送假的「置顶评论已取消」。
  // 注意：--uid 自动识别模式下 oid 会随置顶动态变化（那是合法事件），故只对显式 --oid 隔离。
  const loaded = loadState(outDir);
  const prev = (cfg.oid && loaded?.oid && String(loaded.oid) !== String(cfg.oid)) ? null : loaded;

  // 3. 变化判定（无 state 时视为首次 → 必然变化）
  const dynChanged = dyn && prev && prev.lastDynId && prev.lastDynId !== dyn.dynId;
  // 注意：comment 为 null 时用「空值哨兵」而非 null 比较，避免每次检查都误判为变化
  const rpidChanged = !prev || prev.lastRpid !== (comment ? comment.rpid : '');
  const changed = force || dynChanged || rpidChanged;

  // A. 无置顶评论 → 按归因分流：
  //    'none'/'empty'  = 接口正常且确实没有置顶评论 → 判定为「已取消置顶」，出旧评论回顾图
  //    'notfound'      = 评论区/动态不存在（已删）→ 不出图；state 保留 lastRpid 供人工核查
  //    其他 = 拉取异常（理论上已在 apiGet 抛错，此处兜底）→ 不出图、不写 state
  if (!comment) {
    const trulyUnpinned = commentReason === 'none' || commentReason === 'empty';
    if (!trulyUnpinned) {
      vlog(cfg, C.yellow(commentReason === 'notfound'
        ? `⚠ 评论区/动态不可访问（${oid}），本次跳过变化判定（state 已保留，未污染）`
        : `⚠ 置顶评论拉取结果不可信（${commentReason}），本次跳过变化判定（state 未污染）`));
      return { event: 'fetch-error', oid, type, reason: commentReason };
    }
    if (cfg.dryRun) {
      return {
        event: 'dry-run', oid, type,
        plan: { hasPinned: false, reason: commentReason, wouldUnpin: !!(prev && prev.lastRpid), watchedOid: String(oid) },
      };
    }
    if (prev?.lastRpid) {
      vlog(cfg, C.yellow('🔄 置顶评论已取消置顶，生成互动回顾图...'));
      const file = await generateUnpinnedIfPossible(prev, cfg, '已取消置顶', identityMid);
      saveState(outDir, { ...prev, lastRpid: null, lastUnpinnedRpid: prev.lastRpid, lastCheck: new Date().toISOString() });
      return { event: 'unpinned', file };
    }
    vlog(cfg, C.dim('无置顶评论'));
    // 首次运行即无置顶：写入 oid/type 便于后续复用，lastRpid 保持空哨兵
    saveState(outDir, { ...(prev || {}), lastRpid: null, oid, type, lastCheck: new Date().toISOString() });
    return { event: 'none', oid, type };
  }

  // B. 内容规则过滤（--rule，默认关闭）：命中判定作用于置顶评论正文与普通动态正文
  const commentHit = matchRules(cfg.rules, cfg.ruleMode, comment.message || '');

  // 演练：报告计划后直接返回（不出图、不写 state、不拉子回复）
  if (cfg.dryRun) {
    const dynUpdatePlan = !!(trackDyn && dyn && prev?.lastLatestId && prev.lastLatestId !== dyn.latestId && !dynChanged);
    vlog(cfg, C.dim(`演练：${changed ? '检测到置顶变化' : '置顶未变化'}（rpid=${comment.rpid}）${commentHit.hit ? '' : '，且未命中规则'}`));
    return {
      event: 'dry-run', oid, type, comment,
      plan: {
        hasPinned: true, rpid: comment.rpid, author: comment.author,
        changed: !!changed, rpidChanged: !!rpidChanged, dynChanged: !!dynChanged,
        ruleHit: commentHit.hit, dynUpdate: dynUpdatePlan,
        wouldRender: !!(changed && commentHit.hit),
      },
    };
  }

  // C. 普通动态更新（置顶未变，但最新动态变了）→ 提示 + 出动态更新卡片
  const dynUpdate = trackDyn && dyn && prev?.lastLatestId && prev.lastLatestId !== dyn.latestId && !dynChanged;
  const dynHit = dynUpdate ? matchRules(cfg.rules, cfg.ruleMode, dyn.latestDesc || '') : { hit: true };
  let dynFile = null; // 本次动态卡文件（局部变量，不挂到 st 上避免污染 state.json）
  if (dynUpdate && dynHit.hit) {
    vlog(cfg, `${C.yellow('🆕 检测到普通动态更新')} (${dyn.latestId})，生成动态卡片...`);
    try {
      const { file } = await generateDynamicCard({
        dyn,
        opts: { upName: upName || dyn.latestAuthor || dyn.author, oid: dyn.latestId, scale: cfg.scale },
        outDir,
      });
      vlog(cfg, `${C.green('✅ 动态更新卡片:')} ${file}`);
      emitCard('dynamic', file, { oid: String(dyn.latestId) });
      dynFile = file;
    } catch (err) {
      vlog(cfg, C.red(`✗ 动态卡片生成失败: ${err.message}`));
    }
  } else if (dynUpdate) {
    vlog(cfg, C.dim(`普通动态未命中规则，跳过出图（${dyn.latestId}）`));
  }

  if (!changed) {
    // 完整输出评论正文（不再截断 30 字；超长评论多行打印，便于核对内容）
    const msg = comment.message || '';
    const body = msg.length > 120 ? `\n${C.dim('  ')}${msg}` : `"${msg}"`;
    vlog(cfg, `${C.dim('置顶评论未变化:')} ${C.bold(comment.author)} ${body}${C.dim(` (rpid=${comment.rpid})`)}`);
    if (dynUpdate && dynHit.hit) {
      saveState(outDir, { ...prev, lastLatestId: dyn.latestId, lastCheck: new Date().toISOString() });
      return { event: 'dyn-update', file: dynFile, oid, latestDesc: dyn.latestDesc };
    }
    return { event: 'same', oid, type, comment };
  }

  // D. 规则未命中：记录已读（避免每个检查周期重复评估/刷屏），但不出图、不推送
  if (!commentHit.hit) {
    vlog(cfg, C.dim(`置顶评论未命中规则，跳过出图（rpid=${comment.rpid}）`));
    saveState(outDir, {
      ...(prev || {}),
      lastRpid: comment.rpid,
      lastDynId: dyn ? dyn.dynId : (prev?.lastDynId || null),
      lastLatestId: dyn ? dyn.latestId : (prev?.lastLatestId || null),
      oid,
      type,
      lastFiltered: true,
      lastCheck: new Date().toISOString(),
    });
    return { event: 'filtered', oid, type, comment, matched: commentHit.matched };
  }
  if (cfg.rules && cfg.rules.length && !cfg.quiet) {
    log(C.dim(`命中规则: ${commentHit.matched.join(', ')}`));
  }

  // E. 置顶评论换新（旧 rpid 存在且不同）→ 先出旧评论互动回顾图
  if (prev?.lastRpid && prev.lastRpid !== comment.rpid && !force) {
    vlog(cfg, `${C.yellow('🔄 置顶评论换新')}，先生成旧评论互动回顾图...`);
    await generateUnpinnedIfPossible(prev, cfg, '置顶评论换新', identityMid);
  }

  // F. 出当前置顶评论卡片
  vlog(cfg, C.yellow('🔄 检测到置顶评论变化，正在生成卡片...'));
  let replies = [];
  if (showReplies) {
    replies = await getReplies(oid, type, comment.rpid, 5, cookie);
  }
  const name = upName || dyn?.author || comment.author;
  const { file } = await generateCard({
    comment,
    replies,
    // 身份取 resolveUpMid 的结果（--oid/游客模式用评论接口同响应的 upper.mid，保证 UP主 徽标正确）
    opts: { upName: name, upMid: identityMid, showReplies, oid, scale: cfg.scale },
    outDir,
  });
  saveState(outDir, {
    lastRpid: comment.rpid,
    lastDynId: dyn ? dyn.dynId : (prev?.lastDynId || null),
    lastLatestId: dyn ? dyn.latestId : (prev?.lastLatestId || null),
    oid,
    type,
    lastCard: file,
    lastCheck: new Date().toISOString(),
  });
  vlog(cfg, `${C.green('✅ 卡片已生成:')} ${file}`);
  emitCard('pinned', file, { rpid: comment.rpid, oid: String(oid) });
  return { event: 'new', oid, type, comment, file };
}

module.exports = {
  MAX_CHAIN_ITEMS,
  resolveUpMid,
  generateUnpinnedIfPossible,
  checkOnce,
  runUpTopMode,
  runRpidMode,
  runMonitorOnce,
};
