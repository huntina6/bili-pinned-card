# 更新日志 Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.7.0] - 2026-10-02

### 新增
- **机器可读接口（给 AI / 脚本调用）**：新增 `--json`（`-j` / `--机器可读`）——stdout 只输出 NDJSON（`start` / `card` / `result` / `error` / `end` 五类行），人类可读日志全部改道 stderr、终端颜色关闭、动画帧不再写 stdout；新增 `--演练`（`--dry-run` / `--预演`）——只解析目标、拉取元数据并输出 `plan`（出几张卡、目标对不对），不渲染 PNG、不写 state.json；新增 `能力` 动作词（`--能力` / `--caps`）——输出能力清单 JSON（动作词、全部参数写法含旧名、取值方式、通知事件、四类卡片产物、退出码、环境变量），AI 无需解析中文帮助即可拼命令；目标支持 `-` 占位符从标准输入读（管道友好）；`error.kind`（auth/expired/risk/api/usage/other）与 `hint` 直接给出修复方向。另修正 AI 挂死风险：`--json` 或非交互环境下全账号热评不再弹确认，改为返回 `event: cancel` 并提示加 `--确认`。新增 `lib/jsonout.js`、`lib/caps.js` 与仓库根 `AGENTS.md`（AI 调用指南：契约、错误处置表、常见配方、禁止事项、程序内调用示例）。
- **`--帮助` 升级为完整说明书（新增 `lib/help.js`，258 行）**：此前帮助只有一行一条的参数清单，用户看不出「这条命令到底干了什么、会产出什么文件」。现按「示例先行 → 动作词逐条说明 → 全部功能 → 参数逐条说明 → 环境变量/文件/退出码 → 兼容表」组织：
  - **每条命令的逐步说明**：`查看`/`监控`/`热评`/`出图`/`回顾`/`登录`/`帮助` 各自「解析什么 → 请求什么 → 渲染什么 → 写出哪个文件 → 退出行为/退出码」，含 `监控` 的四种变化事件与退避策略、`热评` 的断点续传与全账号模式、`出图` 的评论链接一次填两个目标。
  - **支持的全部功能**：四类卡片与对应文件名/latest 副本、变化检测与 state.json、匿名 vs 登录能力对照、可粘贴的六种目标形态、内容规则、事件推送（5 事件 × 4 模板）、渲染与输出控制、风控与稳定性（节流/buvid/WBI/票据/退避）、日志与隐私、交互向导流程。
  - **参数逐条说明**（按目标/模式/卡片与输出/登录与运行/规则与推送分组）与**兼容写法总表**。
  - 新增防漂移测试：帮助必须覆盖 `FLAG_ALIASES` 的全部写法（含旧名与短选项）、`ACTIONS` 的全部动作词、`NOTIFY_EVENTS` 的全部事件与关键产物名，否则测试失败——以后加参数忘了写文档会直接红。
- **命令行全面重构：说中文就能用（旧写法全部保留，老脚本不用改）**。原来的 `--oid` / `--rpid` / `--uid` 是 B站 接口术语（oid=评论区对象 ID、rpid=评论 ID、type=评论区类型），用户看不懂；示例又全是裸数字（`--oid 404135596`），看不出这个数字从哪来、该填什么。现按 cli-guidelines（clig.dev 中文版：**人类优先 / 示例先行 / 优先标准标志名 / 以不破坏既有接口的方式演进**）重构为三层：
  - **中文动作词（一句话命令）**：`查看 <动态链接>` / `监控 <动态链接|UP空间链接> [间隔秒数]` / `热评 <动态链接> [高赞条数]` / `出图 <评论链接>` / `回顾 <评论链接>` / `登录` / `帮助`。动作词与参数顺序无关、显式参数优先；除「监控」外都是**跑一次就退出**；缺目标时打印简洁帮助并以 1 退出（不再静默去猜默认账号）。
  - **中文名 / 英文名 / 旧参数名三种写法完全等价**：`--动态/--dynamic/--oid`、`--评论/--comment/--rpid`、`--UP/--up/--uid`、`--间隔/--interval`、`--输出/--output/--out`、`--热评/--条数/--top/--up-top`、`--推送/--webhook/--notify-webhook`、`--回复/--replies/--show-replies`、`--追踪动态/--track-dynamic/--track-dyn` 等；长选项 ASCII 部分大小写不敏感（`--UP` == `--up`），短选项仍区分（`-i` 间隔 / `-I` 向导）。
  - **链接优先、随手可粘**：动态链接、评论分享链接、UP 空间链接（`space.bilibili.com/<UID>` 自动取 UID）都能直接用；`出图 "<评论分享链接>"` 会自动同时填好「评论」与「所属动态」；裸参数保持历史语义（裸数字 = 动态/评论 ID），`node cli.js "<动态链接>"` 依旧可用。
  - `--帮助` 重写为「**最常用示例 → 动作词 → 分组参数 → 兼容与退出码**」；新增简洁帮助 `SHORT_HELP`（参数不全时显示，符合 clig「默认帮助要短、示例先行」）。
  - 交互向导的 UID 输入同样接受空间链接；`出图`/`--评论` 缺动态时的报错改为直接给出两种补救写法。
  - 顺带修掉一个**静默吞参数**问题：未知选项（如 `-x`）此前会被当成裸 oid 一路传下去，现在直接报错退出并提示 `--帮助`。

