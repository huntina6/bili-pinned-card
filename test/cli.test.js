'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const { parseArgs, buildConfig, DEFAULT_OUT_DIR, HELP, FLAG_ALIASES, ACTIONS } = require('../lib/args');
const { NOTIFY_EVENTS } = require('../lib/notify');
const { DEFAULT_UID } = require('../lib/state');
const { maskWebhook } = require('../lib/interactive');
const PROJECT_OUT = path.join(path.resolve(__dirname, '..'), 'output');

test('普通命令未显式 --up-top：旧配置缺 upTop 字段时默认关闭（回归）', () => {
  const args = parseArgs(['--oid', '404135596', '--once']);
  assert.strictEqual(args.upTop, null);
  const cfg = buildConfig(args, {});
  assert.strictEqual(cfg.upTop, 0);
  assert.strictEqual(cfg.oid, '404135596');
});

test('buildConfig 无已保存配置且未显式 --up-top：默认关闭', () => {
  const cfg = buildConfig(parseArgs(['--oid', '404135596']));
  assert.strictEqual(cfg.upTop, 0);
});

test('--up-top 不带数字：沿用上次向导条数，缺省 10', () => {
  const args = parseArgs(['--oid', '404135596', '--up-top']);
  assert.strictEqual(args.upTop, null);
  assert.strictEqual(args.upTopBare, true);
  assert.strictEqual(buildConfig(args, {}).upTop, 10); // 无历史值 → 10
  assert.strictEqual(buildConfig(args, { lastUpTop: 25 }).upTop, 25); // 有历史值 → 沿用
});

test('--up-top N：使用指定 N，0 也可显式关闭', () => {
  assert.strictEqual(parseArgs(['--up-top', '3']).upTop, 3);
  assert.strictEqual(parseArgs(['--up-top', '0']).upTop, 0);
});

test('已保存的 upTop 配置在未传参数时保留', () => {
  const cfg = buildConfig(parseArgs(['--oid', '404135596']), { upTop: 5 });
  assert.strictEqual(cfg.upTop, 5);
});

test('--version / -V 解析', () => {
  assert.strictEqual(parseArgs(['--version']).version, true);
  assert.strictEqual(parseArgs(['-V']).version, true);
  assert.strictEqual(parseArgs(['--oid', '404135596']).version, false);
});

test('--max-dyns 非法值回退默认（NaN/0/负数不作为上限）', () => {
  assert.strictEqual(parseArgs(['--max-dyns', 'abc']).maxDyns, null);
  assert.strictEqual(parseArgs(['--max-dyns', '0']).maxDyns, null);
  assert.strictEqual(parseArgs(['--max-dyns', '-3']).maxDyns, null);
  assert.strictEqual(parseArgs(['--max-dyns', '50']).maxDyns, 50);
  assert.strictEqual(buildConfig(parseArgs(['--max-dyns', 'abc']), {}).maxDyns, Infinity);
});

test('--scale / --no-emoji 解析与默认值', () => {
  assert.strictEqual(parseArgs(['--scale', '1']).scale, 1);
  assert.strictEqual(parseArgs(['--scale', '3']).scale, 3);
  assert.strictEqual(parseArgs(['--scale', '9']).scale, null, '越界回退默认');
  assert.strictEqual(parseArgs(['--scale', 'x']).scale, null);
  assert.strictEqual(buildConfig(parseArgs(['--scale', 'x']), {}).scale, 2);
  assert.strictEqual(buildConfig(parseArgs(['--scale', '1']), {}).scale, 1);
  assert.strictEqual(parseArgs(['--no-emoji']).noEmoji, true);
  assert.strictEqual(parseArgs([]).noEmoji, false);
});

test('--scale 支持小数倍率（0.5~6）', () => {
  assert.strictEqual(parseArgs(['--scale', '1.5']).scale, 1.5);
  assert.strictEqual(parseArgs(['--scale', '0.5']).scale, 0.5);
  assert.strictEqual(parseArgs(['--scale', '6']).scale, 6);
  assert.strictEqual(parseArgs(['--scale', '0.4']).scale, null);
  assert.strictEqual(parseArgs(['--scale', '6.5']).scale, null);
  assert.strictEqual(buildConfig(parseArgs(['--scale', '1.5']), {}).scale, 1.5);
  assert.strictEqual(buildConfig(parseArgs([]), { scale: 2.5 }).scale, 2.5, '保存的小数倍率有效');
  assert.strictEqual(buildConfig(parseArgs([]), { scale: 99 }).scale, 2, '保存的非法倍率回退 2');
});

