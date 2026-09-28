// [workspace-router-v1] 从 core.ts 抽出：宿主无关的 HTTP 路由分发器
// Vite 插件宿主与独立 Node 宿主共用本模块；本文件不得 import vite / node:http 之外
// 的宿主 API，不得 listen。
import { handle } from './handle.js'
import { guardRequest } from './http.js'
import type { AiRunnerOptions, IncomingMessage, ServerResponse } from './http.js'

/** 路由装配器接口：注册与分发 */
export interface Router {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/**
 * 创建 HTTP 请求路由（含 CSRF / DNS-rebinding 防护）
 * [WHY] guardRequest 必须在业务分发前拦截跨域 / 非法 Content-Type / 非本机命令执行端点，集中在此处比散落到各路由更可靠
 * [CONSTRAINT] guardRequest 返回 false 时表示已回写拒绝响应，此时 handle 不再执行
 * [CHANGE-IMPACT] options.allowRemote 决定非 loopback Host 能否访问 /exec /run 端点
 * @param options 服务配置（root / allowRemote 等）
 */
export function createRouter(options: AiRunnerOptions = {}): Router {
  return {
    handle(req, res) {
      if (!guardRequest(req, res, options)) return Promise.resolve()
      return handle(req, res)
    },
  }
}
