# CODEBUDDY.md

B 站置顶评论监测 + 自动出图 CLI（Node ≥18 / CommonJS / 零浏览器依赖；`@resvg/resvg-js` 渲染 PNG）。本文件为项目记忆，供后续会话快速恢复上下文。

## 常用命令

> 本机 node/npm 由 IDE 托管：`~/.workbuddy/binaries/node/versions/22.12.0/bin`（不在默认 PATH，先 export 或用绝对路径）。

```bash
export PATH="$HOME/.workbuddy/binaries/node/versions/22.12.0/bin:$PATH"

npm test            # node:test 全量（301 用例，约 75s）
npm run check       # 全部 JS 语法检查（51 文件）
npm run typecheck   # tsc --noEmit
npm run smoke       # 真实网络冒烟：拉评论 → 渲染 → 出 PNG

# 常用实跑（匿名可用；三种写法等价：中文动作词 / 中文参数名 / 旧参数名）
node cli.js 查看 "https://www.bilibili.com/opus/<新式ID>"      # 置顶评论出图（跑一次）
node cli.js 查看 <动态链接> --回复                              # 附精彩回复
node cli.js 出图 "<评论分享链接>"                                # 指定评论出图（自动带出所属动态）
node cli.js 回顾 "<评论分享链接>"                                # UP 互动回顾图
node cli.js 监控 <动态链接|UP空间链接> 60                        # 持续监控（默认 60s）
node cli.js 热评 <动态链接> 10                                  # UP 热评 TOP 卡
node cli.js --oid 407750907 --once --force                     # 旧写法完全等价，仍可用
```

## 架构速记

- `cli.js`（入口）→ `lib/args.js`（参数）/ `lib/interactive.js`（交互向导）→ `lib/watcher.js` / `lib/monitor.js`（监控主流程）
- `lib/jsonout.js`：机器可读输出（`--json`）——stdout 只出 NDJSON，`console.log` 改道 stderr；`emit/pickComment/describeError`；`lib/caps.js`：能力清单（`node cli.js 能力`），从 FLAG_ALIASES/ACTIONS 派生，给 AI 自描述
- 根目录 `AGENTS.md`：AI 调用指南（NDJSON 契约 / 错误处置表 / 常见配方 / 禁止事项 / 程序内调用）
- `lib/help.js`：帮助文本内容模块（零依赖）——`HELP` 完整说明书（快速开始/动作词逐条说明/全部功能/参数逐条说明/环境变量/退出码/兼容表，约 258 行）+ `SHORT_HELP` 简洁帮助；`test/cli.test.js` 有「帮助必须覆盖 FLAG_ALIASES 全部写法与 ACTIONS 全部动作词」的防漂移断言
- `lib/args.js` 三层参数模型：中文动作词（`ACTIONS`：查看/监控/热评/出图/回顾/登录/帮助）+ 别名表（`FLAG_ALIASES`：中文名/英文名/旧名 → 规范名，`canonFlag` 归一化）+ `HELP`（示例先行）/ `SHORT_HELP`（缺目标时）
- `lib/api/`：`client`（节流/重试/风控分类）/ `wbi`（WBI 签名，密钥缓存）/ `ticket`（风控票据）/ `comment` / `dynamic` / `image`
- `lib/card/`：`text`（度量/分词/换行/禁则）/ `emoji`（Twemoji 内联）/ `layout` / `templates` / `constants`
- `test/`：node:test；`scripts/`：smoke / verify-pixels / export-svg / check-syntax
- `output/` 出图目录（已 gitignore）；`.codebuddy/plans/` 存历史计划

## 非显而易见的坑

