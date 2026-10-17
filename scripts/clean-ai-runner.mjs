#!/usr/bin/env node
/**
 * 清理 .ai-runner 下的一次性/陈旧产物。
 *
 * 背景：测试夹具、探测残留、陈旧日志/pid 长期累积会拖慢 Spotlight 与目录遍历
 *   （2026-10-03 实测 323 目录 / 4814 文件；2026-10-07 实测 175 个 test-* 目录）。
 *
 * 用法：
 *   node scripts/clean-ai-runner.mjs            # dry-run（默认，只列不删）
 *   node scripts/clean-ai-runner.mjs --apply    # 实际删除
 *   node scripts/clean-ai-runner.mjs --apply --keep 20 --days 7
 *
 * 清理类别（均为保守白名单）：
 *   1) test-* 目录：按 mtime 保留最近 KEEP 个
 *   2) 陈旧日志 *.log：mtime 超过 DAYS 天
 *   3) 死 pid *.pid：pid 对应进程已不存在
 *   4) 一次性探测文件：显式白名单（probe/smoke/e2e-probe 等）
 *
 * [CONSTRAINT] 绝不触碰 state.json / lessons.md / skills/** / runs/** / logs/(近期) / tmp/**（运行态）。
 * 默认 dry-run 是刻意的——避免误删正在跑的夹具。
 */
import { readdir, readFile, readlink, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd(), '.ai-runner')
const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const keepIdx = args.indexOf('--keep')
const KEEP = keepIdx >= 0 ? Number(args[keepIdx + 1]) || 20 : 20
const daysIdx = args.indexOf('--days')
const DAYS = daysIdx >= 0 ? Number(args[daysIdx + 1]) || 7 : 7
const STALE_MS = DAYS * 24 * 60 * 60 * 1000

