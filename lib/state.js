'use strict';
/** 配置与状态持久化（~/.bili-pinned-card/config.json + 输出目录 state.json） */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CFG_DIR = path.join(os.homedir(), '.bili-pinned-card');
const CFG_FILE = path.join(CFG_DIR, 'config.json');
const DEFAULT_UID = '401315430';

// ====== 配置持久化 ======
/**
 * 原子写：写临时文件 → rename 覆盖（同目录保证同文件系统）
 * 中途断电/崩溃不会产生半截文件（要么完整旧内容、要么完整新内容）
 * @param {string} file 目标文件
 * @param {string} content 内容
 * @param {number} [mode] 非 0 时在非 Windows 平台收紧权限（如 0o600）
 */
function atomicWrite(file, content, mode = 0) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    if (mode && process.platform !== 'win32') { try { fs.chmodSync(tmp, mode); } catch { /* 忽略 */ } }
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      // Windows：目标被占用/拒绝时先删再改名；其他平台直接抛
      if (process.platform === 'win32') {
        try { fs.unlinkSync(file); } catch { /* 目标可能不存在 */ }
        fs.renameSync(tmp, file);
      } else { throw e; }
    }
  } catch {
    // 原子路径失败 → 直接写兜底（行为不劣于旧版）
    try {
      fs.writeFileSync(file, content, 'utf-8');
      if (mode && process.platform !== 'win32') { try { fs.chmodSync(file, mode); } catch { /* 忽略 */ } }
    } catch { /* 忽略 */ }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 已 rename 或不存在 */ }
  }
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf-8')); } catch { return {}; }
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(CFG_DIR, { recursive: true });
    // 配置含 SESSDATA Cookie：POSIX 平台权限收紧为仅本人可读写（600），防同机其他用户读取
    atomicWrite(CFG_FILE, JSON.stringify(cfg, null, 2), 0o600);
  } catch { /* 忽略 */ }
}

// ====== 状态（输出目录内） ======
function stateFile(outDir) {
  return path.join(outDir, 'state.json');
}
function loadState(outDir) {
  try { return JSON.parse(fs.readFileSync(stateFile(outDir), 'utf-8')); } catch { return null; }
}
function saveState(outDir, st) {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    atomicWrite(stateFile(outDir), JSON.stringify(st, null, 2));
  } catch { /* 忽略 */ }
}

module.exports = {
  CFG_DIR, CFG_FILE, DEFAULT_UID,
  loadConfig, saveConfig, stateFile, loadState, saveState, atomicWrite,
};
