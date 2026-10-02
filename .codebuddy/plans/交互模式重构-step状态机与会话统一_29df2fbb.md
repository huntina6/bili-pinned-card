---
name: 交互模式重构-step状态机与会话统一
overview: 将 lib/interactive.js 的 300 行线性问答重写为「零依赖 step 状态机」（步骤定义表 + 干净 draft + 汇总确认页 + 上一步/跳过/仅保存），并补齐通知事件/前缀、upTop/maxDyns/emoji 持久化等缺失能力，同时把 cli.js 的 promptReRun REPL 并入同一会话以消除跨轮状态残留。
---

