# bili-pinned-card

**B站置顶评论监测 + 自动出图** —— 全平台独立命令行程序。

- ✅ 无需浏览器、无需 OpenClaw/ego-browser，纯 Node.js 直连 B站 API
- ✅ 跨平台：Windows / macOS / Linux（渲染用 `@resvg/resvg-js` 预编译二进制，无编译）
- ✅ 匿名可用：置顶评论数据无需登录即可读取
- ✅ 终端交互：模式选择、配置引导（记住上次配置，Cookie 自动加载）、监控状态实时输出、Ctrl+C 优雅退出
- ✅ 变化检测：置顶评论换新 / 置顶动态被替换 / 取消置顶 / 普通动态更新（可选）自动识别；`state.json` 持久化，重启不重出图
- ✅ 取消置顶/换新时自动出「UP 互动回顾图」：拉取旧评论全部子回复，筛选 UP 回复/UP 点赞的评论形成对话链
- ✅ 指定评论出图：`出图 <评论链接>` 生成该评论卡片；`回顾 <评论链接>` 生成 UP 互动回顾图（自动识别 UP）
- ✅ UP 热评 TOP 卡：`热评 <动态链接>` 单条动态逐条出卡，`热评 --UP <UID>` 自动检索账号全部动态，逐条 UP 一级评论出一张卡 —— 上方「UP回复上下文」（UP 回复对话对 + 仅点赞未回复，按时间全量排列），下方「高赞回复 TOP N」（仅粉丝回复按点赞降序）；文件名用该评论的发布时间
- ✅ `--追踪动态` 可选监测普通动态更新：置顶未变但 UP 发了新动态时提示并出「动态更新」卡片
- ✅ `--rule` 内容规则：关键字（子串，忽略大小写）或 `/正则/flags`，多条可 `any`（任一命中）/`all`（全部命中）组合；**只对命中的置顶评论出图**，未配置时行为与旧版完全一致
- ✅ `--推送 <URL>` 事件推送：置顶变化/取消置顶/动态更新/热评完成/凭据失效自动 POST，内置通用 JSON、飞书、钉钉、Telegram 四种消息体；**默认关闭**，推送失败只记日志、绝不影响监测
- ✅ 卡片图片按原图比例完整展开（横图/竖图/长图不裁剪）
- ✅ 2x 高清输出：`pinned-card_<时间戳>_<rpid>.png` + `latest.png`

## 安装

需要 Node.js ≥ 18。

```bash
cd bili-pinned-card
npm install
```

## 使用

### 扫码登录（推荐，替代手动粘贴 Cookie）

```bash
node cli.js --login
```

终端显示二维码 → 手机 B站 App「扫一扫」扫码 → 自动保存 Cookie 到 `~/.bili-pinned-card/config.json`。扫码登录获取的 Cookie 设备指纹干净，可降低被 B站 风控标记的概率（评论接口已内置 WBI 签名与自动降级回退；若 Cookie 被限流，程序会输出 ⚠ 警告并提示重新登录）。Cookie 有效期约 30 天，过期后重新执行即可；登录成功会显示账号昵称与 UID 验证。

**设备指纹跨进程复用**：风控按 `buvid` 维度关联请求，因此匿名访问与扫码登录取的 `buvid3`/`buvid4` 会持久化到 `~/.bili-pinned-card/buvid.json`（30 天 TTL），供后续每次运行复用。这对 **cron / `--once` 定时任务尤其重要**——否则每次运行都是新进程、都要重新取一对指纹，等于「每次来访都换一台设备」，反而是机器人特征（`*/1 * * * *` 一天会产生 1440 个不同指纹，现在恒为 1 个）。扫码登录与后续轮询也因此共用同一设备身份。SPI 接口临时不可用时，程序会降级复用过期指纹（10 分钟冷却内不重试），不会让整轮定时任务直接失败。

### 交互模式（推荐）

```bash
node cli.js
```