test('--width 自定义输出宽度且优先于 --scale', () => {
  assert.strictEqual(parseArgs(['--width', '1360']).width, 1360);
  assert.strictEqual(parseArgs(['--width', '340']).width, 340);
  assert.strictEqual(parseArgs(['--width', '4080']).width, 4080);
  assert.strictEqual(parseArgs(['--width', '339']).width, null);
  assert.strictEqual(parseArgs(['--width', '4081']).width, null);
  assert.strictEqual(parseArgs(['--width', 'abc']).width, null);
  assert.strictEqual(buildConfig(parseArgs(['--width', '2040']), {}).scale, 3);
  assert.strictEqual(buildConfig(parseArgs(['--width', '680']), {}).scale, 1);
  assert.strictEqual(buildConfig(parseArgs(['--width', '1360', '--scale', '1']), {}).scale, 2, '--width 最高优先');
});

// ====== 输出目录：默认跟随项目目录（与 cwd 无关） ======
test('默认输出目录 = 项目目录/output（常量与 buildConfig 一致）', () => {
  assert.strictEqual(DEFAULT_OUT_DIR, PROJECT_OUT);
  assert.strictEqual(buildConfig(parseArgs([]), {}).outDir, PROJECT_OUT);
  assert.strictEqual(buildConfig(parseArgs(['--oid', '404135596']), {}).outDir, PROJECT_OUT);
});

test('旧配置遗留的 <任意目录>/output 默认值自动迁移到项目目录', () => {
  // 历史版本保存的是 cwd/output 绝对路径（未标记自定义）
  assert.strictEqual(buildConfig(parseArgs([]), { outDir: 'C:/projects/legacy-app/output' }).outDir, PROJECT_OUT);
  assert.strictEqual(buildConfig(parseArgs([]), { outDir: '/opt/legacy-app/output' }).outDir, PROJECT_OUT);
});

test('自定义输出目录保留；显式 --out 最高优先', () => {
  // 非 output 结尾 → 视为用户自定义，保留
  assert.strictEqual(buildConfig(parseArgs([]), { outDir: 'D:/cards' }).outDir, 'D:/cards');
  assert.strictEqual(buildConfig(parseArgs([]), { outDir: 'relative-cards' }).outDir, 'relative-cards');
  // 带自定义标记的 output 目录也保留
  assert.strictEqual(buildConfig(parseArgs([]), { outDir: 'D:/cards/output', outDirCustom: true }).outDir, 'D:/cards/output');
  // --out 覆盖一切
  assert.strictEqual(buildConfig(parseArgs(['--out', 'mycards']), { outDir: 'D:/cards', outDirCustom: true }).outDir, 'mycards');
});

// ====== 内容规则（--rule / --rule-mode）：默认关闭，缺省行为零变化 ======
test('未配置规则时 rules 为空且 ruleMode 默认 any', () => {
  const cfg = buildConfig(parseArgs(['--oid', '404135596']), {});
  assert.deepStrictEqual(cfg.rules, []);
  assert.strictEqual(cfg.ruleMode, 'any');
});

test('--rule 可重复且去重；--rule-mode all 生效', () => {
  const args = parseArgs(['--rule', '抽奖', '--rule', '/预告/i', '--rule', '抽奖', '--rule-mode', 'all']);
  const cfg = buildConfig(args, {});
  assert.deepStrictEqual(cfg.rules, ['抽奖', '/预告/i']);
  assert.strictEqual(cfg.ruleMode, 'all');
});

test('已保存的 rules 在未传参数时保留，命令行覆盖保存值', () => {
  assert.deepStrictEqual(buildConfig(parseArgs([]), { rules: ['保存的'] }).rules, ['保存的']);
  assert.deepStrictEqual(buildConfig(parseArgs(['--rule', '命令行']), { rules: ['保存的'] }).rules, ['命令行']);
});

