// [arch-hono/app-v4] Hono app 聚合入口——依赖 routes/index.ts barrel，避免 import 爆炸
import { Hono } from 'hono'
import { HONO_PREFIXES, HONO_SUB_APPS } from '../routes/index.js'

/** 顶层 Hono 应用实例 */
export const honoApp = new Hono()

for (const sub of HONO_SUB_APPS) {
  honoApp.route('/', sub)
}

export { HONO_PREFIXES }
