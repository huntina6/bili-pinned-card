# bili-pinned-card

**B站置顶评论监测 + 自动出图** —— 全平台独立命令行程序。

- ✅ 无需浏览器、无需 OpenClaw/ego-browser，纯 Node.js 直连 B站 API
- ✅ 跨平台：Windows / macOS / Linux（渲染用 `@resvg/resvg-js` 预编译二进制，无编译）
- ✅ 匿名可用：置顶评论数据无需登录即可读取
- ✅ 终端交互：模式选择、配置引导（记住上次配置，Cookie 自动加载）、监控状态实时输出、Ctrl+C 优雅退出
- ✅ 变化检测：置顶评论换新 / 置顶动态被替换 / 取消置顶 / 普通动态更新（可选）自动识别；`state.json` 持久化，重启不重出图
- ✅ 取消置顶/换新时自动出「UP 互动回顾图」：拉取旧评论全部子回复，筛选 UP 回复/UP 点赞的评论形成对话链
- ✅ `--rpid` 按评论 ID 直接出图；`--context` 一键生成任意评论的 UP 互动回顾图（自动识别 UP）
- ✅ `--up-top` UP 热评 TOP 卡：指定动态（`--oid`）或自动检索账号全部动态（`--uid`），逐条 UP 一级评论出一张卡 —— 上方「UP回复上下文」（UP 回复对话对 + 仅点赞未回复，按时间全量排列），下方「高赞回复 TOP N」（仅粉丝回复按点赞降序）；文件名用该评论的发布时间
- ✅ `--track-dyn` 可选监测普通动态更新：置顶未变但 UP 发了新动态时提示并出「动态更新」卡片
- ✅ 卡片图片按原图比例完整展开（横图/竖图/长图不裁剪）
- ✅ 2x 高清输出：`pinned-card_<时间戳>_<rpid>.png` + `latest.png`

## 安装

需要 Node.js ≥ 18。

```bash
cd bili-pinned-card
npm install
```

## 使用

### 交互模式（推荐）

```bash
node cli.js
```

按终端提示逐步配置：模式（持续监控/单次检查）→ UID → Cookie（可选）→ 动态 ID（可选）→ 间隔 → 是否绘制精彩回复 → 输出目录。配置会保存到 `~/.bili-pinned-card/config.json`，下次运行直接回车使用默认值。

### 命令行模式（可挂 cron）

```bash
# 指定动态，单次检查出图
node cli.js --oid 404135596 --once

# 指定 UP 主 + Cookie，自动识别置顶动态并持续监控
node cli.js --uid 401315430 --cookie "SESSDATA=xxx; bili_jct=yyy" --watch -i 60

# 强制重新出图
node cli.js --oid 404135596 --once --force

# 卡片上绘制精彩回复
node cli.js --oid 404135596 --once -r

# 绘制指定评论的卡片（旧的置顶评论、任意评论链接均可）
node cli.js --oid 404135596 --rpid 313406396048 --once
# 或直接粘贴 B站动态分享链接（自动提取动态 ID / 评论 ID）
node cli.js --oid "https://t.bilibili.com/404135596" --rpid "https://t.bilibili.com/404135596?comment_root_id=313406396048" --once

# 或直接粘贴 B站新版 Opus 动态链接（自动解析并转换为评论 oid）
node cli.js --oid "https://www.bilibili.com/opus/1232243387332034584" --up-top --once

# 生成该评论的 UP 互动回顾图（UP 回复/点赞对话链，自动识别动态 UP）
node cli.js --oid 404135596 --rpid 313406396048 --context --once

# UP 热评 TOP 卡（单动态）：该动态下每条 UP 一级评论出一张卡
node cli.js --oid 404135596 --up-top --once
# 指定高赞区条数 N（默认 10）
node cli.js --oid 404135596 --up-top 10 --once

# UP 热评 TOP 卡（全账号）：自动检索该账号全部动态，先询问确认后逐条出卡
node cli.js --uid 401315430 --cookie "SESSDATA=xxx" --up-top --once
# 非交互（cron）自动处理需加 --yes；--max-dyns 限制最多处理的动态条数
node cli.js --uid 401315430 --cookie "SESSDATA=xxx" --up-top --yes --max-dyns 50 --once

# 同时监测普通动态更新（置顶未变但发了新动态时提示并出图）
node cli.js --uid 401315430 --cookie "SESSDATA=xxx" --watch --track-dyn -i 120

# 安静模式：仅输出生成的文件路径（方便脚本取用）
node cli.js --uid 401315430 --cookie "SESSDATA=xxx" --watch -i 300 -q
```