// ====== 通知推送参数：默认关闭 ======
test('未配置通知参数：Webhook 为空、格式 generic、事件未指定（运行期全订阅）', () => {
  const cfg = buildConfig(parseArgs(['--oid', '404135596']), {});
  assert.strictEqual(cfg.notifyWebhook, '');
  assert.strictEqual(cfg.notifyFormat, 'generic');
  assert.strictEqual(cfg.notifyEvents, null, '未指定=null（全订阅）；显式空数组才表示不订阅任何事件');
  assert.strictEqual(cfg.notifyPrefix, '');
});

test('--notify-events：显式空串=不订阅任何事件；保存的空数组原样保留', () => {
  assert.deepStrictEqual(parseArgs(['--notify-events', '']).notifyEvents, []);
  assert.deepStrictEqual(buildConfig(parseArgs(['--notify-events', '']), {}).notifyEvents, []);
  assert.deepStrictEqual(buildConfig(parseArgs([]), { notifyEvents: [] }).notifyEvents, [],
    '向导保存的「全不选」必须保持为空数组，不能被回退成全订阅');
  assert.deepStrictEqual(buildConfig(parseArgs([]), { notifyEvents: ['new'] }).notifyEvents, ['new']);
  assert.deepStrictEqual(buildConfig(parseArgs(['--notify-events', 'new,error']), {
    notifyEvents: ['unpinned'],
  }).notifyEvents, ['new', 'error'], '命令行覆盖保存值');
});

test('buildConfig：uid 来自 DEFAULT_UID 兜底时打 uidDefaulted（身份解析据此避开默认账号）', () => {
  const def = buildConfig(parseArgs(['--oid', '404135596']), {});
  assert.strictEqual(def.uid, DEFAULT_UID);
  assert.strictEqual(def.uidExplicit, false);
  assert.strictEqual(def.uidDefaulted, true);

  const explicit = buildConfig(parseArgs(['--oid', '404135596', '--uid', '999']), {});
  assert.strictEqual(explicit.uid, '999');
  assert.strictEqual(explicit.uidExplicit, true);
  assert.strictEqual(explicit.uidDefaulted, false);

  const saved = buildConfig(parseArgs(['--oid', '404135596']), { uid: '888' });
  assert.strictEqual(saved.uid, '888');
  assert.strictEqual(saved.uidExplicit, false);
  assert.strictEqual(saved.uidDefaulted, false, '已保存的 uid 是用户配置，可作身份兜底');
});

test('buildConfig：uid 为空串时仍走 DEFAULT_UID 兜底（匿名自动识别置顶动态的默认账号）', () => {
  const cfg = buildConfig(parseArgs(['--uid', '', '--oid', '404135596']), {});
  assert.strictEqual(cfg.uid, DEFAULT_UID);
  assert.strictEqual(cfg.uidDefaulted, true);
});

test('通知参数解析与保存值回退', () => {
  const args = parseArgs([
    '--notify-webhook', 'https://example.com/hook',
    '--notify-format', 'feishu', '--notify-events', 'new, unpinned',
    '--notify-chat-id', '42', '--notify-prefix', '【UP】',
  ]);
  const cfg = buildConfig(args, {});
  assert.strictEqual(cfg.notifyWebhook, 'https://example.com/hook');
  assert.strictEqual(cfg.notifyFormat, 'feishu');
  assert.deepStrictEqual(cfg.notifyEvents, ['new', 'unpinned']);
  assert.strictEqual(cfg.notifyChatId, '42');
  assert.strictEqual(cfg.notifyPrefix, '【UP】');

  const saved = buildConfig(parseArgs([]), {
    notifyWebhook: 'https://saved.example/hook', notifyFormat: 'dingtalk', notifyEvents: ['error'],
  });
  assert.strictEqual(saved.notifyWebhook, 'https://saved.example/hook');
  assert.strictEqual(saved.notifyFormat, 'dingtalk');
  assert.deepStrictEqual(saved.notifyEvents, ['error']);
  assert.strictEqual(buildConfig(parseArgs([]), { notifyFormat: '非法' }).notifyFormat, 'generic', '非法保存值回退 generic');
});

// ====== CLI 写法重构：中文名 / 英文名 / 旧写法 三种写法等价 + 中文动作词 ======
const snap = a => ({
  uid: a.uid, oid: a.oid, rpid: a.rpid, interval: a.interval, out: a.out, quiet: a.quiet,
  once: a.once, upTop: a.upTop, upTopBare: a.upTopBare, help: a.help, login: a.login, context: a.context,
});

