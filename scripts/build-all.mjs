import { build } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

console.log(`[build-all] ROOT=${ROOT}`)

console.log('[build-all] step 1/3: SPA (vite build, root=client)')
await build({ configFile: path.join(ROOT, 'vite.config.ts') })

console.log('[build-all] step 2/3: server (vite SSR)')
await build({
  root: ROOT,
  configFile: false,
  logLevel: 'info',
  resolve: {
    extensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
  },
  build: {
    ssr: 'src/server/ws-server.ts',
    outDir: 'dist/server',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'ws-server.js',
        format: 'esm',
      },
    },
  },
})

console.log('[build-all] step 3/3: copy runtime .cjs')
const distRoot = path.join(ROOT, 'dist')
fs.mkdirSync(distRoot, { recursive: true })
for (const f of ['interceptor.cjs', 'helpers.cjs', 'logger.cjs']) {
  const src = path.join(ROOT, 'src', f)
  const dst = path.join(distRoot, f)
  if (fs.existsSync(src)) { fs.copyFileSync(src, dst); console.log(`[build-all] copied ${f}`) }
  else { console.log(`[build-all] skip (missing) ${f}`) }
}
console.log('[build-all] done')
