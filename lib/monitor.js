'use strict';
/** 核心检查（checkOnce）：置顶监测五大分支 + UP 互动回顾降级。cfg 由调用方传入，日志/状态经 ui/state 共享 */
const {
  BiliError, getPinnedDynamic, getPinnedComment, getReplies, getCommentDetail,
  getDynamicUpper, getAllSubReplies, filterUpInteractions,
  getAllDynamics, getAllTopComments, filterUpComments, buildUpContextItems, pickTopFanReplies,
} = require('./api');
const { generateCard, generateUnpinnedCard, generateDynamicCard, generateUpTopCard, MAX_ITEMS_SAFE } = require('./card');
const { C, log, selectYN } = require('./ui');
const { DEFAULT_UID, loadState, saveState } = require('./state');

const MAX_CHAIN_ITEMS = 30; // 互动回顾图最多渲染条数（防超长 SVG）

/** 取消置顶/换新时：拉取旧评论互动并出回顾图（失败降级为日志，不影响主流程） */
async function generateUnpinnedIfPossible(st, cfg, reason) {
  const oldRpid = st?.lastRpid;
  const oldOid = st?.oid || cfg.oid;
  const oldType = st?.type || cfg.type;
  if (!oldRpid || !oldOid) return null;
  try {
    const detail = await getCommentDetail(oldOid, oldType, oldRpid, cfg.cookie);
    if (!detail) {
      if (!cfg.quiet) log(C.dim(`旧评论 ${oldRpid} 已不可查（可能已删除），跳过互动图`));
      return null;
    }
    if (!cfg.quiet) log(C.dim(`拉取旧评论 ${oldRpid} 的子回复...`));
    const replies = await getAllSubReplies(oldOid, oldType, oldRpid, cfg.cookie, 5);
    let items = filterUpInteractions(replies, cfg.uid);
    if (items.length > MAX_CHAIN_ITEMS) {
      items = items.slice(0, MAX_CHAIN_ITEMS); // 互动过多时截断，避免 SVG 超高/渲染缓慢
      if (!cfg.quiet) log(C.dim(`互动过多，仅展示前 ${MAX_CHAIN_ITEMS} 条`));
    }
    const replyN = items.filter(i => i.kind === 'reply').length;
    const likeN = items.filter(i => i.kind === 'like').length;
    if (!cfg.quiet) log(C.dim(`UP 回复 ${replyN} 条, UP 点赞 ${likeN} 条, 共 ${items.length} 条互动`));
    const { file } = await generateUnpinnedCard({
      comment: detail,
      items,
      opts: { upName: cfg.upName, oid: oldOid, upMid: cfg.uid },
      outDir: cfg.outDir,
    });
    if (!cfg.quiet) log(`${C.green('✅ 互动回顾图')} (${reason}): ${file}`);
    return file;
  } catch (err) {
    if (!cfg.quiet) log(C.red(`✗ 互动图生成失败（${reason}）: ${err.message}`));
    return null;
  }
}