### 修复
- **UP 身份被 DEFAULT_UID 兜底值顶掉（功能静默失效）**：未显式 `--uid` 时 `buildConfig` 会把 uid 兜底为 `DEFAULT_UID`（匿名自动识别置顶动态的默认账号），而 `lib/monitor.js` 把它直接当「UP 身份」用，压掉了接口识别出的真实 mid。后果：`--oid X --up-top`（README 首推用法）在非默认账号的动态上**静默产出 0 张卡**（日志只留「无 UP 一级评论，跳过」）；置顶卡「UP主」徽标漏显示；取消置顶/换新的互动回顾图按错误的人筛选，出「暂无 UP 互动」空图。现新增 `resolveUpMid()`：**显式 `--uid` > 接口识别（评论响应 `upper.mid` / 空间动态作者 mid）> 已保存 uid**，`DEFAULT_UID` 兜底值一律不作为身份（`buildConfig` 新增 `uidDefaulted` 标记）；`--context` 识别失败时明确报错而非静默猜人。
- **state.json 未按目标隔离（假事件 + 假推送）**：`state.json` 只按输出目录存放，换 `--oid` 后仍沿用上一条动态的 `lastRpid` → 「换目标」被误判成「换新 / 取消置顶」，为**别的动态**的旧评论出互动回顾图，并在配置了 `--notify-webhook` 时推送一条假的「置顶评论已取消」（`unpinned` 属默认订阅）。现记录所属 `oid`，与当前显式 `--oid` 不一致时按首次运行处理；`--uid` 自动识别模式不做隔离（oid 随置顶动态变化是合法事件，隔离会压掉「置顶动态被替换」）。
- **`--once` 失败却退出码 0**：配置类错误（`--rpid` 缺 `--oid`、`--up-top` 全账号未带 Cookie）此前只打印错误就跳出循环，退出码仍为 0，cron/脚本无法区分成功与失败。现置 `process.exitCode = 1` 并把结束语改为「单次检查未完成」；单次模式下「拉取结果不可信」（动态已删 `notfound` 等）同样算失败，watch 模式不置错、继续自愈重试。
- **通知事件「全不选」被当成全订阅**：`isSubscribed` 把空数组视为「未配置 → 全订阅」，与向导多选界面语义相反（用户以为不推送，实际全推）。现区分 **未指定（null）= 全订阅** 与 **显式空数组 = 不订阅任何事件**；`--notify-events ""` 亦为不订阅，向导「全不选」会就地提示。
- **回退成功仍报「被限流」假警告**：`getAllTopComments` 在 wbi 降级后回退老接口，`degraded` 用 `legacy.degraded || r.degraded` 合并，导致老接口已拉满（如 20/共 20 条）时仍打印「仅获取 20/共 20 条，结果不完整」。现只反映最终结果（legacy）的降级状态。
- **互动回顾图/热评卡重复渲染同一条评论**：UP 既回复又点赞某条粉丝评论时，该评论会以「被UP回复」和「被UP点赞」出现两次；现按父评论 rpid 去重（回复块已包含该评论）。
- **交互汇总页把「只有 SESSDATA 的 Cookie」判成游客**：展示用 `DedeUserID` 判断登录态，而能力门控用 `!!cookie`，同一份配置显示「游客 + 三条限制」却按已登录执行。现统一按 Cookie 判定（无 DedeUserID 时显示「已登录（Cookie 未含 DedeUserID）」）。
- **`--type` 未在帮助与文档中列出**：`parseArgs` 一直支持 `--type/-t`，但 `--help` 与 README 参数表都没有，且 `saved.type` 会跨目标沿用；现补进帮助与文档。
- **通知推送的静默失败（飞书 / 钉钉）**：这两个渠道在业务失败时**仍返回 HTTP 200**，错误只体现在响应体（飞书 `{"code":19024,"msg":"Key Words Not Found"}`、钉钉 `{"errcode":310000,"errmsg":"keywords not in content"}`）。此前仅检查 HTTP 状态，会把「关键词不匹配 / 签名错误 / 被限流」记成推送成功——用户以为通知已送达，实际没有。现新增 `checkChannelBody()` 按渠道解析响应体业务码（飞书 `code` 与老版 `StatusCode`、钉钉 `errcode`、Telegram `ok`），命中错误即返回 `ok: false` 并写入含具体错误码的 warn 日志。**保守策略**：`generic` 渠道、非 JSON 响应体、缺字段或字段类型不符时一律视为成功，不制造误报噪音。

### 优化
- **交互向导按人类逻辑重排（并补齐两处能力缺口）**：
  - **UP 主只在需要时问**：此前无论什么模式都先问「目标 UP 主 UID」（默认值还是内部兜底账号），指定评论出图、给了动态链接的热评/监测根本用不到它。现改为先问「动态目标」，只有**没给动态**时才追问 UP 主（新增纯函数 `needsUid`：游客/指定评论/已给动态一律不问）；UP 主提问不再预填 DEFAULT_UID 兜底值，并提示 UID 在空间页地址里的位置、支持直接粘空间链接。
  - **向导内可「先试跑」**：新增「先试跑一次（只报告会出什么，不出图、不改状态）」开关，等价命令行 `--演练`；汇总页会显示「试跑」一行。
  - **向导内可「详细日志」**：新增开关，等价 `-v`（只对本次运行生效，不写进配置）。
  - **「返回修改」不再选了没反应**：目标段落在当前模式下被跳过时（如热评模式没有「监控行为」段落），自动顺延到下一个可执行段落并说明原因（新增纯函数 `resolveJump`）。
  - **Webhook 地址校验**：非 http(s) 直接拦下并重问（此前写错只会在运行时静默失败、仅留一行日志）。
  - 游客模式选择时即清空本次 UID（原先靠「目标设置」步骤顺带清理，步骤改为按需提问后移到登录步骤，避免游客误用默认账号做 UP 身份筛选）。
  - 覆盖率：除脚本/AI 专用开关（`--静音` `--json` `--能力` `--免向导` `--确认` `--类型`）外，命令行能力均可在向导内配置（`--确认` 由运行时的动态条数询问代替，`--类型` 由链接自动推断）。
- **buvid 设备指纹持久化（风控关联维度）**：`anonCookie()` 由「纯内存」改为「内存 → `buvid.json`（30 天 TTL）→ SPI 网络请求」三级缓存。此前 `--watch` 长驻进程内复用一份指纹没有问题，但 **cron / `--once` 每次运行都是新进程、每次都重新调 SPI 取一对新的 `buvid3`/`buvid4`**——等于「每次来访都换一台设备」，恰是风控最典型的机器人特征，也抵消了扫码登录换来的干净设备身份。以 `*/1 * * * *` 为例，一天会产生 1440 个不同指纹，现降为 1 个；扫码登录（`login.js`）与后续轮询也因此共用同一设备身份。另新增网络失败时**降级复用过期指纹**（10 分钟冷却内不再重试 SPI），避免 SPI 不可用导致整轮 cron 直接失败。缓存目录遵循既有约定（`BILI_BUVID_DIR`，默认 `~/.bili-pinned-card`）。
- **日志消毒名单补全**：`buvid3` / `buvid4` / `bili_ticket` / `hexsign` 加入 `SENSITIVE_KEYS`。设备指纹现已持久化、属长期标识符；这四项当前只出现在 Cookie 或请求头里（本就不会进日志），纳入名单是为防止将来重构把它们挪进 query 时泄漏。属防守性加固。