### 全部参数

```
--uid <UP主UID>        目标 UP 主（配合 Cookie 自动识别置顶动态）
--oid <动态ID或链接>    直接指定动态（含其置顶评论），跳过自动识别；支持 t.bilibili.com / bilibili.com/dynamic / bilibili.com/opus（自动转换评论 oid）
--rpid <评论ID或链接>   直接绘制指定评论的卡片（需配合 --oid）
--context              与 --rpid 联用：绘制该评论的 UP 互动回顾图
--up-top [N]           UP 热评 TOP 卡（默认 N=10）：配合 --oid 处理单条动态；配合 --uid 自动检索该账号全部动态（先询问确认，--yes 跳过）
--max-dyns <N>         --uid + --up-top 时最多处理的动态条数（默认不限制）
--yes                  非交互模式下跳过全账号检索的确认询问
--cookie <SESSDATA>    登录 Cookie（可选）：解锁自动识别/完整子回复，降低风控
--watch                持续监控（默认）
--once                 单次检查
--force                强制重新出图（忽略 state.json）
--track-dyn            同时监测普通动态更新
-r, --show-replies     卡片上绘制精彩回复
-i, --interval <秒>    监控间隔（默认 60，最短 10）
-o, --out <目录>       输出目录（默认 ./output）
-q, --quiet            安静模式
-h, --help             帮助
```

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
| 指定动态 ID（`--oid`） | 无 | 直接读取该动态的置顶评论，匿名即可，最稳定 |
| 自动识别置顶动态（`--uid`） | SESSDATA Cookie | 匿名会被风控（-352）。提供 Cookie 后每次轮询自动跟随 UP 更换的置顶动态 |

**Cookie 获取方法**：浏览器登录 B站 → F12 → Application/存储 → Cookies → 复制 `SESSDATA` 值（格式 `SESSDATA=xxx; bili_jct=yyy`，两者都可填）。Cookie 保存在本机 `~/.bili-pinned-card/config.json`，**保存一次后运行时自动加载，无需每次传参**；请勿外传。

> ⚠️ 匿名限制：未登录时评论区子回复接口只返回第一页 20 条。要拉取完整子回复（互动回顾图/监控需要），请配置 Cookie。

风控提示会直接显示在终端里，按提示操作即可恢复。

## 事件与出图对照

| 事件 | 触发条件 | 出图 |
|---|---|---|
| 首次/置顶评论换新 | rpid 与上次不同 | 置顶评论卡片（换新时先出旧评论的互动回顾图） |
| 置顶动态被替换 | 置顶动态 ID 变化 | 新置顶动态的评论卡片 |
| 置顶评论取消 | 之前有置顶评论，现在无 | UP 互动回顾图（旧评论的子回复中筛选 UP 回复/点赞） |
| 普通动态更新（可选） | `--track-dyn` 开启且最新动态 ID 变化（置顶未变） | 动态更新卡片 |
| 手动指定评论 | `--oid` + `--rpid` | 该评论的置顶样式卡片 |
| 手动互动回顾 | `--oid` + `--rpid` + `--context` | 该评论的 UP 互动回顾图 |
| UP 热评 TOP 卡 | `--oid` + `--up-top`（或 `--uid` + `--up-top` 全账号） | 每条 UP 一级评论一张：UP回复上下文（全量按时间）+ 粉丝高赞 TOP N |

「UP 互动回顾图」：拉取评论的全部子回复（需 Cookie 翻页），筛选出被 UP 回复、被 UP 点赞的评论，以对话链形式绘制（粉丝评论 + UP 回复 + 角色标签，UP 侧粉色高亮）。`--context` 模式会自动识别该动态的 UP（评论接口 upper 字段），无需手动指定 UID。旧评论已删除时自动跳过（仅日志提示）。