test('三种写法等价：中文名 == 英文名 == 旧参数名', () => {
  const cn = snap(parseArgs(['--动态', '404135596', '--评论', '123', '--间隔', '30', '--输出', '/tmp/o', '--静音', '--单次', '--登录', '--回顾']));
  const en = snap(parseArgs(['--dynamic', '404135596', '--comment', '123', '--every', '30', '--output', '/tmp/o', '--quiet', '--once', '--login', '--context']));
  const old = snap(parseArgs(['--oid', '404135596', '--rpid', '123', '--interval', '30', '--out', '/tmp/o', '--quiet', '--once', '--login', '--context']));
  assert.deepStrictEqual(cn, en);
  assert.deepStrictEqual(cn, old);
  assert.strictEqual(cn.oid, '404135596');
  assert.strictEqual(cn.rpid, '123');
  assert.strictEqual(cn.interval, '30');
  assert.strictEqual(cn.quiet, true);
});

test('--UP 接受 UID / 空间链接，且长选项大小写不敏感', () => {
  assert.strictEqual(parseArgs(['--UP', '401315430']).uid, '401315430');
  assert.strictEqual(parseArgs(['--UP', 'https://space.bilibili.com/401315430']).uid, '401315430');
  assert.strictEqual(parseArgs(['--up', 'https://space.bilibili.com/401315430/video']).uid, '401315430');
  assert.strictEqual(parseArgs(['--uid', '401315430']).uid, '401315430');
});

test('短选项区分大小写：-i 是间隔、-I 是向导', () => {
  assert.strictEqual(parseArgs(['-i', '30']).interval, '30');
  const big = parseArgs(['-I']);
  assert.strictEqual(big.interactive, true);
  assert.strictEqual(big.interval, null);
});

test('动作词：查看 / 监控 / 热评 / 出图 / 回顾 / 登录 / 帮助', () => {
  const view = parseArgs(['查看', 'https://www.bilibili.com/opus/123']);
  assert.strictEqual(view.oid, 'https://www.bilibili.com/opus/123');
  assert.strictEqual(view.once, true);

  const watch = parseArgs(['监控', 'https://space.bilibili.com/401315430']);
  assert.strictEqual(watch.uid, '401315430');
  assert.strictEqual(watch.once, false, '监控默认持续运行');

  const hot = parseArgs(['热评', 'https://www.bilibili.com/opus/123']);
  assert.strictEqual(hot.upTopBare, true, '不带条数 → 沿用上次向导值（缺省 10）');
  assert.strictEqual(hot.once, true, '热评是跑一遍就完的批任务');

  const card = parseArgs(['出图', 'https://t.bilibili.com/407750907?comment_root_id=319181633760']);
  assert.strictEqual(card.rpid, 'https://t.bilibili.com/407750907?comment_root_id=319181633760');
  assert.strictEqual(card.oid, 'https://t.bilibili.com/407750907?comment_root_id=319181633760',
    '评论分享链接里同时含评论 ID 与所属动态，一次填好两个目标');
  assert.strictEqual(card.once, true);

  assert.strictEqual(parseArgs(['回顾', 'https://t.bilibili.com/407750907?comment_root_id=319181633760']).context, true);
  assert.strictEqual(parseArgs(['登录']).login, true);
  assert.strictEqual(parseArgs(['帮助']).help, true);
  assert.strictEqual(parseArgs(['help']).help, true, '英文动作词同样可用');
});

test('动作词与参数顺序无关；显式参数优先于动作词默认值', () => {
  const a = parseArgs(['--单次', '查看', 'https://www.bilibili.com/opus/123']);
  assert.strictEqual(a.oid, 'https://www.bilibili.com/opus/123');
  assert.strictEqual(a.once, true);

  const b = parseArgs(['监控', 'https://space.bilibili.com/401315430', '--间隔', '90']);
  assert.strictEqual(b.interval, '90', '显式 --间隔 优先于位置参数');

  const c = parseArgs(['热评', 'https://www.bilibili.com/opus/123', '--条数', '7']);
  assert.strictEqual(c.upTop, 7);

  const d = parseArgs(['热评', 'https://www.bilibili.com/opus/123', '--监控']);
  assert.strictEqual(d.once, false, '--监控 可覆盖动作词的「跑一次」默认');
});

