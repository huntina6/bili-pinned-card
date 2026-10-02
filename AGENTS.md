# AGENTS.md —— 给 AI Agent / 自动化脚本的调用指南

本仓库是 **B站置顶评论监测 + 自动出图 CLI**（Node ≥18、CommonJS、零浏览器依赖、零外部服务）。
AI 调用请走**机器可读接口**，不要解析中文日志。

## 0. 一句话

```bash
node cli.js --json <动作词> <目标> [参数]     # stdout 是 NDJSON：每行一个 JSON 对象
```

## 1. 先读能力清单（自描述）

```bash
node cli.js 能力            # 输出 JSON：动作词 / 全部参数（含旧名）/ 取值方式 / 事件 / 卡片产物 / 退出码 / 环境变量
```

拿到清单后按 `actions[].word` 与 `flags[].arity`（`value`｜`optional`｜`flag`）拼命令，无需读中文帮助。

## 2. 最常用调用

| 目的 | 命令 | 产出 |
|---|---|---|
| 看一条动态的置顶评论 | `node cli.js --json 查看 "<动态链接>"` | `pinned-card_<时间>_<rpid>.png` |
| 给某条评论出图 | `node cli.js --json 出图 "<评论分享链接>"` | 同上（链接自带所属动态） |
| UP 互动回顾图 | `node cli.js --json 回顾 "<评论分享链接>"` | `unpinned-context_*.png` |
| 单动态 UP 热评卡 | `node cli.js --json 热评 "<动态链接>" 10` | 每条 UP 一级评论一张 `up-top_*.png` |
| 全账号热评卡 | `node cli.js --json 热评 --UP <UID> --确认 --动态上限 50` | 同上（**必须 --确认**） |
| 先看计划再决定 | `node cli.js --json --演练 热评 "<链接>" 10` | 只输出 plan，不出图、不写状态 |
| 管道传目标 | `echo "<链接>" \| node cli.js --json 查看 -` | 同上（`-` 表示从 stdin 读） |

## 3. stdout 契约（`jsonContract: 1`）

人类可读日志全部走 **stderr**；stdout 只允许出现下面这些行：

```jsonc
{"type":"start","version","action","target":{"oid","uid","rpid"},"mode":"once|watch","outDir","dryRun"}
{"type":"card","kind":"pinned|unpinned|up-top|dynamic","file","rpid","oid","index","total"}
{"type":"result","event","ok","oid","file","cards","skipped","comment":{...},"plan":{...},"durationMs"}
{"type":"error","ok":false,"error":{"kind":"auth|expired|risk|api|usage|other","code","message"},"hint"}
{"type":"end","ok","exitCode","cards","durationMs"}
```

- `result.event`：`new`（出图/换新）`unpinned` `dyn-update` `filtered` `same` `none` `up-top` `manual`
  `context` `dry-run` `cancel` `fetch-error` `error`
- `card.file` 是**绝对路径**；`result.comment` 已精简（正文截断 500 字），不会有 emote/图片 base64
- watch 模式：每轮检查输出一行 `result`；停止时补一行 `end`（`reason: "sigint" | "sigterm"`）
- 长驻进程用 **SIGTERM** 停止即可拿到 `end`（脚本/AI 推荐）；`--单次` 则跑完自动收尾

## 4. 错误处理

| 退出码 | 含义 | AI 该做什么 |
|---|---|---|
| 0 | 成功（含「无置顶评论」「未变化」） | 继续 |
| 1 | 失败 | 读 stdout 最后一行 `error.kind` |
| 130 | 用户取消 | 停止 |

| `error.kind` | 含义 | 建议动作 |
|---|---|---|
| `usage` | 参数/目标不合法 | 按 `hint` 修正；`node cli.js --帮助` |
| `auth` / `expired` | Cookie 失效/过期 | **让用户**运行 `node cli.js 登录`（需人扫码，不要自行等待） |
| `risk` | 被风控/限流 | 等几分钟重试；降低频率；匿名场景建议登录 |
| `api` | 业务错误（如 12089 评论不属于该评论区） | 检查链接与 `--类型`；换用评论分享链接 |
| `other` | 网络/未知 | 重试一次；仍失败则加 `-v` 看日志文件 |

## 5. 安全试跑（推荐流程）

1. `node cli.js --json --演练 <动作词> <目标>` → 看 `plan`（会不会出图、出几张、目标对不对）
2. 确认后去掉 `--演练` 正式执行

## 6. 目标怎么写

动态链接、评论分享链接（自动带出所属动态）、UP 空间链接（自动取 UID）、纯数字 ID 都能直接粘；
也可以把链接用管道喂进来（目标写 `-`）。

## 7. 不要做的事

- ❌ 不要在没有 `--确认` 的非交互环境下跑 `热评 --UP`：会被取消（返回 `event: cancel`）
- ❌ 不要解析中文日志/横幅来判断结果 —— 用 `--json`
- ❌ 不要并发高频调用：B站 会风控（-352/-412），程序已内置节流与退避
- ❌ 不要自动跑 `登录` 等扫码：那是需要人类完成的步骤
- ❌ 不要在 watch 模式下不设超时地等待：需要长驻就用你自己的进程管理，或改用 `--单次`

## 8. 程序内调用（不起子进程）

```js
const { checkOnce } = require('./lib/monitor'); // 安装后：require('@huntina6/bili-pinned-card/lib/monitor')
const res = await checkOnce({
  uid: '', uidExplicit: false, uidDefaulted: true,   // 不给 UP 就别填 uid
  oid: '407750907', rpid: '', type: 11, cookie: '',
  upName: '', showReplies: false, outDir: '/tmp/out',
  once: true, force: true, context: false, upTop: 0, maxDyns: Infinity,
  trackDyn: false, quiet: true, yes: true, interval: 60,
  rules: [], ruleMode: 'any',
});
// res: { event:'new'|'same'|'unpinned'|'dry-run'|..., oid, type, comment, file }
```

`--json` 是 CLI 层能力（`lib/jsonout.js`）；程序内调用直接用返回值即可。

## 9. 自检

```bash
npm test          # 离线单测（无网络）
npm run smoke     # 真实网络全链路冒烟：拉评论 → 渲染 → 出 PNG
node cli.js 能力  # 能力清单（本文件与人读帮助的共同事实来源）
```