### 测试
- 新增 `test/buvid.test.js`（9 用例：内存缓存、落盘 TTL、跨进程复用、过期重取、文件损坏回退、失败抛错、降级复用、降级冷却、并发去重）
- `test/notify.test.js` 补充 4 用例（飞书/钉钉/Telegram 业务码判定、保守策略不误报、HTTP 200 但业务失败不得记成成功、`errcode=0` 正常成功）
- 为 `test/login.test.js`、`test/wbi.test.js`、`test/resolve-oid.test.js` 增加 buvid 缓存目录隔离（临时目录）——否则测试夹具会写入真实 `~/.bili-pinned-card/buvid.json`，并使第二次运行因文件命中而少发一次 SPI 请求，产生「跑第二次才失败」的状态依赖
- `test/logger.test.js` 补充 1 用例（设备指纹 / 风控票据 / 请求签名打码）
- 用例数 243 → 257
- 交互向导补充：`test/interactive.test.js` +6（`needsUid` 判定表、`resolveJump` 顺延、Webhook 校验，以及 3 个**真实状态机驱动**的流程用例：游客+单次不问 UID 且可勾选试跑 / 已登录+监控留空动态才追问 UID / 已登录+指定评论不问 UID）；用例数 295 → 301
- 机器可读接口补充：`test/cli.test.js` +5（写法等价 / `-` 读标准输入 / 能力清单完整性 / jsonout 分类 / CLI 能力输出与 JSON 错误行）、`test/monitor.test.js` +2（`--演练` 不出图不写 state、热评演练计划）；用例数 288 → 295
- CLI 重构补充：`test/cli.test.js` +10 用例（三种写法等价 / 大小写与短选项 / 动作词与顺序无关 / 数量参数 / 缺目标简洁帮助 / 旧用法回归 / 未知参数报错 / **帮助完整性防漂移**）；用例数 278 → 288
- 逻辑审计补充：新增 `test/monitor.test.js`（8 用例：身份解析 / 目标隔离 / 换新回归），`test/watcher.test.js` +1（`--once` 退出码）、`test/notify.test.js` +2（空列表语义）、`test/cli.test.js` +3（事件语义 / `uidDefaulted`）、`test/api.test.js` +2（互动去重）、`test/interactive.test.js` +3（汇总页判定）；用例数 257 → 278（19 个测试文件）

## [1.6.0] - 2026-09-25

### 新增
- **内容规则 `--rule` / `--rule-mode`**：置顶监测模式下按关键字（子串、忽略大小写）或 `/正则/flags` 过滤，多条规则支持 `any`（任一命中，默认）/ `all`（全部命中）；仅命中的置顶评论（或普通动态正文）才出图与推送。未配置时恒命中，缺省行为与 1.5.0 完全一致。新增 `lib/rule.js`。
- **事件推送 `--notify-webhook`**：置顶变化 / 取消置顶 / 动态更新 / 热评卡完成 / 凭据失效（`-101`·`-658`）时 best-effort POST（8s 超时，失败仅记日志、不中断监测）；`--notify-format` 支持 generic / feishu / dingtalk / telegram，`--notify-events` 订阅事件子集，`--notify-chat-id`（Telegram）、`--notify-prefix` 可选。**默认关闭**。新增 `lib/notify.js`。
- 交互向导新增「内容规则」与「推送 Webhook」配置项（均可留空跳过），配置汇总显示规则与打码后的推送地址；推送步骤支持多选订阅事件（`--notify-events`）与标题前缀。
- **`--interactive` / `-I`**：即使已提供 `--oid` / `--cookie` 也强制进入交互向导（默认仅在缺少必要参数时进入），便于在已有参数基础上微调。
- **`--up-top` 可省略 N**：不带数字时沿用上次交互保存的 TOP 值（无记录则 10）。

### 优化
- **卡片渲染层去重**：`lib/card/` 新增 `svgShell` / `renderSectionHeader` / `renderItemList` / `pictureBlock` / `renderReplyRow` / `saveCard` 等公共原语，四类模板共用；硬编码坐标/字号收敛为 `constants.js` 常量（修正少量硬编码字号，视觉差异在 1-2px 内）。
- **monitor 主流程拆分**：`checkOnce` 改为模式分派器，`runUpTopMode` / `runRpidMode` / `runMonitorOnce` 三个独立流程；`generateUnpinnedIfPossible` 与 `--context` 共用 `fetchInteractionItems` 互动拉取链路。
- **工程化**：`npm run check` 改为 `scripts/check-syntax.js` 遍历 `cli.js`/`lib`/`test`/`scripts` 下全部 `.js`（取代手写文件清单，新增文件自动纳入）。
- 通知推送统一由 `lib/watcher.js` 在 `checkOnce` 结果处单点分发（覆盖全部事件与错误分支）。
- **交互向导重构（零依赖步骤机）**：`lib/interactive.js` 改为 `STEPS` 步骤表 + 每轮独立 `draft` 快照驱动，登录/模式选项键统一为数字；`MODES` 常量表取代 `mode === '3'` 这类字符串硬编码，移除 uid/upTop 防残留补丁。每步支持「返回上一步」，链接解析失败可就地重填（不再整轮退出）；汇总页提前到落盘之前，提供「开始运行 / 仅保存不运行 / 返回修改 / 清空已保存配置 / 放弃」；`cli.js` 的「运行结束再运行一次」并入同一向导会话，消除跨轮状态残留。

### 测试
- 新增 `test/rule.test.js`（规则解析/组合/边界）、`test/notify.test.js`（事件映射/模板/订阅/本地回环 HTTP 推送）、`test/interactive.test.js`（向导进入条件、`MODES` 键位双射、draft 隔离/上限、步骤跳转表、输入「返回上一步」语义、多选交互、`persistDraft` 落盘字段与不落盘字段）；`test/card.test.js` 补充 SVG 外壳一致性、区块顺序与徽标、空态、互动链截断、图片网格排布、`saveCard` 命名与 latest 落盘等结构断言；`test/cli.test.js` 补充规则与推送参数解析。用例数 189 → 243。

## [1.5.0] - 2026-09-18

### 修复
- **opus 动态评论 oid 取错（P0）**：动态条目自带权威字段 `basic.comment_id_str/comment_type`，而 `extractReplyParams` 仅按 `major.type` 推断——`MAJOR_TYPE_OPUS` 未覆盖时回退为动态 ID（实测 `id_str=1232243387332034584` vs `comment_id_str=404135596`），导致 opus 动态拉空评论区/取不到置顶卡。现优先取 `basic`，`major` 推断降为回退。
- **最新动态误取置顶项（P0）**：`getPinnedDynamic` 用 `items[0]` 作为「最新动态」，但置顶条目固定排在首位——`--track-dyn` 普通动态更新监测因此不会触发（`latestId` 恒等于置顶 ID）。现改为取第一条未标记「置顶」的条目。
- **opus 动态更新卡片无内容**：`extractDynamicContent` 补充 `MAJOR_TYPE_OPUS`（summary 正文 + pics 图片）。
- `getAllSubReplies` 页数上限统一为 `MAX_SUB_PAGES=10`（互动回顾图/取消置顶此前写死 5 页 ≈ 100 条，与 up-top 的 10 页不一致，可能漏 UP 互动）。
- **交互选择器 Ctrl+C 卡死（P0）**：raw 模式下 readline 无 `SIGINT` 监听时会自行 `close()`（Node 源码 `readline/interface.js`），而选择器仍等待按键 → 向导挂起、终端停留 raw。现统一支持 Ctrl+C / Ctrl+D / Esc 取消并优雅退出（先恢复光标与 raw、再退出，退出码 130）；键解析兼容 CSI（`\x1b[A`）/SS3（`\x1bOA`）方向键与分块 ESC 序列（单独 Esc 50ms 判定，参考 clack `escapeCodeTimeout`）。
- **超长卡片内存/耗时风险（实测压测）**：新增卡片逻辑高度预算 `MAX_CARD_H=12000`——UP 热评/互动回顾/精彩回复/动态正文超限即截断并显示「…还有 N 条未展示」。实测 60 块（12,750 逻辑高）2x 渲染 2.7s、RSS +261MB；按原 `MAX_ITEMS_SAFE=200` 外推约 85,000px 高、RSS ≈0.9GB。
- **默认输出目录跟随项目**：`--out` 未指定时，默认从「当前工作目录/output」改为「项目目录（cli.js 所在目录）/output」，切换运行目录/移动项目后不再写错位置；向导仅在用户自定义时持久化 `outDir`（新增 `outDirCustom` 标记），旧配置中遗留的 `<任意目录>/output` 默认值自动迁移，显式 `--out` 始终最高优先。