test('动作词的数量参数：监控 <目标> 60 / 热评 <目标> 20', () => {
  assert.strictEqual(parseArgs(['监控', 'https://space.bilibili.com/401315430', '60']).interval, 60);
  const hot = parseArgs(['热评', 'https://www.bilibili.com/opus/123', '20']);
  assert.strictEqual(hot.upTop, 20);
  assert.strictEqual(hot.upTopBare, false);
});

test('动作词缺目标 → 简洁帮助（不猜默认账号）', () => {
  for (const word of ['查看', '监控', '热评', '出图', '回顾']) {
    assert.strictEqual(parseArgs([word]).shortHelp, true, word);
  }
  assert.strictEqual(parseArgs(['登录']).shortHelp, false);
  assert.strictEqual(parseArgs(['出图', '--评论', '123']).shortHelp, false, '用参数给出目标时不算缺目标');
  assert.strictEqual(parseArgs(['热评', '--UP', '401315430']).shortHelp, false);
});

test('旧用法保留：裸链接 / 裸数字仍是动态目标', () => {
  assert.strictEqual(parseArgs(['https://www.bilibili.com/opus/123']).oid, 'https://www.bilibili.com/opus/123');
  assert.strictEqual(parseArgs(['404135596']).oid, '404135596');
  const a = parseArgs(['404135596', '--单次']);
  assert.strictEqual(a.oid, '404135596');
  assert.strictEqual(a.once, true);
});

test('未知参数直接报错退出（历史实现会把 -x 静默当成裸 oid；缺目标的动作词给简洁帮助）', () => {
  const run = (arg) => {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'cli.js'), arg], { encoding: 'utf8', stdio: 'pipe' });
      return { code: 0, text: '' };
    } catch (e) {
      return { code: e.status, text: String(e.stdout || '') + String(e.stderr || '') };
    }
  };
  for (const arg of ['--不存在的参数', '-x']) {
    const r = run(arg);
    assert.strictEqual(r.code, 1, arg + ' 应以 1 退出');
    assert.match(r.text, /未知参数/);
  }
  const short = run('查看');
  assert.strictEqual(short.code, 1, '缺目标应以 1 退出');
  assert.match(short.text, /配置向导/);
});

// ====== --帮助 完整性：新增参数/功能必须同步写进帮助（防文档漂移）======
test('--帮助 覆盖全部动作词、全部参数写法、全部通知事件与关键功能', () => {
  for (const word of Object.keys(ACTIONS)) assert.ok(HELP.includes(word), '帮助缺少动作词: ' + word);
  for (const name of Object.keys(FLAG_ALIASES)) assert.ok(HELP.includes(name), '帮助缺少参数写法: ' + name);
  for (const ev of NOTIFY_EVENTS) assert.ok(HELP.includes(ev), '帮助缺少通知事件: ' + ev);

  // 四类卡片产物、状态文件、latest 副本必须写明
  for (const k of ['pinned-card', 'unpinned-context', 'up-top', 'dynamic-update', 'latest.png', 'state.json']) {
    assert.ok(HELP.includes(k), '帮助缺少: ' + k);
  }
  // 章节结构（示例先行 → 动作词逐条说明 → 全部功能 → 参数逐条说明 → 环境变量/退出码）
  for (const s of ['快速开始', '动作词', '支持的全部功能', '参数逐条说明', '环境变量', '退出码', '兼容写法']) {
    assert.ok(HELP.includes(s), '帮助缺少章节: ' + s);
  }
  // 每条动作词都要有「具体干什么」的展开（帮助里以「英文 xx ＝ ...」形式给出等价参数）
  for (const eq of ['英文 view', '英文 watch', '英文 top', '英文 card', '英文 context', '英文 login', '英文 help']) {
    assert.ok(HELP.includes(eq), '帮助缺少动作词展开: ' + eq);
  }
  assert.ok(HELP.split('\n').length > 150, '完整说明书应足够详细（当前 ' + HELP.split('\n').length + ' 行）');
});

// ====== 机器可读接口（给 AI / 脚本调用）======
test('机器可读参数三种写法等价：--json / -j / --机器可读，--演练 / --dry-run / --预演，--能力 / --caps', () => {
  for (const f of ['--json', '-j', '--机器可读']) assert.strictEqual(parseArgs([f, '--oid', '1']).json, true, f);
  for (const f of ['--演练', '--dry-run', '--预演']) assert.strictEqual(parseArgs([f]).dryRun, true, f);
  assert.strictEqual(parseArgs(['--能力']).caps, true);
  assert.strictEqual(parseArgs(['能力']).caps, true);
  assert.strictEqual(parseArgs(['caps']).caps, true);
  const cfg = buildConfig(parseArgs(['--json', '--演练', '--oid', '1']), {});
  assert.strictEqual(cfg.json, true);
  assert.strictEqual(cfg.dryRun, true);
});

