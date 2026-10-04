#!/usr/bin/env node
// @desc: 锚点对账——anchors.json 声明的 (file, contains) 必须在磁盘上真实成立
// @why: 文档/索引会腐化；把「代码里必须存在的东西」写成可执行断言，腐化当场变红
// @plan: verify-anchors
// [anchor-suggest-v1] 失败时给出候选路径：历史上 file 字段曾成批写成 client/... 短路径，
//   44 条同时 MISS 而报错只有「文件不存在」，定位成本极高；候选可在失败信息里直接照抄。
'use strict'
const fs = require('node:fs')
const path = require('node:path')

// [ROOT-relative] 约定：anchors.json 的 file 一律是**相对仓库根**的完整路径
const ROOT = path.resolve(__dirname, '..')
const ANCHORS = path.join(ROOT, 'scripts', 'anchors.json')

// 试探用的包根（相对仓库根），顺序即提示优先级。
// 既含两层包根（packages/client），也含一层父根（packages）——后者用于修正「少写一层前缀」的漂移，
// 例如声明 client/types.ts 时正确落点是 packages/client/types.ts。
const BASES = ['packages/core', 'packages/client', 'apps/vite-plugin', 'apps/standalone', 'packages', 'apps']
// basename 兜底搜索时跳过的目录
const SKIP = new Set(['node_modules', 'dist', '.git', '.ai-runner', 'coverage'])
const SUGGEST_CAP = 3
/** 兜底搜索的候选上限，避免失败时全树遍历拖慢 preflight */
const SCAN_CAP = 40

/** 在 dir 下按文件名递归收集候选，达到 SCAN_CAP 即停 */
function collectByBasename(dir, base, out) {
  if (out.length >= SCAN_CAP || !fs.existsSync(dir)) return
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (out.length >= SCAN_CAP) return
    if (SKIP.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collectByBasename(p, base, out)
    else if (e.name === base) out.push(path.relative(ROOT, p))
  }
}

/** 声明路径与候选路径的公共尾部段数；越大越像「同一个文件换了位置」 */
function suffixScore(declared, cand) {
  const a = declared.split('/').reverse()
  const b = cand.split('/').reverse()
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

/**
 * 为一个不存在的 file 猜测它现在可能在哪
 * @param file anchors.json 里声明的路径
 * @returns 候选路径列表（相对仓库根），最多 SUGGEST_CAP 条，按相似度降序
 */
function suggest(file) {
  const hits = []
  // ① 同名相对路径挂在某个包根下（client/x.ts → packages/client/x.ts）
  for (const b of BASES) {
    const cand = path.join(b, file)
    if (fs.existsSync(path.join(ROOT, cand))) hits.push(cand)
  }
  if (hits.length) return hits.slice(0, SUGGEST_CAP)
  // ② 兜底：按 basename 搜索，再按公共尾部段数排序（覆盖重构改名/换目录的情况）
  const found = []
  for (const b of BASES) {
    collectByBasename(path.join(ROOT, b), path.basename(file), found)
    if (found.length >= SCAN_CAP) break
  }
  found.sort((x, y) => { return suffixScore(file, y) - suffixScore(file, x) })
  return found.slice(0, SUGGEST_CAP)
}

function main() {
  if (!fs.existsSync(ANCHORS)) {
    console.error('✗ anchors.json 不存在')
    process.exit(2)
  }
  const { anchors } = JSON.parse(fs.readFileSync(ANCHORS, 'utf8'))
  const missing = []
  const content = []
  for (const a of anchors) {
    const p = path.join(ROOT, a.file)
    if (!fs.existsSync(p)) {
      const sug = suggest(a.file)
      missing.push(`${a.file}${sug.length ? `  → 是否应为 ${sug.join(' / ')}` : ''}`)
      continue
    }
    if (!fs.readFileSync(p, 'utf8').includes(a.contains)) content.push(`${a.file}: 缺少 ${JSON.stringify(a.contains)}`)
  }
  const failures = [...missing, ...content]
  if (failures.length) {
    console.error(`✗ 锚点校验失败 (${failures.length}/${anchors.length})`)
    if (missing.length) {
      console.error(`  -- 文件不存在 (${missing.length})；file 须为相对仓库根的完整路径 --`)
      missing.forEach(f => console.error(`  ${f}`))
    }
    if (content.length) {
      console.error(`  -- 文件在但内容不符 (${content.length})：代码已改，需同步锚点或修正实现 --`)
      content.forEach(f => console.error(`  ${f}`))
    }
    process.exit(2)
  }
  console.log(`✓ 锚点校验通过 (${anchors.length})`)
}

main()