### 新增
- **bili_ticket 风控票据（best-effort）**：请求遇 `-352` 且非 `v_voucher` 验证码风控时，自动向 `GenWebTicket`（POST + HMAC-SHA256 签名）申请约 3 天有效票据并附加 Cookie 重试 1 次；内存+文件（`~/.bili-pinned-card/ticket.json`）缓存。新增 `lib/api/ticket.js`。
- **网络瞬时故障自动重试**：`httpJson` 对 fetch 超时/连接重置重试 1 次（1s 间隔）。
- **UP 热评卡断点续传**：`--up-top` 出卡前检查同名文件（`up-top_<时间>_<rpid>.png`），已存在则跳过（`--force` 可重出）；全账号长跑中断后重跑不再重复拉子回复/重复出图。
- **`-V, --version`**：显示版本号；版本号改为读取 `package.json`（单一来源）。
- **v_voucher 诊断**：识别验证码风控（`-352` + `data.v_voucher`），日志/错误提示明确区分「限流」与「需验证码冷却」。
- **图床缩略图**：新增 `imgVariant()` 按显示尺寸请求 B站 CDN 变体（实测头像 65KB→`@80w_80h_1c.jpg` 1.8KB，配图 `@640w.jpg`），显著降低下载量、内存与 SVG base64 体积；已带 `@` 参数的 URL 仅做 webp→jpg 替换。
- **Unicode emoji 彩色化**：新增 `lib/card/emoji.js`——grapheme 切分 → Twemoji 内联 PNG（复用表情 token 管线）；CDN 失败一次即进程级熔断回退文本；`--no-emoji` 关闭、`BILI_EMOJI_CDN` 可换源。
- **自定义分辨率**：新增 `--width <像素>`（340~4080，优先于 `--scale`）与 `--scale <倍率>`（0.5~6，支持 `1.5` 等小数）；交互向导「卡片与输出」新增分辨率选择（1x/2x/3x/自定义宽度），汇总显示输出像素；高度预算随倍率自动收紧（`maxCardHForScale`，像素预算与 2x/12000 逻辑高相当），高分辨率不再有内存暴涨风险。

### 优化
- **少一次请求**：UP 热评卡从空间动态作者 `mid`、评论响应 `upper.mid` 复用 UP 身份，仅在都缺失时才单独请求识别；`feed/space` 补 `features`/`web_location` 标准参数。
- **交互输入校验与易用性**：UID 必须纯数字、间隔 ≥10、TOP N 1-50，非法输入就地报错并重问（原先 UID 完全未校验、其余静默取默认）；输出目录支持 `~` 展开；选择器支持数字键直达并显示编号（`1)`/`2)`…）；选择期间隐藏光标；新增 `--no-input`（TTY 下显式禁用向导，符合 clig.dev 建议）。
- **交互模式登录状态前置 + 功能门控**：向导第一步改为「登录状态」选择（已登录/重新扫码/游客），并据此展示能力边界与门控流程——游客跳过 UID、强制填写动态链接，不可用 UID 自动识别 / 全账号热评 / 完整子回复（仅第一页 20 条）；扫码失败自动降级为游客并提示。`getPinnedComment` 同响应返回 `upperMid`，游客模式下置顶卡片的「UP主」徽标仍正确。
- **风控自适应退避**：watch 模式连续失败按 `interval × 2^(n-1)` 退避（上限 10 分钟、±20% 抖动），风控/签名/登录态/网络错误均适用，成功后自动复位并提示；对应录播机社区 412 处置实践（调大间隔、增加等待、避免规律性）。
- **浏览器风格请求头**：`httpJson` 补 `Accept-Language` 与 `Sec-Fetch-*`，`api.bilibili.com` 请求附 `Origin: https://www.bilibili.com`，进一步降低脚本特征。
- **进程内缓存**：`getDynamicUpper` 按 oid 缓存（上限 100），减少游客/指定动态场景的重复请求。
- **交互向导与命令模式全量对齐**：补齐 `--force`（强制重出图）、`--max-dyns`（全账号检索限额）、`--no-emoji`（彩色 emoji 开关）、手动粘贴 Cookie（无扫码环境备用），并新增「指定评论出图」模式（`--rpid`，可选 `--context` UP 互动回顾），向导现已覆盖除 `--no-input`/`--yes`/`-q`/`-v`（交互场景无意义）外的全部可用参数。
- **交互体验升级（借鉴 clack/ora/inquirer 的零依赖实现）**：① 网络等待加 `startSpinner` 加载动画（动态链接解析等）；② Cookie 输入改为掩码（`askSecret`，不回显原文、支持退格，Esc/Ctrl+C 取消）；③ UP 热评批量出图加 `[i/N]` 进度前缀；④ 单次/热评/指定评论完成后可「返回配置菜单再运行」（REPL 循环，watch 模式不受影响）。
- `classifyError` 改用 `RISK_CODES` 常量（消除重复码值清单）。
- `--max-dyns` 非法值（非数字/0/负数）回退默认不限制。
- **出图性能**：表情/互动链图片下载并发化（`prepareNode` 节点去重，配图与尺寸解析共用一次变体计算）；`downloadImage` 网络/非 2xx 重试 1 次；`fitSinglePic` 不再放大原图（小图保持原始宽度）。

### 测试
- 新增 `test/ticket.test.js`（7 用例：签名固定向量、内存/文件缓存、失败抛错、`-352` 重试链路、v_voucher 不重试、网络重试）
- 新增 `test/ui.test.js`（15 用例：方向键/SS3/数字快捷键、Esc 50ms 判定、Ctrl+C/Ctrl+D 与 SIGINT 取消哨兵、校验重问、`~` 展开、登录/游客能力矩阵）
- 新增 `test/emoji.test.js`（8 用例：grapheme/文件名映射/熔断/分词与回退渲染）
- `test/api.test.js` 扩充 `imgVariant` 缩略图、`extractReplyParams`（basic 优先/回退/非法 type）与 OPUS 动态内容
- `test/image.test.js` 扩充 `fitSinglePic` 不放大与下载重试次数守护
- `test/cli.test.js` 扩充 `--version`/`--max-dyns`/`--scale`（小数）/`--width`/`--no-emoji`/输出目录迁移守护
- `test/card.test.js` 扩充高度预算截断、自定义倍率输出像素、`maxCardHForScale` 换算守护
- `test/ui.test.js` 扩充输出宽度校验
- `test/ui.test.js` 扩充掩码输入（`askSecret` 掩码/退格/取消）与 `startSpinner` 守护
- `test/watcher.test.js` 扩充 `computeBackoffMs`（指数/封顶/抖动边界）
- `test/throttle.test.js` 扩充浏览器风格请求头守护（api 域带 Origin、passport 不带）
- `test/resolve-oid.test.js` 扩充 opus `basic` 解析、`getPinnedDynamic` latest 修复、`getAllDynamics` authorMid、`getPinnedComment.upperMid`、`getDynamicUpper` 进程内缓存
- 测试用例总数 **124 → 189**；`npm run check` 清单补入 `lib/api/ticket.js`、`lib/card/emoji.js`、`test/ticket.test.js`、`test/ui.test.js`、`test/emoji.test.js`

