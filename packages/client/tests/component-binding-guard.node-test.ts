// [component-binding-guard-v1] 模板组件「用了但没绑定」守卫：扫描 client 全部 SFC 的 <template>，
// 逐个核对 PascalCase 组件名是否在文件内有绑定（import / const / function / defineOptions.name / 文件名同名）。
// [WHY] 2026-10-09 用户报「TEXT 回答内容被截断 没有显示全」：TextCard 只渲染 12 行预览
//   （TEXT_PREVIEW = { lines: 12, chars: 800 }），而唯一的展开入口 <FoldToggle> 在
//   RoundCard.vue 里**没有任何 import**。本项目没有 unplugin-vue-components、main.ts 也没有
//   app.component() 全局注册（auto-import 只管 composables/utils，不管 components），
//   于是 Vue 把它当未知元素：不报错、不渲染 ⇒ 超阈值卡片永远只有预览、无法展开，静默可见性缺陷。
// [WHY-DETECTOR-NOT-VACUOUS] 这类缺陷的判据必须自己先被证明「抓得住」：T2/T3 用合成 SFC 做正反例，
//   确保扫描器不是恒绿。T4 直接钉死本次回归对象（RoundCard 必须 import FoldToggle），
//   即便将来扫描器被人为放宽，这一条仍会变红。
// [CONSTRAINT] 扫描必须排除 e2e/ 与 tests/：测试自身会写 `<FoldToggle>` 之类的合成样例，否则判据恒假。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 扫描时跳过的目录（含 tests/ 自身：合成样例会污染判据） */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'e2e', 'tests', 'test-results', 'playwright-report', 'coverage', '.vite'])

/** Vue 内置 / 平台保留标签（小写化后比较），不属于「需要绑定」的组件 */
const BUILTIN_TAGS = new Set([
  'component',
  'transition',
  'transitiongroup',
  'keepalive',
  'teleport',
  'suspense',
  'template',
  'slot',
  'fragment',
])

/**
 * 取出 SFC 的模板段
 * [WHY] 不能拿整个文件扫：`<HTMLElement>`、`<string>` 这类 TS 断言/泛型与脚本里字符串中的 HTML
 *   都会命中 PascalCase 正则，造成假阳性（首版脚本实测 17 处假阳性全来自脚本段）。
 * [CONSTRAINT] 模板段 = 首个 `<template` 之后到**最后一个** `</template>` —— 模板内部允许嵌套
 *   `<template v-if>`，故不能用最短匹配。
 */
export function extractTemplate(source: string): string {
  const start = source.indexOf('<template')
  if (start < 0) return ''
  const end = source.lastIndexOf('</template>')
  if (end <= start) return ''
  return source.slice(start, end)
}

/** 收集文件内所有可用作模板组件的顶层绑定名 */
function collectBoundNames(source: string, fileStem: string): Set<string> {
  const bound = new Set<string>([fileStem]) // 组件可递归引用自身
  for (const m of source.matchAll(/^\s*import\s+([\w$]+)\s*(?:,|from)/gm)) bound.add(m[1])
  for (const m of source.matchAll(/^\s*import\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/).pop()
      if (alias && alias.trim()) bound.add(alias.trim())
    }
  }
  for (const m of source.matchAll(/^\s*import\s+\*\s+as\s+([\w$]+)/gm)) bound.add(m[1])
  for (const re of [
    /^\s*(?:const|let|var)\s+([\w$]+)\s*=/gm,
    /^\s*(?:async\s+)?function\s+([\w$]+)/gm,
    /^\s*class\s+([\w$]+)/gm,
    /defineOptions\(\{\s*name:\s*['"]([\w$]+)['"]/g,
  ]) {
    for (const m of source.matchAll(re)) bound.add(m[1])
  }
  return bound
}

/**
 * 找出模板里被引用、但文件内没有任何绑定的 PascalCase 组件名
 * @param relPath 仅用于报告（取文件名作为「自引用」白名单键）
 * @param source SFC 源文本
 */
export function findUnboundComponents(relPath: string, source: string): string[] {
  const tpl = extractTemplate(source).replace(/<!--[\s\S]*?-->/g, '')
  if (!tpl) return []
  const stem = path.basename(relPath).replace(/\.vue$/, '')
  const bound = collectBoundNames(source, stem)
  const used = new Set<string>()
  for (const m of tpl.matchAll(/<([A-Z][A-Za-z0-9]*)/g)) used.add(m[1])
  return [...used].filter(n => !BUILTIN_TAGS.has(n.toLowerCase()) && !bound.has(n)).sort()
}

/** 递归收集 client 下的全部 SFC（跳过产物与测试目录） */
function listSfc(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) listSfc(p, out)
      continue
    }
    if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

const SFC_FILES = listSfc(CLIENT)
const rel = (p: string): string => path.relative(CLIENT, p)

test('T1: 客户端全部 SFC 的模板组件都有绑定（无「用了没导入」的静默死组件）', () => {
  const violations: string[] = []
  for (const f of SFC_FILES) {
    const bad = findUnboundComponents(rel(f), fs.readFileSync(f, 'utf8'))
    if (bad.length) violations.push(`${rel(f)}: ${bad.join(', ')}`)
  }
  assert.deepEqual(
    violations,
    [],
    `以下 SFC 在模板里用了未绑定的组件（Vue 会当未知元素静默不渲染）：\n${violations.join('\n')}`,
  )
})

test('T2: 扫描器不空转 —— 合成「用了未导入」的 SFC 必须被报出', () => {
  const src = [
    '<script setup lang="ts">',
    'import { ref } from \'vue\'',
    'const a = ref(1)',
    '</script>',
    '',
    '<template>',
    '  <div><FoldToggle :expanded="a" /></div>',
    '</template>',
  ].join('\n')
  assert.deepEqual(findUnboundComponents('components/Fake.vue', src), ['FoldToggle'])
})

test('T3: 合成「已导入」的 SFC 不得报出（排除假阳性）', () => {
  const src = [
    '<script setup lang="ts">',
    'import FoldToggle from \'./FoldToggle.vue\'',
    'import { clampTextPreview } from \'../utils/timeline-preview\'',
    '</script>',
    '',
    '<template>',
    '  <FoldToggle :expanded="true" /><SidePane />',
    '</template>',
  ].join('\n')
  // SidePane 未绑定仍应报出；FoldToggle 已导入不得报出
  assert.deepEqual(findUnboundComponents('components/Fake.vue', src), ['SidePane'])
})

test('T4: 回归钉死 —— RoundCard.vue 必须显式 import FoldToggle（折叠入口）', () => {
  const src = fs.readFileSync(path.join(CLIENT, 'components', 'script', 'RoundCard.vue'), 'utf8')
  assert.ok(
    /^\s*import\s+FoldToggle\s+from\s+['"]\.\/FoldToggle\.vue['"]/m.test(src),
    'RoundCard.vue 缺少 FoldToggle 的显式 import：四类卡片的「展开全部」入口会静默消失',
  )
  assert.ok(
    (extractTemplate(src).match(/<FoldToggle/g) || []).length > 0,
    'RoundCard.vue 模板已不再使用 FoldToggle —— 若确为重构，请同步修订本判据',
  )
})
