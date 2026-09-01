# 贡献指南 Contributing

感谢你愿意为本项目贡献力量！以下是一些基本约定，请阅读后再提交。

## 开发流程

1. Fork 本仓库并克隆到本地
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 进行修改，确保代码风格与现有代码一致
4. 提交前检查：
   - 运行 `npm test` 确认单元测试全部通过
   - 运行 `npm run check` 确认所有 JS 文件语法正确
   - 不包含任何硬编码的 Cookie / Token / 密钥
   - 不在提交中附带本机绝对路径（如 `/Users/xxx`）
5. 提交并推送：`git push origin feature/your-feature`
6. 创建 Pull Request，描述改动内容和测试情况

## 代码约定

- Node.js ≥ 18，CommonJS 模块风格（`require`），与现有代码一致
- 纯函数放在 `lib/`，并在 `test/card.test.js` 中补充单元测试（`node:test`，零额外依赖）
- 新功能优先考虑参数模式（`--flag`）与交互模式双通道，保持非 TTY 可用
- 风控处理：请求节流、随机抖动、指数退避是基本要求；对 B站 API 的频率保持克制
- 渲染相关改动需在本机跑一次真实数据验证（`node cli.js --oid <动态ID> --once`）

## 敏感信息红线

- ❌ 不要提交任何 Cookie、Token、密钥（包括 `SESSDATA`、`bili_jct`、GitHub Token 等）
- ❌ 不要提交含本机绝对路径的配置（`~/.bili-pinned-card/config.json` 是用户本地文件，不入库）
- ✅ 文档中的配置示例应使用占位符，实际值由使用者本地填写

## 问题反馈

Bug 报告请使用 Issue 模板，说明：运行环境、复现步骤、预期行为、实际行为、日志片段（注意打码敏感信息）。