## [1.4.1] - 2026-09-10

### 修复
- **输入行为一致性（P1）**：`resolveCommentOid` 此前对**裸动态 ID 数字**直接透传（不做 oid 转换），而链接输入会查详情转换——导致同一条动态用链接输 vs 用裸数字输结果不一致（评论 oid ≠ 动态 ID，会拉到空评论区且**不报错**，静默出 0 张卡）。
  - 新增 `isBareDynamicId()`：按 **length 15~19 位**区分动态 ID 与评论 oid（评论 oid 为 9-12 位；20 位 App 新 ID 超 int64 不尝试转换）
  - 裸数字与链接走**同一条**转换路径；转换失败（-400 / 风控 / 无 item）时**安全回退透传**，保证 `--oid 404135596` 等既有用法零影响（评论 oid 输入仍**零请求**透传）
- **置顶评论 null 归因（P1）**：`getPinnedComment` 对「确实没有置顶评论」与「拉取失败/对象已删除」都返回 `null`，`monitor` 一律判为「已取消置顶」→ 出无意义的空回顾图，并把 `state.json` 的 `lastRpid` 清空（状态污染，下次真变化无法检测）。
  - `getPinnedComment` 新增可选 `{ withReason: true }`，返回 `{ comment, reason }`：`ok` / `none` / `empty`（可判定取消置顶）、`notfound`（-404 动态已删）、风控 `-352/-412` **改为抛出**而非静默
  - `monitor` 按归因分流：非「真取消置顶」时**不出图、不写 state**，并输出明确的跳过提示（`state 已保留，未污染`）
  - 修正 `rpidChanged` 在 `comment === null` 时的误判（空值哨兵比较），避免置顶空窗期每次都误判为「变化」
- **死代码修复**：`resolveCommentOid` 的 -400 友好错误判断原用 `/^-400/.test(err.message)`，而 `apiGet` 抛出的 message 形如 `API code=-400: ...`，该分支**永不命中**（用户始终看到裸 API 错误）。改用 `err.code === -400` 数值判断。
- **`-403` 未归类（P1）**：`-403`（WBI 签名缺失/错误或权限不足）此前落入「其他错误」分支，用户只见裸报错、无处置指引。
  - 2026-09-10 实测确认：无签名请求 `/x/v2/reply/wbi/main` 返回 `-403 访问权限不足`
  - 统一收敛到 `RISK_CODES = [-352, -403, -412, -509, -799]`（`lib/api/client.js` 导出），`httpJson` 记录 warn 日志、`apiGet` 抛出同类 `BiliError`
  - `classifyError` 新增 `risk` 覆盖 `-403/-509`，并新增 `expired`（`-658` Token 过期）；`runWatcher` 为 `-403` 给出**签名类专属提示**（刷新 Cookie / 检查系统时间），而非误导性的「请求过于频繁」
- **`-658` Token 过期未处理**：新增 `expired` 分类与独立提示（引导重新 `--login`），并在 `apiGet` 抛出可识别错误
- **交互模式链接解析失败静默继续（P1）**：`runInteractive` 中 `resolveCommentOid` 抛错后仅打印日志、不阻断，`cfg.oid` 会**静默保留上一次的旧值** → 用户以为在监控新目标，实际监控的是旧目标。改为**明确中止运行**（关闭 readline + 退出），提示重新执行。
- **legacy 分页终止条件**：原仅凭 `replies.length < 20` 判终止，在「服务端单页截断但总量未拉完」时会提前退出（漏评论）。改为「本页不足 20 条 **或** 累计达 `page.count` 权威总量」双条件，并保留短页兜底（避免 opus 降级场景下按巨大 count 空转翻页、徒增风控风险）。

### 测试
- 新增 `test/resolve-oid.test.js`（19 用例）：覆盖裸数字/链接一致性、评论 oid 零请求透传、转换失败安全回退、链接失败仍抛错、`getPinnedComment` 五种 `reason` 归因、旧签名向后兼容
- `test/watcher.test.js` 扩充：`-403`/`-509` → `risk`、`-658` → `expired`、`RISK_CODES` 与 `classifyError` 一致性校验
- `test/wbi.test.js` 扩充：legacy 分页「短页立即停止（不空转）」与「满页继续翻页至 `count`」两个守护用例
- 测试用例总数 **99 → 124**；`npm run check` 清单补入 `test/resolve-oid.test.js`

## [1.4.0] - 2026-09-10

### 新增
- **启动与加载优化**：`@resvg/resvg-js` 惰性加载（`--help`/`--login`/交互配置阶段不再加载原生二进制）；`enableCompileCache` 启用 Node ≥ 22.8 编译缓存（旧版静默跳过，仅直接运行 cli.js 时生效）
- **请求节流升级**：均匀随机 → 正态分布（Box-Muller）+ 按 URL 自动分档——子回复翻页均值 2s / 评论列表 1.5s / 动态检索 3s（最保守），降低风控触发概率；`setRng` 可注入（测试）
- **WBI 密钥文件缓存**：内存 1h + 文件 12h（`~/.bili-pinned-card/wbi.json`）跨进程复用，减少 nav 请求暴露；文件丢失/损坏/过期自动回退
- **冒烟测试** `npm run smoke`：真实网络「拉评论 → 渲染 → 出 PNG」全链路（输出到临时目录，不污染 output/）
- **JSDoc 类型检查**：`npm run typecheck`（tsc --noEmit 零错误）；`types.d.ts` 定义 CliConfig 等全局类型；devDependencies 仅工具链（typescript/@types/node/@types/qrcode），运行时依赖零新增
- **可维护性重构**：cli.js 拆分 423 → 92 行——`lib/args.js`（参数解析/配置构建）、`lib/interactive.js`（交互引导 + 扫码登录）、`lib/watcher.js`（监控循环 + 错误分类 `classifyError`）

