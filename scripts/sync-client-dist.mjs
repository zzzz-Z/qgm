// @desc 把 packages/client/dist 同步到 apps/standalone/dist/client（air-server 实际服务目录）
// @why 两份 dist 双写是现状；build:web 单独跑时以前不同步，pnpm start 会服务旧产物。
//      build-all.mjs 与 package.json 的 build:web 共用本脚本，保证任一路径构建后都同步。
// [CONSTRAINT] 先 rm 目标再拷贝，避免旧 hash chunk 残留
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 仓库根（scripts/ 的上一级） */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * 递归拷贝目录
 * @param s - 源目录
 * @param d - 目标目录
 */
function copyDirSync(s, d) {
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    const sp = path.join(s, e.name)
    const dp = path.join(d, e.name)
    if (e.isDirectory()) {
      fs.mkdirSync(dp, { recursive: true })
      copyDirSync(sp, dp)
    }
    else {
      fs.copyFileSync(sp, dp)
    }
  }
}

/**
 * 同步 SPA 产物到 standalone 服务目录
 * @param src - 源 dist，默认 packages/client/dist
 * @param dst - 目标 dist，默认 apps/standalone/dist/client
 */
export function syncClientDist(
  src = path.join(ROOT, 'packages', 'client', 'dist'),
  dst = path.join(ROOT, 'apps', 'standalone', 'dist', 'client'),
) {
  if (!fs.existsSync(src)) {
    console.log('[sync-client-dist] skip (no client dist)')
    return
  }
  fs.rmSync(dst, { recursive: true, force: true })
  fs.mkdirSync(dst, { recursive: true })
  copyDirSync(src, dst)
  console.log('[sync-client-dist] synced client dist -> apps/standalone/dist/client')
}

// 直跑入口：node scripts/sync-client-dist.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncClientDist()
}