## 卡片样式

深色渐变背景 + 粉色（`#FB7299`）点缀：

- 标题栏：`置顶评论 · 动态 · <UP名>`
- 主卡片：圆形头像 / 作者 / UP主徽标 / 时间 / 正文（表情内联渲染、自动换行）/ 图片（单图按原图比例完整展开，多图 3 列网格）
- 互动回顾图：主评论 + 「UP互动回顾」对话链（被UP回复 / UP回复 / 被UP点赞 三种角色块）
- 页脚：左侧 `BILI PINNED COMMENT` 等标识，右侧显示**动态完整链接** `https://t.bilibili.com/<oid>`

字体用系统字体：macOS PingFang SC / Windows 微软雅黑 / Linux Noto Sans CJK，无需配置。正文含 emoji 时可能显示为空白（渲染器不支持彩色 emoji 字体），B站表情（`[xxx]` 占位符）已支持内联图片。

## 输出文件

- `pinned-card_<yyyyMMddHHmmss>_<rpid>.png` —— 置顶评论卡片（2x 高清）
- `unpinned-context_<时间戳>_<rpid>.png` —— 取消置顶/换新/`--context` 时的 UP 互动回顾图
- `up-top_<评论时间yyyyMMddHHmmss>_<rpid>.png` —— UP 热评 TOP 卡（文件名用该 UP 评论的发布时间）
- `dynamic-update_<时间戳>_<动态ID>.png` —— 普通动态更新卡片（`--track-dyn`）
- `latest.png` / `latest-unpinned.png` / `latest-dynamic.png` / `latest-up-top.png` —— 各类最新一张的固定名副本
- `state.json` —— 监控状态（上次 rpid/oid/动态ID/时间），删除后下次运行会重新出图

## 常见问题

- **`-352` 风控**：匿名自动识别置顶动态被拦截 → 提供 `--cookie` 或改用 `--oid` 直连。
- **互动图显示「暂无 UP 互动」**：该评论的子回复中没有 UP 回复/点赞的记录，属正常情况；若怀疑是匿名限制（只拉了前 20 条），请配置 Cookie 后重试。
- **`--up-top` 全账号模式提示需 Cookie / 要求确认**：匿名会被风控（-352），且子回复只取第一页；提供 `--cookie` 后先列出账号动态总数询问确认（防误触），非交互环境（cron）需加 `--yes` 自动确认，`--max-dyns` 可限制处理条数。
- **图片空白/占位**：个别 CDN 图下载失败时自动降级为占位块，不影响文字。
- **`--interval` 最小 10 秒**：过频会被风控，建议 ≥ 30。
- **Node < 18**：`fetch`/`AbortSignal.timeout` 不可用，请升级。

## 开发与验证

```bash
npm test        # 26 个单元测试（node:test 零依赖）
npm run check   # 全部 JS 语法检查（跨平台）

# 像素级验证卡片布局（头像可见 / 正文对齐 / 统计栏区域）
node scripts/verify-pixels.js output/latest.png

# 导出当前卡片 SVG 源码（供设计/视觉模型参考）
node scripts/export-svg.js [oid] [输出路径]
```

## 项目结构

```
bili-pinned-card/
├── cli.js                  # 入口：参数解析、终端交互、监控循环、状态管理
├── lib/api.js              # B站 API 层（buvid 风控、Cookie 合并、评论/回复/图片/尺寸解析）
├── lib/card.js             # SVG 卡片布局 + resvg 渲染 PNG（置顶卡/互动回顾/动态更新）
├── scripts/
│   ├── verify-pixels.js    # PNG 像素检查（头像/正文布局验证）
│   └── export-svg.js       # 导出卡片 SVG 源码
├── test/card.test.js       # 单元测试（含渲染回归测试）
└── output/                 # 出图目录（运行时生成）
```

## 相关项目

- [2568x 星星的瞳](https://github.com/huntina6/2568x)：B站账号活动监测与动态归档工具包（本项目的 UP 互动回顾思路参考其 `unpinned-context-image.js`，本项目的纯 Node/SVG 实现不依赖浏览器）