按终端提示**先选择登录状态**（已登录/扫码/手动粘贴 Cookie/游客），再逐步配置：模式（持续监控/单次检查/UP 热评 TOP 卡/指定评论出图）→ 热评条数 → 动态目标 → 目标 UP 主（**只在你没填动态时才问**，可粘 UP 空间链接） → 评论与互动回顾（指定评论出图时）→ 全账号检索限额（热评留空时）→ 间隔、普通动态监测、**内容规则**（关键词/正则，可留空）→ **推送 Webhook**（可留空关闭）→ 强制重出图、彩色 emoji → **输出分辨率（1x/2x/3x/自定义宽度 340~4080px）** → 输出目录、卡片标题 → **先试跑（--演练：只报告会出什么图，不出图）/ 详细日志**。游客模式下不可用：UID 自动识别置顶动态、全账号热评检索、完整子回复（仅第一页 20 条），因此**必须填写动态链接或 ID**；登录后以上功能全部解锁。配置会保存到 `~/.bili-pinned-card/config.json`，下次运行直接回车使用默认值；向导支持数字键直选，UID/间隔/TOP N/宽度/Cookie/评论 ID 会校验后重问，`~` 自动展开为用户目录；网络等待有加载动画（spinner），手动 Cookie 输入以 `*` 掩码不回显；单次检查/热评/指定评论完成后可选择「返回配置菜单，再运行一次」；Esc 或 Ctrl+C 可随时取消（退出码 130，不会误运行）。向导为**步骤状态机**：任意提问处按 `←` 或输入 `b` 可返回上一步；末尾汇总页可选「开始运行 / 仅保存配置不运行 / 返回修改（跳转到任意段落；该段落在当前模式下不适用时会自动顺延并说明）/ 清空已保存配置 / 放弃退出」，**保存发生在确认之后**；动态链接解析失败不再中止本轮，可重填、显式沿用旧目标或返回上一步；通知推送支持多选订阅事件与标题前缀（事件全不选＝不推送任何事件）；emoji 开关、热评条数（`upTop`）、全账号限额（`maxDyns`）随配置持久化，重进向导与命令行都能沿用（`热评` / `--热评` 不带 N 即沿用上次条数）。非 TTY / CI 环境默认不引导；已在终端但带了目标/`--cookie` 仍想进向导补配规则与推送时，加 `--向导`（`--interactive`）。

### 运行日志（排障）

每次运行详情自动落盘（终端照常显示，文件同步记录；`-q` 静默模式文件仍记录）：

```
~/.bili-pinned-card/logs/2026-09-09.log   # 按天滚动，保留 30 天
```

| 级别 | 内容 | 开启方式 |
|---|---|---|
| info | 启动命令/出卡/置顶变化/风控警告等业务事件 | 默认 |
| debug | 每次 API 请求的路径/状态码/耗时（请求摘要） | `-v` 或环境变量 `BILI_LOG_LEVEL=debug` |
| warn/error | 风控拦截/网络异常/Cookie 失效/致命错误 | 默认 |

安全设计：**Cookie、ticket 等凭据绝不写入日志**；URL 仅记录路径与安全参数，长值自动打码。请求层已内置 1~2s 随机节流，风控提示区分「Cookie 失效（→ `--login`）」与「请求频繁（→ 冷却后重试）」。
风控相关的设备指纹与票据缓存在 `~/.bili-pinned-card/`（`buvid.json` 30 天 / `ticket.json` 约 3 天 / `wbi.json` 12 小时），三者均可安全删除——删除后会在下次运行时自动重新获取。

### 命令行模式（可挂 cron）

三种写法**完全等价**，用中文写就行：

| 写法 | 例子 |
|---|---|
| 动作词（最短，推荐） | `node cli.js 监控 "<链接>" 60` |
| 中文参数名 | `node cli.js --动态 "<链接>" --间隔 60` |
| 英文名 / 旧参数名（老脚本兼容） | `node cli.js --oid "<链接>" --interval 60` |

目标可以是**链接**（动态链接、评论分享链接、UP 空间链接），也可以是纯数字 ID——**直接粘链接最省事**。

