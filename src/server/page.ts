// [refactor] 页面壳（引用独立 Vue 项目）
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const __pkgDir = path.dirname(fileURLToPath(import.meta.url))
export const WEB_MAIN_URL = `/@fs/${path.resolve(__pkgDir, '../../client/main.ts').replace(/\\/g, '/')}`
export const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI Runner</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="${WEB_MAIN_URL}"></script>
</body>
</html>`
