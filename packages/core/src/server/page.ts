// [refactor] 页面壳（引用独立 Vue 项目）
// 发布态由宿主经 AI_RUNNER_CLIENT_MAIN 注入 client 入口绝对路径；
// 仓库态兜底走相对路径 packages/client/main.ts。
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

/** 包资源目录（用于定位内置页面与静态文件） */
export const __pkgDir = path.dirname(fileURLToPath(import.meta.url))

// 兼容旧调用：模块加载时求一次
/** 内嵌首页 HTML 内容 */
export const PAGE = buildPage()

/**
 * 客户端入口候选路径（按优先级）
 * [client-main-candidates-v1] 打包会改变目录层级，任何**单条**相对路径都必然有一种形态解析错：
 *   - 源码态 `__pkgDir` = `packages/core/src/server` ⇒ `../../../client/main.ts` 正确；
 *   - 打包态 `__pkgDir` = `apps/standalone/dist/_server` ⇒ 同一条解析出 `apps/client/main.ts`，
 *     该目录不存在（实测：崩溃后 5175 返回的 HTML 里 `<script src="/@fs/…/apps/client/main.ts">`）。
 *   ⇒ 结果就是「兜底路径自己坏了」：`serveStatic` 失败时的最后一道回退在发布形态必然 404。
 * [WHY] 逐个候选做存在性探测，取第一个真实存在的入口 —— 比继续猜目录层级稳。
 * [CHANGE-IMPACT] 全都不存在时返回首选候选（保持旧行为可见），不抛错。
 * @param pkgDir - 当前模块所在目录（默认 `__pkgDir`；显式传入便于测试与宿主重定位）
 * @param cwd - 进程工作目录（默认 `process.cwd()`）
 * @returns 候选绝对路径，按优先级排列
 */
export function clientMainCandidates(pkgDir: string = __pkgDir, cwd: string = process.cwd()): string[] {
  const fromEnv = process.env.AI_RUNNER_CLIENT_MAIN
  if (fromEnv) return [path.resolve(fromEnv)]
  return [
    // 源码态：packages/core/src/server → packages/client/main.ts
    path.resolve(pkgDir, '../../../client/main.ts'),
    // 打包态：apps/standalone/dist/_server → 仓库根 → packages/client/main.ts
    path.resolve(pkgDir, '../../../../packages/client/main.ts'),
    // cwd 即仓库根（`pnpm start` 的常规形态）
    path.resolve(cwd, 'packages/client/main.ts'),
  ]
}

/**
 * 取第一个存在的客户端入口
 * [CONSTRAINT] `candidates` 不得为空（调用方保证）；全都不存在时返回 `candidates[0]`
 * @param candidates - 候选绝对路径，按优先级
 * @param exists - 存在性判定（默认 `fs.existsSync`；显式传入便于测试）
 * @returns 命中的入口路径
 */
export function pickClientMain(candidates: string[], exists: (p: string) => boolean = fs.existsSync): string {
  for (const c of candidates) {
    if (exists(c)) return c
  }
  return candidates[0]
}

/**
 * 解析为 Client Main
 */
function resolveClientMain(): string {
  return pickClientMain(clientMainCandidates())
}

/**
 * 构建 Page
 * @param clientMainAbs - client Main Abs
 */
export function buildPage(clientMainAbs?: string): string {
  const abs = clientMainAbs ? path.resolve(clientMainAbs) : resolveClientMain()
  const url = `/@fs/${abs.replace(/\\/g, '/')}`
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '  <title>AI Runner</title>',
    '</head>',
    '<body>',
    '  <div id="app"></div>',
    `  <script type="module" src="${url}"></script>`,
    '</body>',
    '</html>',
  ].join('\\n')
}