### 变更
- 配置与状态持久化改为**原子写**（临时文件 + rename，Windows 回退 + 直写兜底）：断电/崩溃不再产生半截文件
- CI 升级三平台矩阵：ubuntu × Node 18/20/22 + windows/macos × Node 22（验证 resvg 预编译二进制跨平台）；新增 typecheck 步骤
- `-799`（请求过频）与 -352/-412 同档风控提示
- 图片下载失败 URL 记入日志（去重防刷屏），便于排查

## [1.3.0] - 2026-09-09

### 新增
- **运行日志落盘**（`~/.bili-pinned-card/logs/YYYY-MM-DD.log`，按天滚动保留 30 天）：
  - 业务事件（info，默认）：启动命令/出卡/置顶变化/风控警告——`-q` 静默模式终端不显示但文件照记
  - 请求摘要（debug，需 `-v` 或 `BILI_LOG_LEVEL=debug`）：每次 API 请求的 URL 路径/HTTP 状态/业务码/耗时
  - 错误分级（warn/error）：风控拦截、网络异常、Cookie 失效、致命错误
- **安全设计**：Cookie/ticket/qrcode_key 等凭据参数一律 `***` 打码，超长值截断；URL 非法时整体打码；ANSI 颜色在文件层剥离；写盘失败静默不影响主流程
- 新模块 `lib/logger.js`（零依赖同步追加）+ `test/logger.test.js`（6 用例，临时目录隔离）；CLI 启动时提示日志位置与 `-v` 用法

## [1.2.9] - 2026-09-09

### 新增
- **全局请求节流**：业务 API 每次调用前置 `1s + 0~1s 随机` 延迟（总计 ≤2s），规避 B站 频率风控（-352/-412）；登录轮询/SPI/签名密钥等自有节奏请求自动跳过；测试环境可 `setThrottle(false)` 关闭

### 修复
- **风控提示按场景区分**：`-101` Cookie 失效 → 提示 `--login` 重扫；已带 Cookie 的 `-352/-412` → 提示频率限流冷却重试（原文案一律建议"提供 Cookie"，对已登录用户是误导）；匿名 `-352` → 建议扫码登录或指定 `--oid`
- 实测诊断：`feed/space` 全账号动态检索被接口级封禁（-412 banned）时，评论 `wbi/main` 接口不受影响（60 条/8809 正常）——冷却恢复后仅影响 `--uid` 无 `--oid` 的全账号检索场景

## [1.2.8] - 2026-09-09

### 变更
- 卡片文件名时间戳统一为内容发布时间（置顶卡/互动回顾图取评论 ctime，动态卡取动态发布时间，异常时兜底生成时间）；up-top 卡此前已是评论时间
- **交互模式统一设计语言**：`❯` 仅在「当前提问行」出现一次——是/否选择器（selectYN）选中项改以加粗粉色高亮，不再叠加第二个游标符；ask/select/selectYN 三组件视觉一致
- **交互向导接入 UP 热评 TOP 卡**：运行模式新增第三项，可选高赞区条数（默认 10，上限 50）；热评模式自动跳过无关询问（间隔/动态监测/精彩回复），动态目标提示随模式变化，非热评模式强制清零 upTop（防残留误入热评分支）
- 配置完成摘要新增「登录」行（登录 UID / 匿名），模式行覆盖热评模式；启动横幅副标改「零浏览器依赖 · 扫码登录可选」
- 交互 Cookie 输入改为登录方式选择：已登录「沿用已保存（显示 UID）/ 扫码刷新 / 匿名清除」，未登录「匿名 / 扫码（推荐）」；扫码流程抽取 `qrLogin()` 供 `--login` 与交互模式共用
- 交互游标统一为 `❯`（ask/selectYN 原用 `➤`，与 select 列表不一致）

## [1.2.7] - 2026-09-09

### 修复
- **普通命令未显式 `--up-top` 时不再默认进入 UP 热评模式**（P0）：`buildConfig` 旧逻辑 `saved.upTop ?? 10` 导致旧配置缺少 `upTop` 字段时默认 10，`checkOnce` 的 `if (cfg.upTop)` 恒真，置顶监控/交互模式/`--rpid` 出卡等普通命令全部误入热评分支；现改为默认关闭（0），仅 `--up-top [N]` 或已保存 `upTop` 才启用
- 配置构建抽取为可测试的 `buildConfig(args, saved)`，`cli.js` 增加 `require.main === module` 守卫并导出 `{ parseArgs, buildConfig }`；新增 `test/cli.test.js`（5 用例）
- `getAllSubReplies` 失败重试节流统一：任一页失败均间隔 1s 重试（此前仅首页有间隔）
- `getReplies` 补 `web_location=333.788`（与全量子回复接口参数一致，防 B站 收紧单页限制）
- `getAllTopComments` 回退老接口时返回 `fallback: true` 标记，CLI 输出提示（此前 wbi 异常回退完全静默）
- 卡片渲染：`<image href>` 属性值统一走 `esc()` 转义（表情图 data URI）
- 文件头版本注释同步（cli.js 曾残留 v1.2.3 字样）

### 测试
- 新增 `test/cli.test.js`（5 用例：upTop 默认关闭回归 / 显式参数 / 0 关闭 / 保存配置保留），总数 67 → 72
- `test/wbi.test.js` 降级回退用例补充 `fallback` 断言

## [1.2.6] - 2026-09-02

### 修复（评论接口降级：老接口对 opus 评论区仅返回 3 条）
- 新增 `lib/api/wbi.js`：WBI 签名（nav 取 img_key/sub_key → MIXIN_TAB 混淆 → wts + md5），mixinKey 缓存 1h
- `getAllTopComments` 升级：**优先 `/x/v2/reply/wbi/main` + `pagination_str` 游标翻页**（mode=3 热门排序，0.5s/页节流），失败或被降级时自动回退老接口；返回 `{ replies, total, degraded }` 结构
- 降级检测：`replies < 5 && all_count > 100` → degraded，CLI 输出 ⚠ 提示（建议 `--login` 刷新 Cookie）
- `getAllSubReplies` 补 `web_location=333.788`（缺失时无法翻页，实测只返回第一页）+ 单页失败重试
- up-top 分支子回复页数 5 → 10（覆盖 168 条高互动楼中楼）
- 实测效果：opus 动态一级评论 3 → **197 条**（总量 8809），UP 热评卡 3 → **49 张**

### 测试
- 新增 `test/wbi.test.js`（10 用例）：getMixinKey 固定向量（公开校验值 `ea1db124af3c7062474693fa704f4ff8`）/ wbiQuery 排序与 md5 / pagination_str / isDegraded / getWbiKey 缓存 / wbi 游标翻页 / 降级回退 / -352 回退 / 子回复参数与重试，总数 57 → 67

## [1.2.5] - 2026-09-02

