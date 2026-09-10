'use strict';
/**
 * 配置持久化测试：原子写（临时文件+rename）、无 tmp 残留、权限收紧、覆盖旧内容
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWrite, saveState, loadState } = require('../lib/state');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-state-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });
  return dir;
}

test('atomicWrite 正常写入：内容完整、无 tmp 残留', (t) => {
  const dir = tmpDir(t);
  const f = path.join(dir, 'cfg.json');
  atomicWrite(f, '{"a":1}', 0o600);
  assert.strictEqual(fs.readFileSync(f, 'utf-8'), '{"a":1}');
  assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.includes('.tmp')), [], '不应残留临时文件');
});

test('atomicWrite 覆盖旧文件（rename 覆盖语义）', (t) => {
  const dir = tmpDir(t);
  const f = path.join(dir, 'cfg.json');
  fs.writeFileSync(f, 'OLD');
  atomicWrite(f, 'NEW');
  assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'NEW');
});

test('atomicWrite 权限收紧为 600（仅 POSIX）', (t) => {
  if (process.platform === 'win32') return; // Windows 无 POSIX 权限位
  const dir = tmpDir(t);
  const f = path.join(dir, 'secret.json');
  atomicWrite(f, '{"cookie":"x"}', 0o600);
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
});

test('saveState / loadState 往返一致（原子写集成）', (t) => {
  const dir = tmpDir(t);
  const st = { lastRpid: '123', lastPinnedTs: 1759 };
  saveState(dir, st);
  assert.deepStrictEqual(loadState(dir), st);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.includes('.tmp')), []);
});

test('atomicWrite 目标目录不存在时静默（不抛错）', () => {
  const bad = path.join(os.tmpdir(), 'bpc-nonexistent-' + Date.now(), 'sub', 'x.json');
  assert.doesNotThrow(() => atomicWrite(bad, 'x'));
});
