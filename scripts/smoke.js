#!/usr/bin/env node
'use strict';
/**
 * 冒烟测试：真实网络全链路「拉评论 → 渲染 → 出 PNG」
 * 用法: npm run smoke             # 默认动态 404135596
 *       npm run smoke -- 123456   # 指定动态 ID（或 SMOKE_OID 环境变量）
 * 说明: 需要网络；产出 PNG 则 exit 0，否则 exit 1。输出到系统临时目录，不污染 output/。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkOnce } = require('../lib/monitor');
const { loadConfig } = require('../lib/state');

const OID = String(process.env.SMOKE_OID || process.argv[2] || '404135596').replace(/\D/g, '') || '404135596';

(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-smoke-'));
  let cookie = '';
  try { cookie = loadConfig().cookie || ''; } catch { /* 无配置则匿名 */ }

  const cfg = {
    uid: '', oid: OID, rpid: '', type: 11, cookie, upName: '',
    showReplies: false, outDir, force: true /* 强制出图，不受置顶未变化影响 */,
    trackDyn: false, context: false, quiet: false,
    upTop: 0, maxDyns: Infinity, yes: true, uidExplicit: false, interval: 60, once: true,
  };

  console.log(`冒烟: 动态 ${OID}${cookie ? '（已带 Cookie）' : '（匿名）'} → ${outDir}`);
  const t0 = Date.now();
  try {
    const res = await checkOnce(cfg);
    const pngs = fs.readdirSync(outDir).filter(f => f.endsWith('.png'));
    if (!pngs.length) {
      console.error(`❌ 冒烟失败: 未产出 PNG（event=${res && res.event}）`);
      process.exit(1);
    }
    const f = path.join(outDir, pngs[0]);
    const size = fs.statSync(f).size;
    if (size < 1024) {
      console.error(`❌ 冒烟失败: PNG 尺寸异常（${size}B）: ${f}`);
      process.exit(1);
    }
    console.log(`✅ 冒烟通过 ${((Date.now() - t0) / 1000).toFixed(1)}s | ${pngs[0]}（${(size / 1024).toFixed(0)}KB）`);
    console.log(`   产出目录: ${outDir}`);
    process.exit(0);
  } catch (err) {
    console.error(`❌ 冒烟失败: ${err.message || err}`);
    console.error(`   排查: 网络与风控状态见 ~/.bili-pinned-card/logs/；若风控冷却后重试`);
    process.exit(1);
  }
})();
