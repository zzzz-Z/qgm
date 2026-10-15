// [fs-watch-v1] 承重判据：噪音排除 / debounce 合并 / 路径归一化 / close 幂等
// [WHY] fs.watch 各平台事件形态不同（macOS 相对路径 vs Linux 绝对路径、目录 vs 文件），
//   测试只断言「最终批次集合」，不断言次数（inotify 天然会多次触发同一文件）。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFsWatcher } from '../src/server/fs-watch.js'

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fs-watch-'))
}

function rmTmp(p: string): void {
  try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* ignore */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** 等待直到 pred 为真或超时（macOS FSEvents 延迟可达 200ms+） */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true
    await sleep(50)
  }
  return pred()
}

describe('[fs-watch-v1] 工作区文件监听', () => {
  it('排除噪音目录（node_modules / .git / dist）', async () => {
    const root = mkTmp()
    const batches: string[][] = []
    const w = createFsWatcher(root, { debounceMs: 80 })
    w.onFilesChanged(p => batches.push(p))
    try {
      fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
      fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
      fs.mkdirSync(path.join(root, 'src'), { recursive: true })
      fs.writeFileSync(path.join(root, 'node_modules', 'a.js'), '1')
      fs.writeFileSync(path.join(root, 'dist', 'b.js'), '1')
      fs.writeFileSync(path.join(root, 'src', 'c.js'), '1')
      await waitFor(() => batches.some(b => b.some(x => x.endsWith('src/c.js'))))
      const all = batches.flat()
      expect(all.some(x => x.includes('node_modules'))).toBe(false)
      expect(all.some(x => x.includes('dist/'))).toBe(false)
      expect(all.some(x => x.endsWith('src/c.js'))).toBe(true)
    } finally { w.close(); rmTmp(root) }
  })

  it('debounce 合并：连写 3 文件在同一批次', async () => {
    const root = mkTmp()
    const batches: string[][] = []
    const w = createFsWatcher(root, { debounceMs: 200 })
    w.onFilesChanged(p => batches.push(p))
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true })
      fs.writeFileSync(path.join(root, 'src', 'x.js'), '1')
      fs.writeFileSync(path.join(root, 'src', 'y.js'), '2')
      fs.writeFileSync(path.join(root, 'src', 'z.js'), '3')
      await waitFor(() => batches.some(b => b.some(x => x.endsWith('src/z.js'))))
      const first = batches[0] || []
      const s = new Set(first.map(x => x.split('/').pop()))
      expect(s.has('x.js')).toBe(true)
      expect(s.has('y.js')).toBe(true)
      expect(s.has('z.js')).toBe(true)
    } finally { w.close(); rmTmp(root) }
  })

  it('路径归一化：回调收到的是 posix 相对路径，不含 root 前缀 / 不含反斜杠', async () => {
    const root = mkTmp()
    const batches: string[][] = []
    const w = createFsWatcher(root, { debounceMs: 80 })
    w.onFilesChanged(p => batches.push(p))
    try {
      fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
      fs.writeFileSync(path.join(root, 'a', 'b', 'deep.js'), '1')
      await waitFor(() => batches.flat().some(x => x.endsWith('a/b/deep.js')))
      const hit = batches.flat().find(x => x.endsWith('a/b/deep.js'))
      expect(hit).toBeTruthy()
      expect(hit!.includes('\\')).toBe(false)
      expect(hit!.startsWith(root)).toBe(false)
      expect(hit!.startsWith('a/b/')).toBe(true)
    } finally { w.close(); rmTmp(root) }
  })

  it('git 监听：.git/index 变动触发 git:changed；非白名单文件不触发', async () => {
    const root = mkTmp()
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    const hits: number[] = []
    const w = createFsWatcher(root)
    w.onGitChanged(() => hits.push(1))
    try {
      fs.writeFileSync(path.join(root, '.git', 'config'), 'x')
      await sleep(200)
      expect(hits.length).toBe(0)
      fs.writeFileSync(path.join(root, '.git', 'index'), 'y')
      await waitFor(() => hits.length > 0, 2000)
      expect(hits.length).toBeGreaterThan(0)
    } finally { w.close(); rmTmp(root) }
  })

  it('close 后不再回调；close 幂等不抛错', async () => {
    const root = mkTmp()
    const batches: string[][] = []
    const w = createFsWatcher(root, { debounceMs: 50 })
    w.onFilesChanged(p => batches.push(p))
    try {
      fs.writeFileSync(path.join(root, 'first.js'), '1')
      await waitFor(() => batches.length > 0)
      const n0 = batches.length
      w.close()
      expect(() => w.close()).not.toThrow()
      fs.writeFileSync(path.join(root, 'second.js'), '2')
      await sleep(300)
      expect(batches.length).toBe(n0)
    } finally { rmTmp(root) }
  })
})