- 交互向导要求真实 TTY（`stdin.isTTY && stdout.isTTY && !CI`）；「运行/调试」按钮或管道运行会静默降级为非交互
- 长驻（watch）时接管 SIGTERM（`_stopEmit` 每轮重置，菜单循环不会串场），停止时补 `end` 事件（reason=sigint/sigterm）
- 机器可读模式（`--json`）必须在 cli.js 顶部 prescan 并 enable（颜色在 ui 加载期计算、console.log 要尽早改道）；`result` 事件里 `type` 必须写在 `...res` 之后（`res.type` 是评论区类型会覆盖事件类型）
- 目标 `-` = 从标准输入读；单字母短选项区分大小写，长选项不区分
- 交互向导的两条人类逻辑：① UP 主只在「没填动态」时问（`needsUid`）；②「返回修改」跳到被模式跳过的段落时顺延到下一个可执行步骤（`resolveJump`）
- CLI 三种写法等价（别名表 + `canonFlag`）：长选项 ASCII 大小写不敏感（`--UP`==`--up`），单字母短选项区分大小写（`-i` 间隔 / `-I` 向导）；动作词缺目标 → `SHORT_HELP` + 退出码 1；裸参数仍是「动态/评论 ID」（历史语义，勿改）
- UP 空间链接（`space.bilibili.com/<UID>`）在 `--UP`、向导 UID 输入、`监控` 动作词里都会自动取 UID（`args.extractUid`）
- 匿名可用范围：`--oid` 直连置顶评论；`--uid` 自动识别 / 完整子回复 / `--up-top` 全账号检索需 SESSDATA
- 旧式动态 oid（如 t.bilibili.com/407750907 中的 407750907）本身即评论 oid；新式 19 位动态 ID 需经 `/x/polymer/web-dynamic/v1/detail` 换算 `basic.comment_id_str` 与 `comment_type`
- 置顶评论取评论接口同响应的 `data.data.top_replies[0]`；实测该接口的 `data.top.upper` / `data.top.admin` 可能为 null，不能作为取置顶的依据。动态评论 type=11（传 17 会 -404）
- 卡片换行含 CJK 禁则：收尾标点不落行首、开头标点不落行尾（宁超宽不断开，见 `lib/card/text.js` 的 `NO_LINE_START` / `NO_LINE_END`）
- 风控 -352/-509 → 指数退避；轮询间隔建议 ≥30s
- UP 身份一律走 `monitor.resolveUpMid()`：未显式 `--uid` 时 `cfg.uid` 是 `DEFAULT_UID` 兜底值（`uidDefaulted=true`），**不得当身份用**（否则 `--oid + --up-top` 静默 0 张卡、UP主徽标漏、互动图筛错人）；优先级 = 显式 `--uid` > 接口识别的 mid > 已保存 uid
- `state.json` 只按输出目录存放：显式 `--oid` 与 state 里的 `oid` 不一致时按首次运行处理（否则换目标会误判「取消置顶」、出别人的互动图并推假通知）；`--uid` 自动识别模式的 oid 变化是合法事件，不做隔离
- 通知订阅：`notifyEvents` 为 `null`/未指定 = 全订阅；显式空数组 = 不订阅任何事件（向导「全不选」即此语义）
- `--once` 失败（配置类 error / 拉取不可信）退出码为 1；watch 模式不置错、继续自愈重试
- 仓库操作惯例：默认只改文件、不碰 git；commit / publish 由用户手动把控

## 相关项目与同步记录

- `~/bilicard/hermes-bili-card`：Hermes Agent 侧的独立精简实现（匿名链路交叉验证用；WBI / 置顶结构 / 出图管线同源思路）
- 2026-10-02：自 hermes-bili-card 反向同步「CJK 禁则换行」→ `lib/card/text.js`（`wrapTokens` / `truncateTokensToLines`），补 3 个测试；全量 260 用例 / check / typecheck 全绿
- 2026-10-02：逻辑审计修复 7 处（UP 身份解析 `resolveUpMid` / state 目标隔离 / `--once` 退出码 / degraded 标记 / 通知事件空列表语义 / 汇总页登录判定 / 互动项去重），新增 `test/monitor.test.js`；全量 278 用例 / check（51 文件）/ typecheck 全绿