test('目标写 - 表示从标准输入读（不是未知选项）', () => {
  const a = parseArgs(['查看', '-']);
  assert.strictEqual(a.oid, '-');
  assert.strictEqual(a.shortHelp, false);
  assert.strictEqual(parseArgs(['--评论', '-', '--动态', '1']).rpid, '-');
});

test('能力清单：覆盖全部动作词与全部参数写法（AI 自描述不漂移）', () => {
  const { buildCaps } = require('../lib/caps');
  const caps = buildCaps();
  assert.strictEqual(caps.jsonContract, 1);
  assert.ok(caps.version, '需要版本号');
  const words = caps.actions.map(a => a.word);
  for (const w of Object.keys(ACTIONS)) assert.ok(words.includes(w), '能力清单缺少动作词 ' + w);
  const names = new Set(caps.flags.flatMap(f => f.aliases));
  for (const n of Object.keys(FLAG_ALIASES)) assert.ok(names.has(n), '能力清单缺少参数写法 ' + n);
  for (const f of caps.flags) {
    assert.ok(['value', 'optional', 'flag'].includes(f.arity), f.name + ' 取值方式非法');
    assert.ok(f.desc, f.name + ' 缺少说明');
  }
  assert.deepStrictEqual(caps.events, NOTIFY_EVENTS);
  assert.strictEqual(caps.cards.length, 4, '四类卡片产物');
  assert.ok(caps.exitCodes[0] && caps.exitCodes[1] && caps.exitCodes[130]);
});

test('jsonout：评论精简、错误分类与修复建议', () => {
  const jsonout = require('../lib/jsonout');
  assert.strictEqual(jsonout.pickComment(null), null);
  const c = jsonout.pickComment({ rpid: 1, author: 'a', mid: 2, ctime: 3, message: 'x'.repeat(600), like: 4, rcount: 5, pictures: [1, 2] });
  assert.strictEqual(c.rpid, '1');
  assert.strictEqual(c.mid, '2');
  assert.strictEqual(c.message.length, 500, '长正文截断，避免 JSON 流被塞爆');
  assert.strictEqual(c.pictures, 2);
  assert.strictEqual(jsonout.describeError({ code: -101, message: 'x' }).error.kind, 'auth');
  assert.strictEqual(jsonout.describeError({ code: -352, message: 'x' }).error.kind, 'risk');
  assert.strictEqual(jsonout.describeError({ code: 12089, message: 'x' }).error.kind, 'api');
  assert.strictEqual(jsonout.describeError(new Error('boom')).error.kind, 'other');
  assert.match(jsonout.describeError({ code: -101, message: 'x' }).hint, /登录/);
});

test('能力清单可通过 CLI 输出；--json 下用法错误也给机器可读错误行（stdout 只有 JSON）', () => {
  const run = (argv) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [path.join(ROOT, 'cli.js'), ...argv], { encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e) { return { code: e.status, out: String(e.stdout || '') }; }
  };
  const caps = JSON.parse(run(['能力']).out);
  assert.strictEqual(caps.name, '@huntina6/bili-pinned-card');
  assert.ok(Array.isArray(caps.flags) && caps.flags.length > 20);

  const bad = run(['--json', '查看']); // 缺目标
  assert.strictEqual(bad.code, 1);
  const lines = bad.out.trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, 'stdout 应只有一行 JSON（人类帮助走 stderr）');
  const obj = JSON.parse(lines[0]);
  assert.strictEqual(obj.type, 'error');
  assert.strictEqual(obj.ok, false);
  assert.strictEqual(obj.error.kind, 'usage');
});

test('maskWebhook：仅暴露 host 与路径前缀，凭据不入摘要', () => {
  assert.strictEqual(maskWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/secret-token'),
    'https://open.feishu.cn/open-ap…');
  assert.strictEqual(maskWebhook('https://example.com/x'), 'https://example.com/x');
  assert.strictEqual(maskWebhook('not-a-url'), '(已配置)');
});
