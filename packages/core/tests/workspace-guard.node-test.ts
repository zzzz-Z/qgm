// [workspace-guard-v2] 结构守卫：三条铁律，防止 monorepo 腐化
// 1. packages/* 不得依赖 apps/*
// 2. packages/* 里禁止 listen / createServer / import vite / @hono/node-server
// 3. packages/client 不得 import packages/core
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// [mig-path-v1] 测试从 test/server/ 迁到 packages/core/tests/，__dirname 深一级 → ROOT 需 3 级上溯
const ROOT = path.resolve(__dirname, '..', '..', '..')

// [workspace-guard-v4] 构建配置豁免：vite.config.ts / unocss.config 允许 import vite / apps 插件
const BUILD_CONFIG_EXEMPT = /(?:^|\/)vite\.config\.ts$|(?:^|\/)uno\.config\.ts$/
const SRC_EXTS = new Set(['.ts', '.tsx', '.vue', '.cjs', '.mjs', '.js'])
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'test-results', 'playwright-report'])

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (SRC_EXTS.has(path.extname(p))) out.push(p)
  }
  return out
}

function rel(p: string): string {
  return path.relative(ROOT, p)
}

it('铁律 1: packages/* 不得依赖 apps/*', () => {
  const violators: string[] = []
  const re = /from\s+['"][^'"]*apps\//
  for (const f of walk(path.join(ROOT, 'packages'))) {
    if (BUILD_CONFIG_EXEMPT.test(rel(f))) continue
    const txt = fs.readFileSync(f, 'utf8')
    if (re.test(txt)) violators.push(rel(f))
  }
  assert.deepEqual(violators, [], `以下 packages 文件引用了 apps/*:\n${violators.join('\n')}`)
})

it('铁律 2: packages/* 里禁止 listen / createServer / import vite / @hono/node-server', () => {
  const patterns: Array<[string, RegExp]> = [
    ['listen(', /\.listen\s*\(/],
    ['createServer', /\bcreateServer\s*\(/],
    ['import from \'vite\'', /from\s+['"]vite['"]/],
    ['import \'@hono/node-server\'', /from\s+['"]@hono\/node-server['"]/],
  ]
  const violators: string[] = []
  // [workspace-guard-v5] 测试文件对 listen/createServer 豁免：本地 stub server（127.0.0.1:0 随机端口）
  //   是验证工具，不构成「宿主服务入口回流 core」（铁律 2 初衷是防生产代码变宿主）。
  //   import vite / @hono/node-server 即使测试里也禁止，故不豁免。
  const STUB_EXEMPT = new Set(['listen(', 'createServer'])
  for (const f of walk(path.join(ROOT, 'packages'))) {
    if (BUILD_CONFIG_EXEMPT.test(rel(f))) continue
    const isTest = /(?:^|\/)tests\/|\.node-test\.ts$/.test(rel(f))
    const txt = fs.readFileSync(f, 'utf8')
    for (const [name, re] of patterns) {
      if (isTest && STUB_EXEMPT.has(name)) continue
      if (re.test(txt)) violators.push(`${rel(f)}: ${name}`)
    }
  }
  assert.deepEqual(violators, [], `以下 packages 文件违反铁律 2:\n${violators.join('\n')}`)
})

it('铁律 3: packages/client 不得 import packages/core', () => {
  const violators: string[] = []
  // [guard-regex-pkgname-v1] 包别名是 @qgm/core（旧名 @qgm/ai-runner-core 已不存在，
  //   写旧名会让 `import ... from '@qgm/core'` 这类违规从铁律 3 下漏过）
  const re = /from\s+['"][^'"]*(?:@qgm\/core|packages\/core|\.\.\/core)[^'"]*['"]/
  for (const f of walk(path.join(ROOT, 'packages', 'client'))) {
    const txt = fs.readFileSync(f, 'utf8')
    if (re.test(txt)) violators.push(rel(f))
  }
  assert.deepEqual(violators, [], `以下 client 文件引用了 core:\n${violators.join('\n')}`)
})

it('workspace: 四包目录齐备', () => {
  const required = [
    'packages/core/package.json',
    'packages/client/package.json',
    'apps/vite-plugin/package.json',
    'apps/standalone/package.json',
  ]
  for (const p of required) {
    assert.ok(fs.existsSync(path.join(ROOT, p)), `缺失 ${p}`)
  }
})

it('workspace: 宿主专属入口必须位于 apps，不得回流 core', () => {
  // [workspace-guard-v3] packages/core/src/index.ts 是合法公开 barrel，不在禁止之列
  const forbidden = [
    'packages/core/src/server/core.ts',
    'packages/core/src/server/ws-server.ts',
    'packages/core/src/server/vite.config.ts',
  ]
  const back = forbidden.filter(p => fs.existsSync(path.join(ROOT, p)))
  assert.deepEqual(back, [], `以下宿主文件回流到 core:\n${back.join('\n')}`)
})