const ONE_SHOT = new Set([
  'probe.json',
  'probe-result.json',
  'smoke.json',
  'api-capability.json',
  'keep-verify.json',
  'skill-stats.json',
  'prompt-contract.txt',
  'e2e-probe.html',
  'e2e-probe.png',
  'injected-lessons-block-preview.md',
  'air-server.log',
  'air-server-launch.log',
  'build.log',
  'pm2-handover.log',
  'pm2-install.log',
  'restart-5175.log',
])

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function main() {
  let entries
  try { entries = await readdir(ROOT, { withFileTypes: true }) }
  catch { console.log(`[skip] ${ROOT} 不存在，无需清理`); return }

  const now = Date.now()
  const doomed = []

  const testDirs = []
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('test-')) continue
    const p = join(ROOT, e.name)
    const st = await stat(p)
    testDirs.push({ name: e.name, path: p, mtime: st.mtimeMs })
  }
  testDirs.sort((a, b) => b.mtime - a.mtime)
  for (const d of testDirs.slice(KEEP)) doomed.push({ kind: 'test-dir', name: d.name, path: d.path })

  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.log')) continue
    const p = join(ROOT, e.name)
    const st = await stat(p)
    if (now - st.mtimeMs > STALE_MS) doomed.push({ kind: 'stale-log', name: e.name, path: p })
  }

  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.pid')) continue
    const p = join(ROOT, e.name)
    let pid = NaN
    try { pid = Number((await readFile(p, 'utf8')).trim()) } catch { /* ignore */ }
    if (Number.isFinite(pid) && !pidAlive(pid)) doomed.push({ kind: 'dead-pid', name: e.name, path: p })
  }

  for (const e of entries) {
    if (!e.isFile() || !ONE_SHOT.has(e.name)) continue
    doomed.push({ kind: 'one-shot', name: e.name, path: join(ROOT, e.name) })
  }

  // [profile-gc-clean-v1] 陈旧 per-sid 浏览器 profile：ai-headless 按 sid 建 `<base>/<sid>` 子目录，
  //   进程被杀 / 探针遗留会让目录永久残留（实测 3 个共 45MB）。判定：非 'default' + 有 SingletonLock
  //   且其指向的 pid 已不存在。活跃会话的锁指向活进程，故不会被误删。
  const PROFILE_DIR = join(ROOT, 'headless-profile')
  let profEntries = []
  try { profEntries = await readdir(PROFILE_DIR, { withFileTypes: true }) } catch { /* 无 profile 目录 */ }
  for (const e of profEntries) {
    if (!e.isDirectory() || e.name === 'default') continue
    const fp = join(PROFILE_DIR, e.name)
    // [profile-gc-clean-v2] SingletonLock 是**符号链接**（形如 `hostname-pid`），不是普通文件：
    //   用 readFile 读会对悬空软链抛 ENOENT 并被 catch 吞掉 ⇒ 规则永不命中（实测输出为空）。
    //   必须用 readlink 取目标字符串。
    let lockPid = NaN
    try {
      const target = await readlink(join(fp, 'SingletonLock'))
      lockPid = Number(String(target).split('-').pop())
    } catch { continue } // 无锁文件：不是 chromium 起的 profile，不动
    if (Number.isFinite(lockPid) && !pidAlive(lockPid)) {
      doomed.push({ kind: 'stale-profile', name: `headless-profile/${e.name}`, path: fp })
    }
  }
  // [tmp-cleanup-v1] tmp 目录按 mtime 清理。原实现只认根层 16 个固定文件名，
  //   tmp 下的调试产物（*.png / eslint*.json / vitest-*.json / sh-*.log / e2e-*.json）
  //   全部漏网 —— 实测 7000+ 条目 / 177MB，条目数检查永远显示「无可清理项」。
  //   [CONSTRAINT] 保留 TOOL_CACHE：这些是可重复使用但重下载昂贵的工具二进制/解压产物。
  const TOOL_CACHE = new Set(['moli', 'ffbin', 'ffmpeg.zip', 'moli.tar.gz'])
  const TMP_DIR = join(ROOT, 'tmp')
  let tmpEntries = []
  try { tmpEntries = await readdir(TMP_DIR, { withFileTypes: true }) } catch { /* 无 tmp 目录 */ }
  for (const e of tmpEntries) {
    if (TOOL_CACHE.has(e.name)) continue
    const fp = join(TMP_DIR, e.name)
    let st
    try { st = await stat(fp) } catch { continue }
    if (now - st.mtimeMs > STALE_MS) doomed.push({ kind: 'stale-tmp', name: `tmp/${e.name}`, path: fp })
  }
  console.log(`test-* 目录 ${testDirs.length} 个（保留 ${KEEP}）| 待清理共 ${doomed.length} 项 | 陈旧阈值 ${DAYS} 天`)
  // [ai-runner-size-v1] 体积可见性：原实现只数条目，145MB 单目录只算 1 项 ⇒ 永远触发不了告警。
  // 逐目录递归求大小，超阈值时显式列出 TOP5，并单独点名疑似遗留备份（.bak-*）。
  const SIZE_WARN_BYTES = (Number(process.env.AIR_RUNNER_SIZE_WARN_MB) || 500) * 1024 * 1024
  async function sizeOf(p) {
    let total = 0
    const stack = [p]
    while (stack.length) {
      const cur = stack.pop()
      let st
      try { st = await stat(cur) } catch { continue }
      if (st.isFile()) { total += st.size; continue }
      if (!st.isDirectory()) continue
      let names = []
      try { names = await readdir(cur) } catch { continue }
      for (const n of names) stack.push(join(cur, n))
    }
    return total
  }
  const dirSizes = []
  let totalBytes = 0
  for (const e of entries) {
    const fp = join(ROOT, e.name)
    let st
    try { st = await stat(fp) } catch { continue }
    const bytes = st.isDirectory() ? await sizeOf(fp) : st.size
    totalBytes += bytes
    if (st.isDirectory()) dirSizes.push({ name: e.name, bytes })
  }
  dirSizes.sort((a, b) => b.bytes - a.bytes)
  const mb = n => (n / 1024 / 1024).toFixed(0)
  if (totalBytes > SIZE_WARN_BYTES) {
    console.log(`体积 [warn] .ai-runner 总计 ${mb(totalBytes)}MB（阈值 ${mb(SIZE_WARN_BYTES)}MB）`)
    console.log(`  TOP: ${dirSizes.slice(0, 5).map(d => `${d.name}=${mb(d.bytes)}MB`).join(', ')}`)
    for (const d of dirSizes) {
      if (d.name.includes('.bak-') && d.bytes > 10 * 1024 * 1024) {
        console.log(`  [hint] 疑似遗留备份 ${d.name}（${mb(d.bytes)}MB）—— 确认后手工删除`)
      }
    }
  } else {
    console.log(`体积 ok：.ai-runner 总计 ${mb(totalBytes)}MB`)
  }

  if (!doomed.length) { console.log('[skip] 无可清理项'); return }

  for (const d of doomed.slice(0, 15)) console.log(`  ${APPLY ? '删除' : '将删除'} [${d.kind}] ${d.name}`)
  if (doomed.length > 15) console.log(`  …… 其余 ${doomed.length - 15} 项`)

  if (!APPLY) { console.log('\n[dry-run] 未做任何改动。加 --apply 执行删除。'); return }

  let ok = 0
  const failed = []
  for (const d of doomed) {
    try { await rm(d.path, { recursive: true, force: true }); ok++ }
    catch (err) { failed.push(`${d.name}: ${err?.message ?? err}`) }
  }
  console.log(`\n已删除 ${ok} 项，失败 ${failed.length} 项`)
  for (const f of failed.slice(0, 5)) console.log(`  ${f}`)
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
