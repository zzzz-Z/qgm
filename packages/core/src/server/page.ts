// [refactor] 页面壳（引用独立 Vue 项目）
// 发布态由宿主经 AI_RUNNER_CLIENT_MAIN 注入 client 入口绝对路径；
// 仓库态兜底走相对路径 packages/client/main.ts。
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** 包资源目录（用于定位内置页面与静态文件） */
export const __pkgDir = path.dirname(fileURLToPath(import.meta.url))

// 兼容旧调用：模块加载时求一次
/** 内嵌首页 HTML 内容 */
export const PAGE = buildPage()

/**
 * 解析为 Client Main
 */
function resolveClientMain(): string {
  const fromEnv = process.env.AI_RUNNER_CLIENT_MAIN
  if (fromEnv) return path.resolve(fromEnv)
  return path.resolve(__pkgDir, '../../../client/main.ts')
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
