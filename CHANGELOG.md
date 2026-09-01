# 更新日志 Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
