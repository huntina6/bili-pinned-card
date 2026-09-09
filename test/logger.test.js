'use strict';
/**
 * 文件日志模块测试（重定向临时目录，不污染真实 ~/.bili-pinned-card/logs）
 * 覆盖：分级过滤 / ANSI 剥离 / URL 与凭据消毒 / 按天文件名 / 非法级别忽略 / 目录重建
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../lib/logger');

// 每个用例独立的临时日志目录，用后清理
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-log-'));
  logger.setDir(dir);
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });
  return dir;
}
function readFile(file) {
  return fs.readFileSync(file, 'utf-8');
}

test('info/warn/error 写入当日文件，debug 默认不写', (t) => {
  const dir = tmpDir(t);
  logger.setLevel('info');
  logger.info('业务事件 A');
  logger.warn('风控警告 B');
  logger.error('致命错误 C');
  logger.debug('请求摘要 D（info 级别下不应落盘）');
  const file = logger.currentFile();
  assert.ok(file && file.startsWith(dir), '日志文件应在临时目录');
  const content = readFile(file);
  assert.ok(content.includes('业务事件 A'), 'info 应写入');
  assert.ok(content.includes('风控警告 B'), 'warn 应写入');
  assert.ok(content.includes('致命错误 C'), 'error 应写入');
  assert.ok(!content.includes('请求摘要 D'), '默认 info 级别下 debug 不应写入');
  assert.ok(!/\x1b\[/.test(content), '文件内容不应含 ANSI 颜色码');
});

test('setLevel debug 后请求摘要落盘', (t) => {
  tmpDir(t);
  logger.setLevel('debug');
  logger.debug('HTTP /x/v2/reply 摘要');
  assert.ok(readFile(logger.currentFile()).includes('HTTP /x/v2/reply 摘要'));
});

test('非法级别名忽略（保持原级别）', (t) => {
  tmpDir(t);
  logger.setLevel('verbose'); // 不存在
  assert.strictEqual(logger.getLevel(), 'debug', '上一用例设为 debug，非法名不应改变');
  logger.setLevel('info');
  logger.setLevel('');
  assert.strictEqual(logger.getLevel(), 'info');
});

test('sanitizeUrl：凭据参数打码、长值截断、普通参数保留', () => {
  // ticket 打码
  assert.strictEqual(
    logger.sanitizeUrl('https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=41fc10794ddea041280c251a0438fcb3&gourl=https%3A%2F%2Fwww.bilibili.com'),
    'https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=***&gourl=***'
  );
  // 业务 query 保留；长值截断
  const u = logger.sanitizeUrl('https://api.bilibili.com/x/v2/reply/wbi/main?mode=3&oid=404135596&pagination_str=' + encodeURIComponent('{"offset":"CAEiAggCAEiAggCAEiAggCAEiAggCAEiAggCAEiAgg"}'));
  assert.ok(u.startsWith('https://api.bilibili.com/x/v2/reply/wbi/main?'), '业务 URL 保留路径');
  assert.ok(u.includes('mode=3') && u.includes('oid=404135596'), '安全 query 参数保留');
  assert.ok(!u.includes('CAEiAggCAEiAggCAEiAggCAEiAggCAEiAggCAEiAgg'), '长游标值应被截断打码');
  // SESSDATA 类键一律打码
  const q = logger.sanitizeUrl('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=abc&source=main-fe-header');
  assert.ok(q.includes('qrcode_key=***'), 'qrcode_key 视为敏感键打码');
  // 非法 URL 整体打码且不抛错
  const bad = logger.sanitizeUrl('not a url at all with a very very very very long tail beyond 32 chars');
  assert.ok(bad.startsWith('not a url at'), '非法 URL 保留截断前缀');
  assert.ok(bad.includes('…(') && bad.endsWith('字符)'), '超长值应打码标注长度');
});

test('ANSI 字符串落盘自动剥离颜色', (t) => {
  tmpDir(t);
  logger.info(`\x1b[2m（dim）\x1b[0m 卡片已生成: \x1b[36mcyan\x1b[0m`);
  assert.ok(!/\x1b\[/.test(readFile(logger.currentFile())), 'ANSI 应被剥离');
});

test('目录自动创建（深层路径不存在时首次写入成功）', (t) => {
  const dir = path.join(tmpDir(t), 'nested', 'logs');
  logger.setDir(dir);
  logger.info('深层目录写入');
  assert.ok(fs.existsSync(path.join(dir, logger.currentFile().split(path.sep).pop())), '日志文件应存在');
});