```bash
# 看这条动态的置顶评论并出图（只跑一次）
node cli.js 查看 "https://www.bilibili.com/opus/1232243387332034584"

# 盯着一个 UP 主：自动识别他的置顶动态，每 60 秒检查一次
node cli.js 监控 "https://space.bilibili.com/401315430" 60 --cookie "SESSDATA=xxx; bili_jct=yyy"

# 给指定评论出图（旧的置顶评论也行）：直接粘评论分享链接，动态会自动解析
node cli.js 出图 "https://t.bilibili.com/407750907?comment_root_id=319181633760"

# 该评论下的 UP 回复 / UP 点赞回顾图
node cli.js 回顾 "https://t.bilibili.com/407750907?comment_root_id=319181633760"

# UP 热评 TOP 卡（单条动态）：每个 UP 一级评论一张卡，高赞区 10 条
node cli.js 热评 "https://www.bilibili.com/opus/1232243387332034584" 10

# UP 热评 TOP 卡（整个账号）：先问一次确认再逐条出卡；cron 里加 --确认，用 --动态上限 限制条数
node cli.js 热评 --UP 401315430 --cookie "SESSDATA=xxx" --确认 --动态上限 50

# 强制重新出图 / 卡片上画精彩回复 / 安静模式（只输出文件路径，方便脚本取用）
node cli.js 查看 "https://www.bilibili.com/opus/1232243387332034584" --强制 --回复 --静音

# 除置顶外还盯普通动态更新（发了新动态就出图）
node cli.js 监控 "https://space.bilibili.com/401315430" 120 --追踪动态 --cookie "SESSDATA=xxx"

# 内容规则：只有置顶评论含「抽奖」或匹配 /预告|置顶/i 时才出图（多条规则任一命中）
node cli.js 监控 "https://www.bilibili.com/opus/1232243387332034584" --规则 "抽奖" --规则 "/预告|置顶/i"

# 事件推送到飞书机器人（默认关闭；推送失败只记日志，不影响监测）
node cli.js 监控 "https://space.bilibili.com/401315430" --cookie "SESSDATA=xxx" \
  --推送 "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx" --推送格式 feishu --推送事件 new,unpinned

# Telegram 推送（需 chat_id）
node cli.js 监控 "https://space.bilibili.com/401315430" --cookie "SESSDATA=xxx" \
  --推送 "https://api.telegram.org/bot<token>/sendMessage" --推送格式 telegram --推送群 123456789

# 不带动作词直接粘链接也行（老用法同样保留）
node cli.js "https://www.bilibili.com/opus/1232243387332034584" --once
```

> 动作词：`查看`（看一次）/ `监控`（一直盯）/ `热评`（UP 热评卡）/ `出图`（指定评论）/ `回顾`（UP 互动回顾）/ `登录` / `帮助`。
> 除 `监控` 外，动作词都是**跑一次就退出**；要循环就再加 `--监控`。
> 旧写法 `--oid` / `--rpid` / `--uid` / `--up-top` / `--interval` / `--out` … 全部继续可用，含义完全一致，老脚本不用改。

### 全部参数

> **完整说明书就在程序里**：`node cli.js --帮助`（或 `node cli.js 帮助`）——包含每条命令具体做了什么、四类卡片产物、全部功能、参数逐条说明、环境变量与退出码。下面是速查版。

