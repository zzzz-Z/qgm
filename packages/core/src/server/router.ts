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
 * 创建 Router
 * @param options - options
 */
export function createRouter(options: AiRunnerOptions = {}): Router {
  return {
    handle(req, res) {
      if (!guardRequest(req, res, options)) return Promise.resolve()
      return handle(req, res)
    },
  }
}
