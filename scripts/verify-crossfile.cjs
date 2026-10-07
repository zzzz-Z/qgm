#!/usr/bin/env node
// @desc: 跨文件一致性守卫——(A) 工单编号唯一性 (B) SSOT 指针失效检测
// @why: 编号靠人眼（近失 WO-06/08）；除 DOCS-INDEX 外所有 md 的相对链接零校验（实测 2 条悬空）。
// [WHY] 编号判定谓词收窄为「首非空行 + | **编号** | 元数据行」——宽谓词产生 13 条交叉引用假重复。
// [CONSTRAINT] --root 可注入，请求期读取，禁模块顶层缓存（否则判据真空，同 WO-08 判据④）。
// [BOUNDARY] 编号只保证不重复，不检跳号/连续；指针只查行内 ](…) 语法，裸路径文本不查。
// [crossfile-export-v1] 抽 runCrossfile(root) 供测试同进程调两次不同 root——CLI 走 main。
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { collectDocs, extractLinks } = require('./lib/docs-scan.cjs')

const WO_RE = /WO-(\d{4})(\d{2})(\d{2})-\d{2,}/g
const META_RE = /^\|\s*\*\*编号\*\*\s*\|/

function resolveRootFromArgs() {
  const i = process.argv.indexOf('--root')
  if (i >= 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1])
  const env = process.env.CROSSFILE_ROOT
  if (env) return path.resolve(env)
  return path.resolve(__dirname, '..')
}

// 去掉围栏代码块与行内代码（示例文本不是真链接）
function stripCode(text) {
  let s = text.replace(/```[\s\S]*?```/g, '')
  s = s.replace(/`[^`\n]*`/g, '')
  return s
}

// 收集自我声明编号：{ file, num, date, line }
function collectDeclared(root, files) {
  const out = []
  for (const rel of files) {
    const abs = path.join(root, rel)
    let text
    try { text = fs.readFileSync(abs, 'utf8') } catch { continue }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      let isFirstNonEmpty = false
      if (i < 5) {
        let anyNonEmptyBefore = false
        for (let j = 0; j < i; j++) { if (lines[j].trim()) { anyNonEmptyBefore = true; break } }
        isFirstNonEmpty = !anyNonEmptyBefore && lines[i].trim().length > 0
      }
      const isMeta = META_RE.test(lines[i])
      if (!isFirstNonEmpty && !isMeta) continue
      WO_RE.lastIndex = 0
      let m
      while ((m = WO_RE.exec(lines[i])) !== null) {
        out.push({ file: rel, num: m[0], date: `${m[1]}-${m[2]}-${m[3]}`, line: i + 1 })
      }
    }
  }
  return out
}

// 纯函数：给定 root 返回检查结果；不写 stdout、不 exit、不缓存
function runCrossfile(root) {
  const files = collectDocs(root)
  const failures = []
  const declared = collectDeclared(root, files)
  const byNum = new Map()
  for (const d of declared) {
    if (!byNum.has(d.num)) byNum.set(d.num, new Set())
    byNum.get(d.num).add(d.file)
  }
  for (const [num, fileSet] of byNum) {
    if (fileSet.size >= 2) failures.push(`编号重复 ${num}：${[...fileSet].join(' / ')}`)
  }
  for (const d of declared) {
    if (!d.file.includes(d.date)) failures.push(`编号日期与文件名不一致 ${d.num} (${d.date}) → ${d.file}`)
  }
  for (const rel of files) {
    const abs = path.join(root, rel)
    let text
    try { text = fs.readFileSync(abs, 'utf8') } catch { continue }
    const stripped = stripCode(text)
    const baseDir = path.dirname(abs)
    for (const link of new Set(extractLinks(stripped))) {
      const p = path.resolve(baseDir, link)
      if (!fs.existsSync(p)) failures.push(`${rel} -> ${link}`)
    }
  }
  return { failures, declaredCount: declared.length, fileCount: files.length }
}

function main() {
  const root = resolveRootFromArgs()
  const r = runCrossfile(root)
  if (r.failures.length) {
    console.error(`✗ 跨文件一致性失败 (${r.failures.length})`)
    r.failures.forEach(f => console.error(`  ${f}`))
    process.exit(2)
  }
  console.log(`✓ 跨文件一致性通过 (${r.declaredCount} 个自我声明编号 / ${r.fileCount} 个文档)`)
}

module.exports = { runCrossfile }

if (require.main === module) main()