```
写法：中文名（推荐）/ 英文名 / 旧参数名 —— 三种完全等价。下面列出「中文名（英文名，旧写法）」。

目标
  -u, --UP <UID|空间链接>    目标 UP 主（可写 UID 或 space.bilibili.com/xxx 空间链接）
                            （--up / --uid；配合 Cookie 自动识别置顶动态）
  -d, --动态 <链接|ID>       直接指定动态，跳过自动识别；支持 t.bilibili.com / bilibili.com/dynamic
                            / bilibili.com/opus（自动转换成评论区对象）（--dynamic / --oid）
      --评论 <链接|ID>       直接绘制指定评论的卡片（评论分享链接会自动带出所属动态）
                            （--comment / --rpid）
      --类型 <数字>          评论对象类型（默认 11=动态；1=视频 12=文章 14=音频），一般不用写
      --回顾                 与 --评论 联用：绘制该评论的 UP 互动回顾图（--context）

模式
      --监控                 持续监控（默认）
      --单次                 单次检查（--once）
      --间隔 <秒>            监控间隔（默认 60，最短 10）（-i / --interval）
      --热评 [N]             UP 热评 TOP 卡（不带 N 时沿用上次向导条数，缺省 10）：配合 --动态 处理单条
                            动态；配合 --UP 自动检索该账号全部动态（先询问确认，--确认 跳过）
      --动态上限 <N>         --UP + --热评 时最多处理的动态条数（默认不限制）（--max-dyns）
      --确认                 非交互模式下跳过全账号检索的确认询问（--yes）
      --强制                 强制重新出图（忽略 state.json）（--force）
      --追踪动态             同时监测普通动态更新（--track-dyn）

卡片与输出
  -r, --回复                 卡片上绘制精彩回复（--show-replies）
  -o, --输出 <目录>          输出目录（默认：项目目录（cli.js 同级）下的 output/）（--out）
      --倍率 <倍率>          渲染倍率（默认 2；0.5~6，支持 1.5 等小数）（--scale）
      --宽度 <像素>          自定义输出宽度（340~4080，优先于 --倍率）（--width）
      --无表情               关闭 Unicode emoji 彩色化（默认用 Twemoji 内联图）（--no-emoji）
      --标题 <文字>          卡片标题显示名（默认取 UP 名）（--up-name）

登录与运行
  -c, --cookie <Cookie>      登录 Cookie（可选）：解锁自动识别/完整子回复，降低风控
      --登录                 扫码登录并保存 Cookie（--login）
      --向导 / -I            强制进入配置向导：即使已给目标也能补配规则与推送（--interactive）
      --免向导               非交互：不进入配置向导，直接用参数/已保存配置运行（--no-input）
  -q, --静音                 安静模式（--quiet）
  -v, --详细                 详细日志：debug 级写入文件（排障用）（--verbose）
  -V, --版本                 显示版本号（--version）
  -h, --帮助                 帮助（--help）

规则与推送（默认关闭）
      --规则 <规则>          内容规则（可重复）：仅命中规则的置顶评论才出图/推送；
                            关键字子串匹配（如 抽奖）或 /正则/flags（如 /预告|置顶/i）（--rule）
      --规则模式 <模式>      any=任一命中（默认）/ all=全部命中（--rule-mode）
      --推送 <URL>           推送 Webhook（默认关闭；配置后事件自动 POST，失败仅记日志）
                            （--webhook / --notify-webhook）
      --推送格式 <模板>      generic（默认）/ feishu / dingtalk / telegram（--notify-format）
      --推送事件 <列表>      订阅事件（逗号分隔）：new,unpinned,dyn-update,up-top,error
                            不传该参数 = 全部订阅；显式传空串 = 不订阅任何事件（--notify-events）
      --推送群 <ID>          Telegram 渠道 chat_id（仅 telegram 模板需要）（--notify-chat-id）
      --推送前缀 <文本>      推送标题前缀（如 UP 名）（--notify-prefix）
```

### 给 AI / 脚本调用（机器可读）

```bash
node cli.js 能力                                  # 能力清单 JSON：动作词/参数（含旧名）/取值方式/事件/退出码（自描述）
node cli.js --json 查看 "<动态链接>"                # stdout 只输出 NDJSON（每行一个 JSON），人类日志走 stderr
node cli.js --json --演练 热评 "<链接>" 10          # 只报告计划：会出几张卡、目标对不对（不出图、不写 state）
echo "<链接>" | node cli.js --json 查看 -           # 目标也可以从标准输入读
```

- **NDJSON 契约**（`jsonContract: 1`）：`start` / `card` / `result` / `error` / `end` 五类行；`card.file` 是绝对路径。
- **错误可决策**：`error.kind` = `auth`（让用户跑 `登录`）/ `expired` / `risk`（稍后重试）/ `usage`（改参数）/ `api` / `other`，并附 `hint`。
- **不挂死**：`--json` 或非交互环境下，全账号热评不再弹确认，而是返回 `event: cancel` 并提示加 `--确认`。
- 完整调用规范见 [AGENTS.md](AGENTS.md)；程序内调用可用 `require('.../lib/monitor').checkOnce(cfg)`。

