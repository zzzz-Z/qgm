// [shell-blacklist-v3][shell-metachar-teach-v1][patch-diagnostic-v1]
// helpers.cjs 的两条安全边界与一条可诊断性改造：
//   ① `_shellBlacklist` 的 rm 规则原先只在 parts[0] === 'rm' 时生效 → 包一层 sh -c 即漏（真实漏洞）；
//   ② `shell()` 收到含元字符的字符串命令时静默按空白切词跑错（8 条 lessons 记录过此事）；
//   ③ `patchFile` 锚点失配只报次数不报位置（2026-10-05 一条 exit 7 的直接病因）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')
const HELPERS = path.join(ROOT, 'packages', 'core', 'src', 'helpers.cjs')

interface ShellResult { ok: boolean, error?: string, code?: number, hit?: string, hint?: string }
interface PatchResult { ok: boolean, replaced?: number, skipped?: boolean }
interface AiApi {
  shell: (cmd: string | string[], opts?: Record<string, unknown>) => ShellResult
  _shellBlacklist: (parts: string[], flat: string) => string | null
  patchFile: (file: string, anchor: string, replacement: string, opts?: { marker?: string, unique?: boolean }) => PatchResult
}

const require = createRequire(import.meta.url)
require(HELPERS) // helpers.cjs 顶层执行 `global.__AI__ = __AI__`
const AI = (globalThis as unknown as { __AI__: AiApi }).__AI__

/** 复刻 shell() 对命令串的切词方式，直接断言黑名单判定 */
function bl(cmd: string | string[]): string | null {
  const parts = Array.isArray(cmd) ? cmd.map(String) : String(cmd).trim().split(/\s+/)
  return AI._shellBlacklist(parts, parts.join(' '))
}

const CWD0 = process.cwd()
const tmpDirs: string[] = []
afterAll(() => {
  process.chdir(CWD0)
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})
/** 在独立临时目录里执行 fn（patchFile 的 backup/changelog 都落在 cwd 下，必须隔离） */
function inTmp(fn: (dir: string) => void): void {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'qgm-bl-'))
  tmpDirs.push(created)
  process.chdir(created)
  const dir = process.cwd()
  try { fn(dir) } finally { process.chdir(CWD0) }
}
function capture(fn: () => void): string {
  try { fn() } catch (e) { return String((e as Error).message) }
  return ''
}
function detailOf(msg: string): Record<string, unknown> {
  return JSON.parse(msg.slice(msg.indexOf('{'))) as Record<string, unknown>
}

describe('_shellBlacklist: rm 递归强删', () => {
  it('直接形态仍拦', () => {
    expect(bl(['rm', '-rf', '/tmp/x'])).toBe('rm-recursive-force')
    expect(bl(['rm', '-fr', '/tmp/x'])).toBe('rm-recursive-force')
    expect(bl(['rm', '-Rvf', '/tmp/x'])).toBe('rm-recursive-force')
  })

  it('分开旗标 rm -r -f 也拦（新增覆盖）', () => {
    expect(bl(['rm', '-r', '-f', '/tmp/x'])).toBe('rm-recursive-force')
  })

  it('绝对路径 /bin/rm 也拦（旧实现只比 parts[0] 而漏）', () => {
    expect(bl(['/bin/rm', '-rf', '/tmp/x'])).toBe('rm-recursive-force')
  })

  it('包装器形态 sh -c / bash -c 也拦（旧实现的真实漏洞：命中 null）', () => {
    expect(bl(['bash', '-c', 'rm -rf /tmp/x'])).toBe('rm-recursive-force')
    expect(bl(['sh', '-c', '\'rm -rf /\''])).toBe('rm-recursive-force')
    expect(bl('bash -c "rm -rf /tmp/x"')).toBe('rm-recursive-force')
  })

  it('payload 包装器 xargs / sudo 也拦', () => {
    expect(bl(['xargs', 'rm', '-rf', '/tmp/x'])).toBe('rm-recursive-force')
    expect(bl(['sudo', 'rm', '-rf', '/tmp/x'])).toBe('rm-recursive-force')
  })

  it('长选项两种顺序都拦', () => {
    expect(bl(['bash', '-c', 'rm --recursive --force /tmp/x'])).toBe('rm-recursive-force')
    expect(bl(['bash', '-c', 'rm --force --recursive /tmp/x'])).toBe('rm-recursive-force')
  })

  it('递归但无 force 不拦（与旧语义一致，避免误伤 rm -r 目录清理）', () => {
    expect(bl(['rm', '-r', 'somedir'])).toBe(null)
  })

  it('普通命令里出现危险串不算可执行位置 → 放行（避免 grep 搜索词误报）', () => {
    expect(bl(['grep', '-rn', 'rm -rf', 'docs'])).toBe(null)
    expect(bl('grep -rn "rm -rf" docs')).toBe(null)
  })

  it('既有规则不回退', () => {
    expect(bl(['git', 'push', '-f', 'origin', 'main'])).toBe('git-force-push')
    expect(bl(['git', 'reset', '--hard', 'HEAD~1'])).toBe('git-reset-hard')
    expect(bl(['chmod', '-R', '777', '.'])).toBe('chmod-777')
    expect(bl(['ls', '-la'])).toBe(null)
  })
})

