/**
 * 全局类型声明（JSDoc/checkJs 使用；零运行时影响）
 * 只声明跨模块复用的核心数据结构，避免各文件重复内联
 */

/** 运行配置（lib/args.js buildConfig 产物 + 交互修改） */
interface CliConfig {
  uid: string;
  /** 是否由命令行/向导显式指定 uid（false 表示 uid 可能只是 DEFAULT_UID 兜底值） */
  uidExplicit: boolean;
  /** uid 是否来自 DEFAULT_UID 兜底（true 时不得当作「UP 身份」使用，见 monitor.resolveUpMid） */
  uidDefaulted: boolean;
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
  scale: number;
  yes: boolean;
  trackDyn: boolean;
  quiet: boolean;
  /** 内容规则（关键字/正则，任一/全部命中才出图）；空数组=不启用过滤 */
  rules: string[];
  /** 多条规则的组合方式 */
  ruleMode: 'any' | 'all';
  /** 通知 Webhook 地址（空=关闭推送） */
  notifyWebhook: string;
  /** Webhook 消息体模板 */
  notifyFormat: string;
  /** 订阅的通知事件：null/未指定=全部订阅；显式空数组=不订阅任何事件 */
  notifyEvents: string[] | null;
  /** Telegram 渠道 chat_id */
  notifyChatId: string;
  /** 推送标题前缀（如 UP 名） */
  notifyPrefix: string;
  /** 机器可读输出（--json）：stdout 只出 NDJSON，人类日志走 stderr */
  json: boolean;
  /** 演练（--dry-run）：只解析与报告计划，不渲染 PNG、不写 state.json */
  dryRun: boolean;
}