### 监控输出示例

```
[21:18:56] 目标: 动态 404135596 (匿名)
[21:18:56] 输出: ./output · 每 60s 监控
[21:18:57] 🔄 检测到置顶评论变化，正在生成卡片...
[21:18:59] ✅ 卡片已生成: output/pinned-card_20260813131859_313472209520.png
[21:18:59] 下次检查: 21:19:56
```

## 两种数据来源（重要）

| 方式 | 需要 | 说明 |
|---|---|---|
| 指定动态（`查看 <动态链接>`，即 `--动态`） | 无 | 直接读取该动态的置顶评论，匿名即可，最稳定 |
| 自动识别置顶动态（`监控 --UP <UID>`，即 `--UP`） | SESSDATA Cookie | 匿名会被风控（-352）。提供 Cookie 后每次轮询自动跟随 UP 更换的置顶动态 |

**Cookie 获取方法**：浏览器登录 B站 → F12 → Application/存储 → Cookies → 复制 `SESSDATA` 值（格式 `SESSDATA=xxx; bili_jct=yyy`，两者都可填）。Cookie 保存在本机 `~/.bili-pinned-card/config.json`，**保存一次后运行时自动加载，无需每次传参**；请勿外传。

> ⚠️ 匿名限制：未登录时评论区子回复接口只返回第一页 20 条。要拉取完整子回复（互动回顾图/监控需要），请配置 Cookie。

风控提示会直接显示在终端里，按提示操作即可恢复。

## 事件与出图对照

| 事件 | 触发条件 | 出图 |
|---|---|---|
| 首次/置顶评论换新 | rpid 与上次不同 | 置顶评论卡片（换新时先出旧评论的互动回顾图） |
| 置顶动态被替换 | 置顶动态 ID 变化 | 新置顶动态的评论卡片 |
| 置顶评论取消 | 之前有置顶评论，现在无 | UP 互动回顾图（旧评论的子回复中筛选 UP 回复/点赞） |
| 普通动态更新（可选） | `--追踪动态` 开启且最新动态 ID 变化（置顶未变） | 动态更新卡片 |
| 手动指定评论 | `出图 <评论链接>`（`--动态` + `--评论`） | 该评论的置顶样式卡片 |
| 手动互动回顾 | `回顾 <评论链接>`（`--评论` + `--回顾`） | 该评论的 UP 互动回顾图 |
| UP 热评 TOP 卡 | `热评 <动态链接>`（或 `热评 --UP <UID>` 全账号） | 每条 UP 一级评论一张：UP回复上下文（全量按时间）+ 粉丝高赞 TOP N |
| 规则未命中 | 配置 `--rule` 且置顶评论正文（或动态正文）不匹配 | 不出图、不推送（记为已读，避免每个周期重复判定） |

「UP 互动回顾图」：拉取评论的全部子回复（需 Cookie 翻页），筛选出被 UP 回复、被 UP 点赞的评论，以对话链形式绘制（粉丝评论 + UP 回复 + 角色标签，UP 侧粉色高亮）。`回顾` 模式会自动识别该动态的 UP（评论接口 upper 字段），无需手动指定 UID。旧评论已删除时自动跳过（仅日志提示）。

## 内容规则与推送（可选，默认关闭）

**内容规则**（`--rule`，可重复）用于在置顶监测模式下过滤出图与推送。语法：

| 写法 | 匹配方式 |
|---|---|
| `抽奖` | 关键字子串匹配，忽略大小写 |
| `/预告\|置顶/i` | 正则（`/…/flags`，支持 g/i/m/s/u/y），非法正则启动即报错 |
| 多条规则 | `--rule-mode any`（默认，任一命中）/ `all`（需全部命中） |

未配置规则时恒命中，行为与旧版完全一致。规则命中会在日志中列出命中的规则原文；未命中则记为已读（`state.json` 标记 `lastFiltered`），不会每个检查周期重复判定。

