// [workspace-core-barrel-v1] packages/core 公开 API 的唯一契约入口。
// 铁律：只导出双宿主共享的宿主无关 API；宿主专属逻辑（Vite / Node listen）留在 apps/*。

export { EXCLUDE_DIRS, EXCLUDE_PREFIX, getRoot, PREFIX, ROOT, setRoot } from './config.js'

// 资源清理钩子（宿主 close 时调用）
export { closeBrowser } from './headless/smoke.js'
// WS attach（宿主注入 server 之后共用）
export { attachWs } from './server/attach-ws.js'

// HTTP 基础设施（宿主无关）
export { guardRequest, sendJSON } from './server/http.js'

export type { AiRunnerOptions, IncomingMessage, ServerResponse } from './server/http.js'

// 页面壳与启动器（Vite 中间件注入所需）
export { __pkgDir } from './server/page.js'

// 路由分发器（两宿主共享）
export { createRouter } from './server/router.js'

export type { Router } from './server/router.js'
