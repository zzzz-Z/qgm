# @qgm/ai-runner

独立 Web 应用 + CLI 工具集。npx 或全局安装后可直接使用。

## 定位

继承原根包 @qgm/ai-runner 的名称与全部 bin：

- air-ask
- air-check
- air-log
- air-recover
- air-run-all
- air-notes
- air-compliance
- air-check-regression
- air-server
- ai-runner

## 职责

- 起 Node HTTP server（@hono/node-server）
- 托管 client dist（base /）
- SPA fallback
- 暴露 ai-runner 主命令 + 全部 air-* 辅助命令

## 边界

- 只依赖 packages/core 与 packages/client
- 不在 core 里 listen；listen 只发生在本包
