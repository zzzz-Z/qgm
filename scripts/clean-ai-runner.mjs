#!/usr/bin/env node
/**
 * 清理 .ai-runner 下测试夹具留下的临时目录。
 *
 * 背景：部分测试夹具按 `test-<name>-<ts>` 在 .ai-runner/ 下建目录但自己不回收，
 * 长期累积会拖慢 Spotlight 索引与目录遍历（2026-10-03 实测曾达 323 个目录 / 4814 个文件）。
 *
 * 用法：
 *   node scripts/clean-ai-runner.mjs                  # dry-run，只列不删（默认）
 *   node scripts/clean-ai-runner.mjs --apply          # 实际删除
 *   node scripts/clean-ai-runner.mjs --apply --keep 50
 *
 * 行为：只处理名字以 `test-` 开头的目录，按 mtime 保留最近 N 个（默认 20），其余删除。
 * 默认 dry-run 是刻意的——避免误删正在跑的夹具目录。
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd(), '.ai-runner')
const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const keepIdx = args.indexOf('--keep')
const KEEP = keepIdx >= 0 ? Number(args[keepIdx + 1]) || 20 : 20

async function main() {
  let entries
  try {
    entries = await readdir(ROOT, { withFileTypes: true })
  }
  catch {
    console.log(`[skip] ${ROOT} 不存在，无需清理`)
    return
  }

  const dirs = []
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('test-')) continue
    const path = join(ROOT, e.name)
    const st = await stat(path)
    dirs.push({ name: e.name, path, mtime: st.mtimeMs })
  }

  // 新的在前，保留最近 KEEP 个
  dirs.sort((a, b) => b.mtime - a.mtime)
  const doomed = dirs.slice(KEEP)

  console.log(`test-* 目录 ${dirs.length} 个 | 保留最近 ${KEEP} 个 | 待清理 ${doomed.length} 个`)
  if (doomed.length === 0) return

  const preview = doomed.slice(0, 10)
  for (const d of preview) console.log(`  ${APPLY ? '删除' : '将删除'}  ${d.name}`)
  if (doomed.length > preview.length) console.log(`  …… 其余 ${doomed.length - preview.length} 个`)

  if (!APPLY) {
    console.log('\n[dry-run] 未做任何改动。确认无误后加 --apply 执行删除。')
    return
  }

  let ok = 0
  const failed = []
  for (const d of doomed) {
    try {
      await rm(d.path, { recursive: true, force: true })
      ok++
    }
    catch (err) {
      failed.push(`${d.name}: ${err?.message ?? err}`)
    }
  }
  console.log(`\n已删除 ${ok} 个，失败 ${failed.length} 个`)
  for (const f of failed.slice(0, 5)) console.log(`  ${f}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