**事件推送**（`--推送 <URL>`）在监测结果产生后 best-effort POST（8 秒超时，失败只写日志、绝不中断监测）：

| `--notify-events` | 触发时机 |
|---|---|
| `new`（默认） | 置顶评论首次出图/换新（含 `出图` 指定评论、`回顾` 互动回顾） |
| `unpinned`（默认） | 检测到取消置顶并生成旧评论互动回顾图 |
| `dyn-update`（默认） | `--追踪动态` 检测到普通动态更新并出图 |
| `up-top`（默认） | `--热评` 热评卡批次完成 |
| `error`（默认） | Cookie 失效 / 登录凭证过期等需人工介入的错误（风控类会自动退避自愈，不推送） |

`--notify-events` 的订阅语义：**不传该参数 = 全部订阅**；**显式传空串（或向导里把事件全部取消勾选）= 不推送任何事件**。

`--notify-format` 决定消息体：`generic`（原始事件字段 JSON，便于自定义服务）、`feishu`（`msg_type=text`）、`dingtalk`（`msgtype=text`）、`telegram`（需 `--notify-chat-id`）。`--notify-prefix` 可为标题加前缀（如 UP 名）。

## 卡片样式

深色渐变背景 + 粉色（`#FB7299`）点缀：

- 标题栏：`置顶评论 · 动态 · <UP名>`
- 主卡片：圆形头像 / 作者 / UP主徽标 / 时间 / 正文（表情内联渲染、自动换行）/ 图片（单图按原图比例完整展开，多图 3 列网格）
- 互动回顾图：主评论 + 「UP互动回顾」对话链（被UP回复 / UP回复 / 被UP点赞 三种角色块）
- 页脚：左侧 `BILI PINNED COMMENT` 等标识，右侧显示**动态完整链接** `https://t.bilibili.com/<oid>`

字体用系统字体：macOS PingFang SC / Windows 微软雅黑 / Linux Noto Sans CJK，无需配置。Unicode emoji 默认转为 Twemoji 内联彩图（resvg 不支持彩色字体；CDN 不可达时自动熔断回退为文字，`--no-emoji` 可关闭，`BILI_EMOJI_CDN` 可换源），B站表情（`[xxx]` 占位符）内联图片。头像/配图自动按显示尺寸请求 B站 CDN 缩略图（头像 65KB→约 2KB），超长卡片按 12,000 逻辑高度预算截断并在卡内提示。

## 输出文件

- `pinned-card_<yyyyMMddHHmmss>_<rpid>.png` —— 置顶评论卡片（2x 高清）
- `unpinned-context_<时间戳>_<rpid>.png` —— 取消置顶/换新/`回顾` 时的 UP 互动回顾图
- `up-top_<评论时间yyyyMMddHHmmss>_<rpid>.png` —— UP 热评 TOP 卡（文件名用该 UP 评论的发布时间）
- `dynamic-update_<时间戳>_<动态ID>.png` —— 普通动态更新卡片（`--追踪动态`）
- `latest.png` / `latest-unpinned.png` / `latest-dynamic.png` / `latest-up-top.png` —— 各类最新一张的固定名副本
- `state.json` —— 监控状态（上次 rpid/oid/动态ID/时间），删除后下次运行会重新出图

## 常见问题