async function checkOnce(cfg) {
  let { uid, oid, rpid, type, cookie, upName, showReplies, outDir, force, trackDyn, context } = cfg;
  let dyn = null;

  // 0. UP 热评 TOP 卡（--up-top）：模式 A（--oid 单动态）/ 模式 B（--uid 全账号自动检索）
  if (cfg.upTop) {
    const topN = Math.max(1, Math.floor(cfg.upTop));
    let dyns = [];
    if (oid) {
      // 模式 A：单条动态
      dyns = [{ oid, type: type || 11, author: upName || '' }];
    } else if (uid) {
      // 模式 B：先分页检索全部动态，询问确认（防误触）
      if (!cookie) {
        if (!cfg.quiet) log(C.red('✗ 全账号检索需提供 --cookie（匿名会被风控 -352）'));
        return { event: 'error', oid: null };
      }
      if (!cfg.quiet) log(C.dim(`正在检索账号 ${uid} 的全部动态...`));
      const { dyns: all, total } = await getAllDynamics(uid, cookie, cfg.maxDyns);
      if (!total) {
        if (!cfg.quiet) log(C.dim('该账号暂无动态'));
        return { event: 'none', oid: null };
      }
      let ok = cfg.yes;
      if (!ok && process.stdin.isTTY) {
        ok = await selectYN(`该账号共有 ${total} 条动态，确认逐条处理？`, false);
      }
      if (!ok) {
        if (!cfg.quiet) log(C.yellow(`已取消（共 ${total} 条动态未处理；非交互自动处理请加 --yes）`));
        return { event: 'cancel', oid: null };
      }
      if (!cfg.quiet) log(C.dim(`确认，逐条处理 ${total} 条动态...`));
      dyns = all;
    } else {
      if (!cfg.quiet) log(C.red('✗ --up-top 模式需指定 --oid（单动态）或 --uid（全账号）'));
      return { event: 'error', oid: null };
    }

    let cards = 0;
    for (const d of dyns) {
      try {
        // 显式 --uid 优先，否则自动识别该动态 UP（评论接口 upper 字段）
        const upMid = uid || ((await getDynamicUpper(d.oid, d.type, cookie).catch(() => null))?.mid) || null;
        if (!upMid) {
          if (!cfg.quiet) log(C.dim(`动态 ${d.oid}：无法识别 UP，跳过`));
          continue;
        }
        if (!cfg.quiet) log(C.dim(`动态 ${d.oid}（${d.author || upMid}）：拉取一级评论...`));
        const tops = await getAllTopComments(d.oid, d.type, cookie);
        const upComments = filterUpComments(tops, upMid);
        if (!upComments.length) {
          if (!cfg.quiet) log(C.dim(`动态 ${d.oid}：无 UP 一级评论，跳过`));
          continue;
        }
        if (!cfg.quiet) log(C.dim(`动态 ${d.oid}：UP 一级评论 ${upComments.length} 条，逐条出卡...`));
        for (const comment of upComments) {
          try {
            // 子回复：有 Cookie 翻页拉全量；匿名仅第一页 20 条
            const maxPages = cookie ? 5 : 1;
            const replies = await getAllSubReplies(d.oid, d.type, comment.rpid, cookie, maxPages);
            if (!cookie && !cfg.quiet) log(C.dim(`（匿名仅取 ${replies.length} 条子回复，建议 --cookie 获取完整互动）`));
            // 区域一：UP 回复上下文（全量，按时间；超安全上限截断）
            let items = buildUpContextItems(replies, upMid);
            if (items.length > MAX_ITEMS_SAFE) {
              items = items.slice(0, MAX_ITEMS_SAFE);
              if (!cfg.quiet) log(C.dim(`UP 互动过多，仅展示前 ${MAX_ITEMS_SAFE} 条`));
            }
            // 区域二：粉丝高赞 TOP N
            const fans = pickTopFanReplies(replies, upMid, topN);
            const { file } = await generateUpTopCard({
              comment,
              items,
              fans,
              opts: { upName: comment.author, oid: d.oid, upMid, topN },
              outDir,
            });
            cards++;
            if (!cfg.quiet) log(`${C.green('✅ UP热评卡:')} ${file}`);
          } catch (err) {
            if (!cfg.quiet) log(C.red(`✗ 评论 ${comment.rpid} 出卡失败: ${err.message}`));
          }
        }
      } catch (err) {
        if (!cfg.quiet) log(C.red(`✗ 动态 ${d.oid} 处理失败: ${err.message}`));
      }
      if (dyns.length > 1) await new Promise(r => setTimeout(r, 1000)); // 模式 B 动态间延时防风控
    }
    if (!cfg.quiet) log(`${C.green('✔ 完成:')} 共生成 ${cards} 张 UP 热评卡`);
    return { event: 'up-top', oid, file: null, cards };
  }

  // 0. 指定评论 ID（--rpid）：直接绘制该评论卡片（旧的置顶评论等）
  if (rpid) {
    if (!oid) {
      if (!cfg.quiet) log(C.red('✗ --rpid 模式需要同时指定 --oid'));
      return { event: 'error', oid: null };
    }
    const comment = await getCommentDetail(oid, type || 11, rpid, cookie);
    if (!comment) throw new BiliError(`评论 ${rpid} 不存在或不可访问`);
    // --context：绘制 UP 互动回顾图（UP 回复/点赞对话链），参考 2568x unpinned-context
    if (context) {
      // 未显式指定 --uid 时，自动识别该动态的 UP（评论接口 upper 字段）
      let upMid = uid;
      let upLabel = upName || '';
      let identified = !!cfg.uidExplicit; // 显式指定即视为已确定
      if (!cfg.uidExplicit) {
        const upper = await getDynamicUpper(oid, type || 11, cookie).catch(() => null);
        if (upper) { upMid = upper.mid; upLabel = upLabel || upper.name; identified = true; }
      }
      // 自动识别失败且无显式/保存的 uid：明确提示中止，不静默兜底到 DEFAULT_UID（会筛选错人）
      if (!identified && String(upMid) === String(DEFAULT_UID)) {
        if (!cfg.quiet) log(C.red('✗ 无法自动识别该动态的 UP，请用 --uid <UP主UID> 显式指定后再试'));
        return { event: 'error', oid };
      }
      if (!cfg.quiet) log(C.dim(`拉取评论 ${rpid} 的全部子回复（UP: ${upLabel || upMid}）...`));
      const replies = await getAllSubReplies(oid, type || 11, rpid, cookie, 5);
      let items = filterUpInteractions(replies, upMid);
      if (items.length > MAX_CHAIN_ITEMS) {
        items = items.slice(0, MAX_CHAIN_ITEMS); // 互动过多时截断，避免 SVG 超高/渲染缓慢
        if (!cfg.quiet) log(C.dim(`互动过多，仅展示前 ${MAX_CHAIN_ITEMS} 条`));
      }
      const replyN = items.filter(i => i.kind === 'reply').length;
      const likeN = items.filter(i => i.kind === 'like').length;
      if (!cfg.quiet) log(C.dim(`子回复 ${replies.length} 条, UP 回复 ${replyN} 条, UP 点赞 ${likeN} 条`));
      const { file } = await generateUnpinnedCard({
        comment,
        items,
        opts: { upName: upLabel || comment.author, oid, upMid },
        outDir,
      });
      if (!cfg.quiet) log(`${C.green('✅ UP互动回顾图已生成:')} ${file}`);
      return { event: 'context', oid, type: type || 11, comment, file, items: items.length };
    }
    let replies = [];
    if (showReplies) replies = await getReplies(oid, type || 11, comment.rpid, 5, cookie);
    const name = upName || comment.author;
    const { file } = await generateCard({
      comment,
      replies,
      opts: { upName: name, upMid: uid, showReplies, oid },
      outDir,
    });
    if (!cfg.quiet) log(`${C.green('✅ 评论卡片已生成:')} ${file}`);
    return { event: 'manual', oid, type: type || 11, comment, file };
  }

  // 1. 确定 oid（未指定时用 Cookie 自动识别置顶动态）
  if (!oid) {
    dyn = await getPinnedDynamic(uid, cookie);
    oid = dyn.oid;
    type = dyn.type;
    if (!cfg.quiet) log(`${C.dim('自动识别置顶动态:')} ${dyn.dynId} (type=${type})${dyn.pinned ? '' : C.yellow(' [未标记置顶，取最新动态]')}`);
  }

  // 2. 取置顶评论
  const comment = await getPinnedComment(oid, type, cookie);
  const st = loadState(outDir);

  // 3. 变化判定（无 state 时视为首次 → 必然变化）
  const dynChanged = dyn && st && st.lastDynId && st.lastDynId !== dyn.dynId;
  const rpidChanged = !st || st.lastRpid !== (comment ? comment.rpid : null);
  const changed = force || dynChanged || rpidChanged;

  // A. 置顶评论被取消（之前有，现在无）→ 出旧评论互动回顾图
  if (!comment) {
    if (st?.lastRpid) {
      if (!cfg.quiet) log(C.yellow('🔄 置顶评论已取消置顶，生成互动回顾图...'));
      const file = await generateUnpinnedIfPossible(st, cfg, '已取消置顶');
      saveState(outDir, { ...st, lastRpid: null, lastUnpinnedRpid: st.lastRpid, lastCheck: new Date().toISOString() });
      return { event: 'unpinned', file };
    }
    if (!cfg.quiet) log(C.dim('无置顶评论'));
    return { event: 'none', oid, type };
  }

  // B. 普通动态更新（置顶未变，但最新动态变了）→ 提示 + 出动态更新卡片
  const dynUpdate = trackDyn && dyn && st?.lastLatestId && st.lastLatestId !== dyn.latestId && !dynChanged;
  let dynFile = null; // 本次动态卡文件（局部变量，不挂到 st 上避免污染 state.json）
  if (dynUpdate) {
    if (!cfg.quiet) log(`${C.yellow('🆕 检测到普通动态更新')} (${dyn.latestId})，生成动态卡片...`);
    try {
      const { file } = await generateDynamicCard({
        dyn,
        opts: { upName: upName || dyn.latestAuthor || dyn.author, oid: dyn.latestId },
        outDir,
      });
      if (!cfg.quiet) log(`${C.green('✅ 动态更新卡片:')} ${file}`);
      dynFile = file;
    } catch (err) {
      if (!cfg.quiet) log(C.red(`✗ 动态卡片生成失败: ${err.message}`));
    }
  }

  if (!changed) {
    // 完整输出评论正文（不再截断 30 字；超长评论多行打印，便于核对内容）
    const msg = comment.message || '';
    const body = msg.length > 120 ? `\n${C.dim('  ')}${msg}` : `"${msg}"`;
    if (!cfg.quiet) log(`${C.dim('置顶评论未变化:')} ${C.bold(comment.author)} ${body}${C.dim(` (rpid=${comment.rpid})`)}`);
    if (dynUpdate) {
      saveState(outDir, { ...st, lastLatestId: dyn.latestId, lastCheck: new Date().toISOString() });
      return { event: 'dyn-update', file: dynFile };
    }
    return { event: 'same', oid, type, comment };
  }

  // C. 置顶评论换新（旧 rpid 存在且不同）→ 先出旧评论互动回顾图
  if (st?.lastRpid && st.lastRpid !== comment.rpid && !force) {
    if (!cfg.quiet) log(`${C.yellow('🔄 置顶评论换新')}，先生成旧评论互动回顾图...`);
    await generateUnpinnedIfPossible(st, cfg, '置顶评论换新');
  }

  // D. 出当前置顶评论卡片
  if (!cfg.quiet) log(`${C.yellow('🔄 检测到置顶评论变化，正在生成卡片...')}`);
  let replies = [];
  if (showReplies) {
    replies = await getReplies(oid, type, comment.rpid, 5, cookie);
  }
  const name = upName || dyn?.author || comment.author;
  const { file } = await generateCard({
    comment,
    replies,
    opts: { upName: name, upMid: uid, showReplies, oid },
    outDir,
  });
  saveState(outDir, {
    lastRpid: comment.rpid,
    lastDynId: dyn ? dyn.dynId : (st?.lastDynId || null),
    lastLatestId: dyn ? dyn.latestId : (st?.lastLatestId || null),
    oid,
    type,
    lastCard: file,
    lastCheck: new Date().toISOString(),
  });
  if (!cfg.quiet) log(`${C.green('✅ 卡片已生成:')} ${file}`);
  return { event: 'new', oid, type, comment, file };
}

module.exports = {
  MAX_CHAIN_ITEMS,
  generateUnpinnedIfPossible,
  checkOnce,
};