### 新增
- **扫码登录 `--login`**：终端渲染二维码（Unicode 半块字符，纯 HTTP 调用 B站 passport 接口，零浏览器依赖），手机 B站 App 扫码后自动轮询并保存 Cookie 至 config.json，nav 验证显示账号昵称/UID。参考整合 huntina6/bilibili-login 的接口与 UX
- 新增 `lib/login.js` 模块：`generateQr` / `renderQrTerminal`（█▀▄ 半块渲染）/ `pollLogin`（2.5s 轮询，超时重扫提示）/ `collectDeviceCookies`（spi 设备指纹）/ `verifyLogin` / `loginFlow`；支持 2026 新版 poll 响应结构（真实状态在内层 `data.code`：86101 未扫码 / 86090 待确认 / 86038 已失效）
- 新依赖：`qrcode`（纯 JS QR 编码器，无浏览器）
- 配置 Cookie 更新为新的有效 SESSDATA（旧 Cookie 被 B站 风控标记导致评论接口降级——实测旧 Cookie 评论接口仅返回 3 条，新 Cookie 解锁全量 8809 条）

### 测试
- 新增 `test/login.test.js`（11 用例）：状态码映射（2026 新语义）/ 回调 URL Cookie 提取（含编码）/ 失败重试 / poll 全流程与超时 / 终端渲染行数与超宽回退 / loginFlow 端到端（mock fetch 零网络），总数 46 → 57

## [1.2.4] - 2026-09-02

### 新增
- 动态短链支持：新增 `isDynamicLink`，`resolveCommentOid` 对 `t.bilibili.com/<dynId>` 与 `bilibili.com/dynamic/<dynId>` 链接自动查动态详情并转换为评论区 oid/type（此前仅 opus 链接转换，短链会拿 dynId 当 oid 导致 -400）
- 无效动态链接友好提示：链接中的 ID 超出 B站 接口可解析范围（如 20 位超 int64 的 App 新 ID 段）时给出明确错误说明（提示重新复制链接）而非裸 API 错误码

### 测试
- `test/api.test.js` 新增 `isDynamicLink` 判定用例（t.bilibili.com 短链 / bilibili.com/dynamic / opus 与视频链接反例），总数 45 → 46

## [1.2.3] - 2026-09-02

### 新增
- `extractId` 支持 B站 新版 **Opus 动态链接**（`bilibili.com/opus/<dynId>`）提取动态 ID
- 新增 `resolveCommentOid`：`--oid` 传 Opus 链接时自动查动态详情接口并转换为评论区 oid/type（dynId ≠ oid，如图文动态需用 draw.id）；命令行与交互模式均生效，交互模式解析失败提示后继续
- 新增 `isOpusLink` 判定函数；版本号对齐至 1.2.3

### 重构（全面模块化拆分，行为不变）
- `lib/api.js` → `lib/api/`：client（请求层）/ util（ID 解析）/ image（图片）/ dynamic（动态）/ comment（评论），原文件保留为聚合出口（re-export），现有引用零改动
- `lib/card.js` → `lib/card/`：constants（设计常量）/ text（文本工具）/ image（图片预处理）/ layout（布局原语）/ templates（四类卡模板），原文件保留为聚合出口
- `cli.js` 瘦身：终端交互抽 `lib/ui.js`（颜色/日志/横幅/ask/选择器，rl 经 attach 注入）、配置与状态持久化抽 `lib/state.js`
- 核心检查 `checkOnce` 原样搬移至 `lib/monitor.js`（零行为变化，cfg/st/log 经 ui/state 共享）
- `parsePng` 去重抽 `lib/png.js`（scripts/verify-pixels.js 与测试共用）
- 测试拆分：`test/api.test.js`（API 域 26 用例）+ `test/card.test.js`（渲染域 19 用例）；`npm run check` 清单同步更新

### 修复（拆分回归测试发现）
- `lib/card/templates.js` 补齐 3 个漏导入的常量：`W_NAME_S`（置顶卡精彩回复区作者字重，缺失导致置顶卡渲染报 `W_NAME_S is not defined`）、`CARD_RX`、`LINE_H`（UP 热评卡圆角与行高，缺失会导致 up-top 卡渲染失败）——单文件拆分时 require 清单未跟上使用面，单元测试未覆盖含回复的完整渲染路径

## [1.2.2] - 2026-09-02

### 优化
- 卡片布局对齐 B站 Opus 评论区实测布局（ego-browser 采集，正文 15px / 头像 40×40 / 80px 缩进节奏 20+40+20 / 顶部内边距 22px）：主卡与动态卡头像 46→40px、正文字号 15.5→15px、作者行/时间行坐标同步
- 字体栈：4 个 build 函数根 `<svg>` 统一挂 B站 风格完整字体栈（PingFang SC / Microsoft YaHei / 微软雅黑双别名 / Hiragino Sans GB 等 + 兜底），浏览器打开导出 SVG 亦生效
- 字重对齐 B站：正文 500（lineToSvg）、回复/互动链作者 600→500；标题/主作者保持 700
- 配色：`TEXT_DIMMER` #6f6890 → #8a84a8（贴近 B站 #9499A0 亮度，时间/赞可读性提升）
- 字号去魔法数：TITLE_FS/BODY_FS/AUTHOR_FS/TIME_FS/META_FS/SECTION_FS/REPLY_FS/ROLE_FS 等常量规范化（值不变）

## [1.2.1] - 2026-09-02

### 修复
- 部分粉丝头像空白：B站 头像 URL 有 `.webp` 格式，而 resvg-js 不支持 WebP 解码（静默渲染为背景色）→ 下载层对 `.webp` URL 追加 `@1e_1c.jpg` 参数强制服务端转 jpeg（零依赖，一处修复覆盖头像/评论图/表情全链路）

## [1.2.0] - 2026-09-02

### 新增
- `--up-top [N]`：UP 热评 TOP 卡（默认 N=10），每条 UP 一级评论出一张卡
  - 区域一「UP回复上下文」：子回复中 UP 回复对话对（被回复粉丝评论 + UP 回复）与仅被 UP 点赞未回复的评论，按时间全量排列
  - 区域二「高赞回复 TOP N」：仅粉丝（非 UP）回复按评论区点赞降序
  - 文件名用该 UP 评论的发布时间（`up-top_<评论时间yyyyMMddHHmmss>_<rpid>.png`）
- 模式 B：`--up-top --uid <UID>` 自动分页检索账号全部动态（`getAllDynamics`），先列出总数询问确认（防误触），非交互需 `--yes`；`--max-dyns <N>` 限制处理条数；动态间 1s 延时防风控
- `--up-top` 单条动态失败/单条评论失败自动降级跳过，不中断整体
- 正文渲染行数上限（MAX_LINES=6）与互动全量安全上限（MAX_ITEMS_SAFE=200），防超长 SVG

## [1.1.2] - 2026-08-16

### 增强
- 置顶评论未变化时完整输出评论正文（不再截断 30 字）：≤120 字单行显示，超长正文换行展示，便于核对完整内容

## [1.1.1] - 2026-08-16

