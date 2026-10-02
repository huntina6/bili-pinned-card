'use strict';
/**
 * monitor 三条流程的回归测试（零网络：只桩掉 lib/api 与 lib/card，state/互动筛选保持真实语义）
 * 覆盖：
 *  - UP 身份解析：DEFAULT_UID 兜底值不得当「UP 身份」用（曾导致 --up-top 单动态静默 0 张卡、
 *    UP主徽标漏、互动回顾图筛错人）
 *  - state.json 目标隔离：换 --oid 不得把「换目标」误判成换新/取消置顶（假互动图 + 假推送）
 *  - --uid 模式置顶动态被替换仍须出卡（隔离逻辑不得误伤该事件）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 真实互动筛选纯函数（只桩网络与出图）
const realComment = require('../lib/api/comment');

const calls = { cards: [], unpinned: [], uptop: [] };
const apiState = {};
function resetCalls() { calls.cards = []; calls.unpinned = []; calls.uptop = []; }
function mkTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-monitor-')); }
function writeState(outDir, state) { fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify(state)); }
function readState(outDir) { return JSON.parse(fs.readFileSync(path.join(outDir, 'state.json'), 'utf8')); }

const apiStub = {
  BiliError: class BiliError extends Error {
    constructor(message, code) { super(message); this.code = code; this.name = 'BiliError'; }
  },
  MAX_SUB_PAGES: 10,
  getPinnedDynamic: async () => apiState.dyn,
  getPinnedComment: async () => apiState.pinned,
  getReplies: async () => [],
  getCommentDetail: async () => apiState.detail || null,
  getDynamicUpper: async () => apiState.upper || null,
  getAllSubReplies: async () => apiState.subReplies || [],
  filterUpInteractions: realComment.filterUpInteractions,
  getAllDynamics: async () => apiState.dynamics || { dyns: [], total: 0 },
  getAllTopComments: async () => apiState.topComments,
  filterUpComments: realComment.filterUpComments,
  buildUpContextItems: () => [],
  pickTopFanReplies: () => [],
};
const cardStub = {
  MAX_ITEMS_SAFE: 200,
  generateCard: async (a) => { calls.cards.push(a); return { file: 'pinned-card.png' }; },
  generateUnpinnedCard: async (a) => { calls.unpinned.push(a); return { file: 'unpinned-context.png' }; },
  generateDynamicCard: async () => ({ file: 'dynamic-update.png' }),
  generateUpTopCard: async (a) => { calls.uptop.push(a); return { file: 'up-top.png' }; },
};
function stub(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] };
}
stub('../lib/api', apiStub);
stub('../lib/card', cardStub);

const { parseArgs, buildConfig } = require('../lib/args');
const { DEFAULT_UID } = require('../lib/state');
const monitor = require('../lib/monitor');

const mkCfg = (argv, over = {}) => ({
  ...buildConfig(parseArgs(argv), {}), outDir: mkTmpDir(), quiet: true, ...over,
});
const mkComment = (over = {}) => ({
  rpid: 'C1', author: '某UP', avatar: '', mid: 999, ctime: 1754985600,
  message: '正文', emote: {}, pictures: [], like: 0, rcount: 0, ...over,
});

test('resolveUpMid：显式 --uid > 接口识别 > 已保存 uid；DEFAULT_UID 兜底值不算身份', () => {
  assert.strictEqual(monitor.resolveUpMid({ uid: '1', uidExplicit: true, uidDefaulted: false }, '2', '3'), '1');
  assert.strictEqual(monitor.resolveUpMid({ uid: DEFAULT_UID, uidExplicit: false, uidDefaulted: true }, '2'), '2',
    '接口识别出的 mid 必须胜过 DEFAULT_UID 兜底值');
  assert.strictEqual(monitor.resolveUpMid({ uid: DEFAULT_UID, uidExplicit: false, uidDefaulted: true }), null,
    '无识别结果时返回 null（不猜人）');
  assert.strictEqual(monitor.resolveUpMid({ uid: '777', uidExplicit: false, uidDefaulted: false }), '777',
    '已保存的 uid 可兜底');
  assert.strictEqual(monitor.resolveUpMid({ uid: '777', uidExplicit: false, uidDefaulted: false }, '888'), '888',
    '接口识别优先于已保存 uid');
  assert.strictEqual(monitor.resolveUpMid({ uid: DEFAULT_UID, uidExplicit: false, uidDefaulted: true }, null, undefined, ''), null);
});

test('runUpTopMode：--oid 单动态未显式 --uid 时用接口识别的 UP mid（回归：曾静默 0 张卡）', async () => {
  resetCalls();
  apiState.topComments = {
    replies: [mkComment({ rpid: 'C1', mid: 999, author: '某UP', message: 'UP 一级评论' })],
    total: 1, degraded: false, upperMid: 999,
  };
  const cfg = mkCfg(['--oid', '404135596', '--up-top', '3', '--once']);
  assert.strictEqual(cfg.uidExplicit, false);
  assert.strictEqual(cfg.uid, DEFAULT_UID, '前置：cfg.uid 仍是兜底默认账号');
  const res = await monitor.runUpTopMode(cfg);
  assert.strictEqual(res.cards, 1, '应识别出 UP 一级评论并出卡');
  assert.strictEqual(calls.uptop.length, 1);
  assert.strictEqual(String(calls.uptop[0].opts.upMid), '999');
  assert.strictEqual(calls.uptop[0].comment.rpid, 'C1');
});

test('runUpTopMode：显式 --uid 优先于接口识别的 mid', async () => {
  resetCalls();
  apiState.topComments = {
    replies: [
      mkComment({ rpid: 'C1', mid: 401315430, author: '显式UP' }),
      mkComment({ rpid: 'C2', mid: 999, author: '动态作者' }),
    ],
    total: 2, degraded: false, upperMid: 999,
  };
  const cfg = mkCfg(['--oid', '404135596', '--up-top', '3', '--uid', '401315430', '--once']);
  const res = await monitor.runUpTopMode(cfg);
  assert.strictEqual(res.cards, 1);
  assert.strictEqual(String(calls.uptop[0].opts.upMid), '401315430');
  assert.strictEqual(calls.uptop[0].comment.rpid, 'C1', '只处理显式指定 UP 的评论');
});

test('runMonitorOnce：state 属于另一条动态时按首次运行处理（不出别人的互动图、不报 unpinned）', async () => {
  resetCalls();
  const outDir = mkTmpDir();
  writeState(outDir, { lastRpid: 'R_OLD', oid: '111', type: 11, lastCheck: '2026-10-01T00:00:00.000Z' });
  apiState.pinned = { comment: null, reason: 'none', upperMid: null }; // 目标动态确实没有置顶评论
  apiState.detail = mkComment({ rpid: 'R_OLD', mid: 5, author: 'fan', message: '上一条动态的旧评论' });
  const cfg = mkCfg(['--oid', '222', '--once'], { outDir });

  const res = await monitor.runMonitorOnce(cfg);
  assert.strictEqual(res.event, 'none', '换目标不得判为「取消置顶」');
  assert.strictEqual(calls.unpinned.length, 0, '不得为别的动态的旧评论出互动回顾图');
  const st = readState(outDir);
  assert.strictEqual(st.oid, '222');
  assert.strictEqual(st.lastRpid, null);
  assert.strictEqual(st.lastUnpinnedRpid, undefined, '旧 lastRpid 不得被当成本次取消置顶');
});

test('runMonitorOnce：同一 --oid 下取消置顶仍出互动回顾图，且身份取接口识别值（回归）', async () => {
  resetCalls();
  const outDir = mkTmpDir();
  writeState(outDir, { lastRpid: 'R_OLD', oid: '222', type: 11, lastCheck: '2026-10-01T00:00:00.000Z' });
  apiState.pinned = { comment: null, reason: 'none', upperMid: 999 };
  apiState.detail = mkComment({ rpid: 'R_OLD', mid: 5, author: 'fan', message: 'old' });
  const cfg = mkCfg(['--oid', '222', '--once'], { outDir });

  const res = await monitor.runMonitorOnce(cfg);
  assert.strictEqual(res.event, 'unpinned');
  assert.strictEqual(calls.unpinned.length, 1);
  assert.strictEqual(String(calls.unpinned[0].opts.upMid), '999', '身份取接口识别的 upper.mid，而非 DEFAULT_UID');
  assert.strictEqual(String(calls.unpinned[0].opts.oid), '222');
  assert.strictEqual(readState(outDir).lastUnpinnedRpid, 'R_OLD');
});

test('runMonitorOnce：置顶评论换新时先出旧评论互动图，并用接口识别身份（回归）', async () => {
  resetCalls();
  const outDir = mkTmpDir();
  writeState(outDir, { lastRpid: 'R_OLD', oid: '222', type: 11, lastCheck: '2026-10-01T00:00:00.000Z' });
  apiState.pinned = {
    comment: mkComment({ rpid: 'R_NEW', mid: 5, author: 'fan', message: '新置顶' }),
    reason: 'ok', upperMid: 999,
  };
  apiState.detail = mkComment({ rpid: 'R_OLD', mid: 5, author: 'fan', message: 'old' });
  const cfg = mkCfg(['--oid', '222', '--once'], { outDir });

  const res = await monitor.runMonitorOnce(cfg);
  assert.strictEqual(res.event, 'new');
  assert.strictEqual(calls.unpinned.length, 1, '换新前应先出旧评论的互动回顾图');
  assert.strictEqual(String(calls.unpinned[0].opts.upMid), '999');
  assert.strictEqual(calls.cards.length, 1);
  assert.strictEqual(String(calls.cards[0].opts.upMid), '999', '置顶卡 UP主 徽标身份取接口识别值');
  assert.strictEqual(readState(outDir).lastRpid, 'R_NEW');
});

test('runMonitorOnce：--演练 只报告计划，不出图、不写 state', async () => {
  resetCalls();
  const outDir = mkTmpDir();
  writeState(outDir, { lastRpid: 'R_OLD', oid: '222', type: 11, lastCheck: '2026-10-01T00:00:00.000Z' });
  apiState.pinned = { comment: mkComment({ rpid: 'R_NEW', mid: 5, author: 'fan', message: '新置顶' }), reason: 'ok', upperMid: 999 };
  apiState.detail = mkComment({ rpid: 'R_OLD', mid: 5, author: 'fan' });
  const cfg = mkCfg(['--oid', '222', '--once', '--dry-run'], { outDir });
  assert.strictEqual(cfg.dryRun, true, 'buildConfig 需透传 dryRun');

  const res = await monitor.runMonitorOnce(cfg);
  assert.strictEqual(res.event, 'dry-run');
  assert.strictEqual(res.plan.wouldRender, true);
  assert.strictEqual(res.plan.rpid, 'R_NEW');
  assert.strictEqual(calls.cards.length, 0, '演练不得出图');
  assert.strictEqual(calls.unpinned.length, 0, '演练不得出互动回顾图');
  assert.strictEqual(readState(outDir).lastRpid, 'R_OLD', '演练不得改写 state.json');
});

test('runUpTopMode：--演练 给出将出卡清单，不拉子回复、不出图', async () => {
  resetCalls();
  apiState.topComments = {
    replies: [
      mkComment({ rpid: 'C1', mid: 999, author: 'UP' }),
      mkComment({ rpid: 'C2', mid: 888, author: '粉丝' }),
    ],
    total: 2, degraded: false, upperMid: 999,
  };
  const cfg = mkCfg(['--oid', '404135596', '--up-top', '5', '--dry-run', '--once']);
  const res = await monitor.runUpTopMode(cfg);
  assert.strictEqual(res.event, 'dry-run');
  assert.strictEqual(res.plan.mode, 'single');
  assert.strictEqual(res.plan.cards, 1, '只有 1 条 UP 一级评论');
  assert.strictEqual(res.plan.dynamics[0].comments[0].rpid, 'C1');
  assert.strictEqual(calls.uptop.length, 0, '演练不得出图');
});

test('runMonitorOnce：--uid 模式置顶动态被替换仍需出卡（目标隔离不得误伤该事件）', async () => {
  resetCalls();
  const outDir = mkTmpDir();
  writeState(outDir, { lastRpid: 'R_OLD', lastDynId: '111', oid: '111', type: 11, lastCheck: '2026-10-01T00:00:00.000Z' });
  apiState.dyn = {
    dynId: '222', oid: '222', type: 11, author: 'UP', authorMid: 999, pinned: true,
    latestId: '222', latestDesc: '', latestImages: [], latestTs: 0,
    latestAuthor: 'UP', latestMid: 999, latestFace: '',
  };
  apiState.pinned = {
    comment: mkComment({ rpid: 'R_NEW', mid: 5, author: 'fan', message: '新置顶动态的评论' }),
    reason: 'ok', upperMid: 999,
  };
  apiState.detail = mkComment({ rpid: 'R_OLD', mid: 5, author: 'fan', message: 'old' });
  const cfg = mkCfg(['--uid', '999', '--once'], { outDir });

  const res = await monitor.runMonitorOnce(cfg);
  assert.strictEqual(res.event, 'new', '置顶动态 ID 变化必须判为变化并出卡');
  assert.strictEqual(calls.cards.length, 1);
  assert.strictEqual(String(calls.cards[0].opts.upMid), '999');
});