- **`-352` 风控**：匿名自动识别置顶动态被拦截 → 提供 `--cookie` 或改用 `查看 <动态链接>` 直连。watch 模式下程序会**自动指数退避**（最长 10 分钟、带抖动），恢复后自动复位，无需手动干预。
- **互动图显示「暂无 UP 互动」**：该评论的子回复中没有 UP 回复/点赞的记录，属正常情况；若怀疑是匿名限制（只拉了前 20 条），请配置 Cookie 后重试。
- **`热评 --UP` 全账号模式提示需 Cookie / 要求确认**：匿名会被风控（-352），且子回复只取第一页；提供 `--cookie` 后先列出账号动态总数询问确认（防误触），非交互环境（cron）需加 `--确认`（`--yes`）自动确认，`--动态上限`（`--max-dyns`）可限制处理条数。
- **图片空白/占位**：个别 CDN 图下载失败时自动降级为占位块（内置重试 1 次），不影响文字。
- **emoji 显示为黑白或空白**：Unicode emoji 默认转 Twemoji 内联彩图；CDN 不可达时进程级熔断回退为文字（不阻塞出图），可用 `BILI_EMOJI_CDN` 换源或 `--no-emoji` 关闭。
- **`--interval` 最小 10 秒**：过频会被风控，建议 ≥ 30。
- **`--单次`（`--once`）失败时退出码为 1**：配置类错误（如 `出图` 没给出所属动态、`热评 --UP` 未带 Cookie）与「拉取结果不可信」（动态已删等）都以 1 退出，cron 可据此告警；成功（含「无置顶评论」「未变化」）仍为 0。缺目标的动作词（如 `node cli.js 查看`）同样是简洁帮助 + 退出码 1。
- **换 `--oid` 不会串状态**：`state.json` 记录了所属动态，换成另一条动态时按首次运行处理——不会把上一条动态的置顶评论误判成「取消置顶」，也不会推出假的取消通知。
- **Node < 18**：`fetch`/`AbortSignal.timeout` 不可用，请升级。

## 开发与验证

```bash
npm test          # 301 个单元测试（node:test 零依赖，无外部网络）
npm run check     # 全部 JS/脚本语法检查（跨平台）
npm run typecheck # JSDoc 类型检查（tsc --noEmit，零错误）
npm run smoke     # 冒烟测试：真实网络「拉评论 → 渲染 → 出 PNG」全链路（约 3s）

# 像素级验证卡片布局（头像可见 / 正文对齐 / 统计栏区域）
node scripts/verify-pixels.js output/latest.png

# 导出当前卡片 SVG 源码（供设计/视觉模型参考）
node scripts/export-svg.js [oid] [输出路径]
```

CI（GitHub Actions）三平台矩阵：ubuntu × Node 18/20/22 + windows/macos × Node 22，含语法检查、类型检查与敏感信息扫描。

## 项目结构

```
bili-pinned-card/
├── cli.js                  # 入口装配：参数 → 统一会话（向导/运行/再运行）→ 监控（约 100 行）
├── lib/
│   ├── args.js             # 参数解析 / buildConfig（别名表 + 中文动作词）
│   ├── help.js             # 帮助文本：HELP 完整说明书 + SHORT_HELP 简洁帮助
│   ├── jsonout.js          # 机器可读输出（--json：stdout 只出 NDJSON，日志改道 stderr）
│   ├── caps.js             # 能力清单（node cli.js 能力）：给 AI 的工具自描述
│   ├── interactive.js      # 交互引导：步骤状态机（STEPS）+ 干净 draft + 统一会话 + 扫码登录
│   ├── watcher.js          # 监控主循环 + 错误分类
│   ├── monitor.js          # 核心检查（按模式分派：up-top / rpid / 置顶监测）
│   ├── rule.js             # 内容规则（关键字/正则，any/all）
│   ├── notify.js           # 通知推送抽象（generic/飞书/钉钉/Telegram，best-effort）
│   ├── login.js            # 扫码登录（passport + crossDomain ticket 兑换）
│   ├── logger.js           # 文件日志（按天滚动 + 敏感脱敏）
│   ├── state.js            # 配置/状态持久化（原子写）
│   ├── ui.js / card.js / png.js
│   ├── api/                # client（节流/风控/重试）/ wbi（签名缓存）/ ticket（风控票据）/ comment / dynamic / image / util
│   └── card/               # constants / text / emoji / image / layout / templates
├── scripts/                # smoke / verify-pixels / export-svg / check-syntax / collect-comment-styles
├── test/                   # 19 个测试文件（301 用例，node:test）
├── types.d.ts              # JSDoc 全局类型（CliConfig）
└── output/                 # 出图目录（运行时生成）
```

## 相关项目

- [2568x 星星的瞳](https://github.com/huntina6/2568x)：B站账号活动监测与动态归档工具包（本项目的 UP 互动回顾思路参考其 `unpinned-context-image.js`，本项目的纯 Node/SVG 实现不依赖浏览器）