describe('shell(): 元字符教学', () => {
  it('字符串命令含管道 → 明确拒绝并给出用法，而不是静默跑错', () => {
    const r = AI.shell('ls | grep x')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('SHELL_METACHAR_UNSUPPORTED')
    expect(r.code).toBe(2)
    expect(String(r.hint)).toContain('sh')
  })

  it('重定向 / 变量 / 引号同样被识别', () => {
    expect(AI.shell('echo hi > out.txt').error).toBe('SHELL_METACHAR_UNSUPPORTED')
    expect(AI.shell('echo $HOME').error).toBe('SHELL_METACHAR_UNSUPPORTED')
    expect(AI.shell('node -e "console.log(1)"').error).toBe('SHELL_METACHAR_UNSUPPORTED')
  })

  it('数组形态不做元字符拒绝（token 是调用方显式给出的）', () => {
    const r = AI.shell(['printf', '%s', '|'])
    expect(r.error).not.toBe('SHELL_METACHAR_UNSUPPORTED')
  })

  it('无元字符的字符串命令正常执行', () => {
    const r = AI.shell('printf ok')
    expect(r.ok).toBe(true)
  })

  it('黑名单优先于元字符教学（危险命令报 SECURITY_BLOCKED 而非用法提示）', () => {
    const r = AI.shell('bash -c "rm -rf /tmp/x"')
    expect(r.error).toBe('SECURITY_BLOCKED')
    expect(r.hit).toBe('rm-recursive-force')
  })
})

describe('patchFile: 锚点失配可诊断', () => {
  it('唯一锚点正常落盘（改造未动成功路径）', () => {
    inTmp((dir) => {
      const f = path.join(dir, 'c.txt')
      fs.writeFileSync(f, 'V1\n', 'utf8')
      const r = AI.patchFile(f, 'V1', 'V2')
      assert.equal(r.ok, true)
      assert.equal(r.replaced, 1)
      assert.equal(fs.readFileSync(f, 'utf8'), 'V2\n')
    })
  })

  it('锚点不存在：报 ANCHOR_NOT_FOUND，并给出「首行在哪几行」', () => {
    inTmp((dir) => {
      const f = path.join(dir, 'a.txt')
      fs.writeFileSync(f, ['alpha', 'beta line', 'gamma'].join('\n'), 'utf8')
      const msg = capture(() => AI.patchFile(f, 'beta line\nNOT PRESENT ANYWHERE', 'ZZZ'))
      expect(msg).toContain('ANCHOR_NOT_FOUND')
      const d = detailOf(msg)
      expect(d.nearLines).toEqual([2])
      expect(String(d.hint)).toContain('readText')
    })
  })

  it('锚点过短：显式给出 ANCHOR_TOO_SHORT 提示', () => {
    inTmp((dir) => {
      const f = path.join(dir, 'b.txt')
      fs.writeFileSync(f, ['alpha', 'beta', 'gamma'].join('\n'), 'utf8')
      const msg = capture(() => AI.patchFile(f, 'zeta', 'ZZZ', { unique: true }))
      expect(msg).toContain('ANCHOR_NOT_FOUND')
      expect(String(detailOf(msg).hint)).toContain('ANCHOR_TOO_SHORT')
    })
  })

  it('锚点不唯一（复刻 exit 7 现场：取文件末尾定长锚点）：列出出现行号', () => {
    inTmp((dir) => {
      const f = path.join(dir, 'd.txt')
      const body = ['const X = 1', 'const X = 1', 'const X = 1'].join('\n')
      fs.writeFileSync(f, body, 'utf8')
      const anchor = body.slice(-10) // 末尾 10 字符在重复行文件里必然多处命中
      const msg = capture(() => AI.patchFile(f, anchor, `${anchor} // patched`, { unique: true }))
      expect(msg).toContain('ANCHOR_NOT_UNIQUE')
      const d = detailOf(msg)
      expect(d.count).toBeGreaterThan(1)
      const at = d.at as { line: number, text: string }[]
      expect(at.length).toBeGreaterThan(1)
      expect(at[0].line).toBe(1)
      expect(at[2].line).toBe(3)
      expect(String(d.hint)).toContain('唯一')
    })
  })

  it('失配时文件保持原样（诊断改造不得引入半写状态）', () => {
    inTmp((dir) => {
      const f = path.join(dir, 'e.txt')
      const before = ['alpha', 'beta', 'gamma'].join('\n')
      fs.writeFileSync(f, before, 'utf8')
      capture(() => AI.patchFile(f, 'nope-not-here-at-all', 'ZZZ', { unique: true }))
      assert.equal(fs.readFileSync(f, 'utf8'), before)
    })
  })
})