### 修复（2026-08-16 代码审查后）
- 修复 `--rpid` 传评论分享链接提取错误（extractId 先匹配动态 ID 导致拿到 oid）→ 评论 ID 优先匹配；extractId 移至 lib/api.js 并补 3 个回归测试
- 修复交互模式 BANNER 打印两次
- 修复 `_dynFile` 临时字段写入 state.json 污染状态文件
- 修复 `--context` 自动识别 UP 失败时静默兜底到默认 UID（会筛选错人）→ 明确报错并提示 `--uid`
- 修复图片缓存无界增长 → 双缓存改有界 LRU（上限 200）
- 修复动态更新卡片单图仍固定 320×240 裁剪 → 与主卡片一致按原图比例展开
- 修复互动回顾图互动条数无上限（超长 SVG）→ 截断至 30 条并提示
- `getAllSubReplies` 分页 ps=50 → ps=20（与 B站实际每页上限一致）
- 删除死代码 askSilent/maskCookie（askSilent 曾污染全局属性 process._silentBuf）
- 配置写入后 POSIX 平台 chmod 600（含 Cookie 的 config.json 防同机读取）
- `--uid`/`--oid` 等带值参数缺值时报错退出；`--uid` 非纯数字报错退出
- 所有 SVG `<image href>` 统一 esc() 转义
- verify-pixels.js 布局常量改从 lib/card.js 导出复用（消除硬编码漂移）
- anonCookie 并发首调去重（in-flight Promise 复用）

## [1.1.0] - 2026-08-13

### 新增
- `--rpid <评论ID或链接>`：按评论 ID 直接绘制置顶样式卡片（旧置顶评论等），支持粘贴 `t.bilibili.com` 分享链接自动提取 ID
- `--context`：与 `--rpid` 联用，生成该评论的 UP 互动回顾图（UP 回复/点赞对话链）
- `--context` 自动识别动态 UP（评论接口 `upper` 字段），无需手动指定 UID
- Cookie 保存到 `~/.bili-pinned-card/config.json` 后运行时自动加载，无需每次传 `--cookie`
- `scripts/export-svg.js`：导出卡片 SVG 源码，供设计/视觉模型参考
- 互动回顾图：互动链评论的自带图片补全渲染（单图按比例、多图 3 列）

### 修复
- 卡片图片按原图比例完整展开：解析图片实际尺寸（JPEG/PNG/WebP），竖图/长图不再被 320×240 `slice` 裁剪
- 互动回顾图/回复区：日期（时间 · 赞）与正文重叠（多行正文时元信息行高不足）→ 块高度 +22px
- 页脚同步显示动态完整链接（UP互动回顾图 / 动态更新卡片），与置顶评论卡片一致
### 修复（2026-08-15 同步）
- 修复 UP 互动识别失效（B站 API mid 为数字、CLI uid 为字符串，严格比较恒 false）→ 互动回顾图/UP 标识恢复正常
- 修复主卡片无条件显示「UP主」徽标（粉丝评论误标）→ 按评论作者是否为目标 UP 条件显示
- 修复交互模式粘贴 t.bilibili.com 链接解析失败 → 统一 extractId 解析
- 修复置顶评论被删除（-404）时程序报错 → 优雅降级为「无置顶评论」
- 修复 export-svg.js 头像/表情丢失；--rpid 缺 --oid 无限报错；--type 非法值；图片下载失败缓存
- 修复终端横幅（BANNER）歪斜：CJK 全角字符按 2 列显示宽度动态对齐填充空格，边框左右字符独立
- 修复交互模式 Cookie 提示误导：有已保存 Cookie 时明确提示（回车沿用，输入 clear 清除后匿名）
- 交互模式全新 UI：分组分区（运行模式/目标设置/监控行为/卡片与输出）、➤ 提示符、配置完成汇总
- 运行模式改为方向键选择器：↑/↓ 移动高亮光标、回车确认（支持循环与回绕）
- 是/否提问升级为横排开关选择器：←/→（或 ↑/↓、空格）切换、回车确认，兼容 y/n 按键
- 修复选择器结束后程序退出的 Bug（stdin.pause() 阻断后续 readline 输入）；高亮箭头统一为粉色加粗（❯/➤）

## [1.0.1] - 2026-08-13

### 修复
- 移除主卡片底部统计栏（❤ 赞 / 条回复 / 分隔线），卡片更简洁
- 卡片文字整体右移：`lineToSvg` 对字符宽度双重累加，导致整行 `<text>` 起点偏移整行宽度（一行越满歪得越狠）
- 头像/图片网格被完全裁剪：`clipPath` 默认 `userSpaceOnUse` 坐标系，圆形裁剪定义在原点 `(0,0)` 而图片在卡片中部，两区域不相交 → 头像不显示；改用 `clipPathUnits="objectBoundingBox"` 相对裁剪
- `npm run check` 原为 bash for 循环，Windows 下无法运行；改为跨平台 `node --check` 链

### 新增
- 回归测试 ×2：`clipPath` 使用 objectBoundingBox + 渲染后像素级断言（头像区域可见、正文起点对齐）
- `scripts/verify-pixels.js`：PNG 像素检查脚本，快速验证卡片布局

## [1.0.0] - 2026-08-13

### 新增
- 首次公开发布
- `cli.js`：终端交互式命令行入口
  - 模式选择（持续监控 / 单次检查）、配置引导、配置持久化（`~/.bili-pinned-card/config.json`）
  - 非 TTY 参数模式（`--uid/--oid/--cookie/--watch/--once/--force/--track-dyn` 等），可挂 cron
  - 监控循环：变化检测、风控友好提示、Ctrl+C 优雅退出
- `lib/api.js`：B站 API 层
  - 匿名访问（自动获取 buvid3/buvid4 防风控），置顶评论/子回复/detail 接口无需登录
  - 可选 SESSDATA Cookie：自动识别置顶动态（匿名会被 -352 风控）
  - UP 互动筛选（UP 回复 / UP 点赞对话链）、动态内容提取
- `lib/card.js`：SVG 卡片渲染（`@resvg/resvg-js`，跨平台无浏览器依赖）
  - 置顶评论卡片：头像 / 作者 / UP 徽标 / 正文（表情内联、自动换行）/ 图片网格 / 点赞回复统计
  - UP 互动回顾图：取消置顶或换新时自动生成（被 UP 回复 / UP 点赞对话链）
  - 动态更新卡片（`--track-dyn`）
  - 2x 高清 PNG 输出 + `latest*.png` 固定名副本
- 事件 → 出图完整闭环：
  - 置顶评论换新 → 先出旧评论互动回顾图，再出当前卡片
  - 置顶动态被替换 → 自动跟随出新图
  - 取消置顶 → 出 UP 互动回顾图
  - 普通动态更新（可选）→ 出动态更新卡片
- `test/card.test.js`：18 个单元测试（`npm test`，node:test 零额外依赖）
- GitHub Actions CI：语法检查 + 单元测试 + 敏感信息扫描

### 说明
- 运行时 Cookie 保存在本机 `~/.bili-pinned-card/config.json`，不入库
- 依赖：@resvg/resvg-js（各平台预编译二进制，无编译），Node ≥ 18
