'use strict';
/** 配置与状态持久化（~/.bili-pinned-card/config.json + 输出目录 state.json） */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CFG_DIR = path.join(os.homedir(), '.bili-pinned-card');
const CFG_FILE = path.join(CFG_DIR, 'config.json');
const DEFAULT_UID = '401315430';

// ====== 配置持久化 ======
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf-8')); } catch { return {}; }
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(CFG_DIR, { recursive: true });
    fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
    // 配置含 SESSDATA Cookie：POSIX 平台收紧为仅本人可读写（600），防同机其他用户读取
    if (process.platform !== 'win32') { try { fs.chmodSync(CFG_FILE, 0o600); } catch { /* 忽略 */ } }
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
    fs.writeFileSync(stateFile(outDir), JSON.stringify(st, null, 2), 'utf-8');
  } catch { /* 忽略 */ }
}

module.exports = {
  CFG_DIR, CFG_FILE, DEFAULT_UID,
  loadConfig, saveConfig, stateFile, loadState, saveState,
};
