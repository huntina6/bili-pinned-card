/**
 * 全局类型声明（JSDoc/checkJs 使用；零运行时影响）
 * 只声明跨模块复用的核心数据结构，避免各文件重复内联
 */

/** 运行配置（lib/args.js buildConfig 产物 + 交互修改） */
interface CliConfig {
  uid: string;
  uidExplicit: boolean;
  oid: string;
  rpid: string;
  type: number;
  cookie: string;
  upName: string;
  showReplies: boolean;
  interval: number;
  outDir: string;
  once: boolean;
  force: boolean;
  context: boolean;
  upTop: number;
  maxDyns: number;
  yes: boolean;
  trackDyn: boolean;
  quiet: boolean;
}
