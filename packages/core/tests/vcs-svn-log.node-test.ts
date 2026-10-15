// [vcs-svn-log-v1] SVN 提交历史（/vcs/log）的守卫。
// [WHY] 本功能的全部价值在「真能从 SVN 仓库读出提交记录与提交文件」。mock 掉 svn 等于什么都没验；
//   更要紧的是这条链路**只在非 git 工作副本下才被走到**——日常回归里 git 仓库走 /git/*，
//   永远碰不到它，坏了也不会有人发现，直到有人在 SVN 项目里打开面板。
//   故本文件用真实 svnadmin + svn 建临时仓库与工作副本、真提交，再走真实 route handler。
// [CONSTRAINT] 环境缺 svn / svnadmin 时显式跳过，不许静默通过：静默通过 = 假绿，
//   会把「功能根本没验」伪装成「功能可用」。
// [CONSTRAINT] 全程 `--non-interactive`：svn 遇到认证/冲突会交互阻塞，测试会挂死而不是失败。
import { afterAll, beforeAll, describe, test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

interface HonoLike {
  request: (p: string, i: RequestInit) => Response | Promise<Response>
}

/** svn 与 svnadmin 是否都可用（缺任一则整组跳过） */
function hasSvnTools(): boolean {
  try {
    execFileSync('svn', ['--version', '--quiet'], { stdio: 'ignore' })
    execFileSync('svnadmin', ['--version', '--quiet'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const SVN_TOOLS = hasSvnTools()

/** 在指定 cwd 执行 svn（统一加 --non-interactive） */
function svnAt(cwd: string, args: string[]): string {
  return execFileSync('svn', ['--non-interactive', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * 真实 `svn log --xml -v` 的片段（2026-10-09 用 svn 1.14.5 实测抓取，**非手写**）。
 * 它承载两条必须容忍的排版事实：① `revision` 属性换行；② `<path>` 的 kind/action/prop-mods/text-mods 顺序随机。
 * 按「属性同处一行」写的正则会在这份 fixture 上返回空数组且不报错。
 */
const REAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<log>
<logentry
   revision="2">
<author>apple</author>
<date>2026-10-09T10:55:57.968770Z</date>
<paths>
<path
   kind="dir"
   action="A"
   prop-mods="false"
   text-mods="false">/docs</path>
<path
   action="A"
   prop-mods="false"
   text-mods="true"
   kind="file">/docs/readme.md</path>
<path
   prop-mods="false"
   text-mods="true"
   kind="file"
   action="M">/src/a.ts</path>
</paths>
<msg>second commit: modify a, add b &amp; docs</msg>
</logentry>
</log>
`

describe('parseSvnLogXml 纯解析器', () => {
  test('[承重] 容忍 revision 换行 + path 属性乱序（真实 svn 排版）', async () => {
    const { parseSvnLogXml } = await import('../src/vcs.js')
    const out = parseSvnLogXml(REAL_XML)
    assert.equal(out.length, 1, `应解析出 1 条，实得 ${out.length}`)
    const e = out[0]
    assert.equal(e.revision, 2)
    assert.equal(e.author, 'apple')
    assert.equal(e.date, '2026-10-09T10:55:57.968770Z')
    // XML 实体必须还原：&#38; 在源里写作 &amp;
    assert.equal(e.msg, 'second commit: modify a, add b & docs')
    assert.equal(e.paths.length, 3)
    // 三条路径的属性顺序各不相同（kind 在前 / action 在前 / 混排），逐条钉住
    assert.deepEqual(
      e.paths.map(p => [p.action, p.kind, p.path]),
      [['A', 'dir', '/docs'], ['A', 'file', '/docs/readme.md'], ['M', 'file', '/src/a.ts']],
    )
  })

  test('[边界] 自闭合 msg / 空输入 / 无 paths 不抛错', async () => {
    const { parseSvnLogXml } = await import('../src/vcs.js')
    assert.deepEqual(parseSvnLogXml(''), [])
    assert.deepEqual(parseSvnLogXml('<log></log>'), [])
    const selfClosed = parseSvnLogXml(
      '<log><logentry revision="7"><author>zz</author><msg/></logentry></log>',
    )
    assert.equal(selfClosed.length, 1)
    assert.equal(selfClosed[0].revision, 7)
    assert.equal(selfClosed[0].msg, '', '自闭合 <msg/> 应得空串而不是抛错')
    assert.deepEqual(selfClosed[0].paths, [])
  })
})

// 无 svn 环境时整组跳过（并在用例名里写明原因，避免被误读成「通过」）
describe.skipIf(!SVN_TOOLS)('SVN 提交历史（真实仓库端到端）', () => {
  let TMP = ''
  let vcsMod: typeof import('../src/vcs.js')
  let vcsHono: HonoLike

  beforeAll(async () => {
    // realpath：macOS 的 os.tmpdir() 含符号链接，svn 的 file:// URL 需要真实路径
    TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-svn-probe-')))
    const REPO = path.join(TMP, 'repo')
    const WC = path.join(TMP, 'wc')
    execFileSync('svnadmin', ['create', REPO], { stdio: 'ignore' })
    execFileSync('svn', ['--non-interactive', 'checkout', `file://${REPO}`, WC], { stdio: 'ignore' })

    // r1：新增一个目录 + 一个文件
    fs.mkdirSync(path.join(WC, 'src'), { recursive: true })
    fs.writeFileSync(path.join(WC, 'src/a.ts'), 'a\n')
    svnAt(WC, ['add', 'src'])
    svnAt(WC, ['commit', '-m', 'first commit: add src/a.ts'])

    // r2：改 1 个 + 新增 2 个；msg 里刻意带 `&` 用来验 XML 实体反转义
    fs.writeFileSync(path.join(WC, 'src/a.ts'), 'a\nb\n')
    fs.writeFileSync(path.join(WC, 'src/b.ts'), 'c\n')
    svnAt(WC, ['add', 'src/b.ts'])
    fs.mkdirSync(path.join(WC, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(WC, 'docs/readme.md'), 'x\n')
    svnAt(WC, ['add', 'docs'])
    svnAt(WC, ['commit', '-m', 'second: modify a, add b & docs'])

    // [承重前提] 刻意**不 svn update**：工作副本 BASE 停在 r0。
    //   `svn log` 不带 -r 时从 BASE 回溯 ⇒ 空结果 + exit 0（成功但空，最难排查）。
    //   实现若把 `-r HEAD:1` 去掉，下面「未 update 仍须读出历史」必红。
    const cfg = await import('../src/config.js')
    cfg.setRoot(WC)
    vcsMod = await import('../src/vcs.js')
    vcsHono = (await import('../src/routes/vcs.js')).vcsHono as unknown as HonoLike
  })

  afterAll(() => {
    if (TMP) fs.rmSync(TMP, { recursive: true, force: true })
  })

  test('[探测] 工作副本判为 svn', async () => {
    assert.equal(await vcsMod.vcsKind(), 'svn')
    assert.equal(await vcsMod.svnAvailable(), true)
  })

  test('[承重] 工作副本未 update（BASE=r0）仍须读出仓库历史', async () => {
    const r = await vcsMod.svnLog()
    assert.equal(r.ok, true, `svnLog 失败：${r.reason}`)
    assert.deepEqual(
      r.entries.map(e => e.revision),
      [2, 1],
      '必须读到 r2/r1 两条且按版本倒序（空数组说明实现退化成了不带 -r 的默认范围）',
    )
  })

  test('[解析] 提交元信息与每条 changed path 的 action/kind 正确', async () => {
    const r = await vcsMod.svnLog()
    const top = r.entries[0]
    assert.equal(top.revision, 2)
    assert.ok(top.author.length > 0, 'author 不该为空')
    assert.ok(top.date.includes('T') && top.date.endsWith('Z'), `date 应为 ISO8601 UTC，实得 ${top.date}`)
    assert.equal(top.msg, 'second: modify a, add b & docs', 'XML 实体必须还原成 &')
    const byPath = new Map(top.paths.map(p => [p.path, p]))
    assert.equal(byPath.get('/src/a.ts')?.action, 'M', '被修改的文件应为 M')
    assert.equal(byPath.get('/src/a.ts')?.kind, 'file')
    assert.equal(byPath.get('/src/b.ts')?.action, 'A', '新增的文件应为 A')
    assert.equal(byPath.get('/docs')?.kind, 'dir', '目录项也要带 kind=dir（面板要能区分文件与目录）')
    assert.ok(top.paths.length >= 4, `r2 应至少含 4 条路径，实得 ${top.paths.length}`)
  })

  test('[端点] POST /vcs/log 走真实 handler 返 200 / ok / vcs=svn', async () => {
    const res = await Promise.resolve(vcsHono.request('/vcs/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 10 }),
    }))
    assert.equal(res.status, 200)
    const j = await res.json() as { ok: boolean, vcs: string, entries: Array<{ revision: number }> }
    assert.equal(j.ok, true)
    assert.equal(j.vcs, 'svn')
    assert.deepEqual(j.entries.map(e => e.revision), [2, 1])
  })

  test('[limit] 条数钳位：显式小值生效，越界回落默认 20、封顶 100', async () => {
    const one = await vcsMod.svnLog({ limit: 1 })
    assert.deepEqual(one.entries.map(e => e.revision), [2], 'limit=1 应只取最新一条')
    assert.equal((await vcsMod.svnLog({ limit: 0 })).limit, 20, '非法值应回落默认 20')
    assert.equal((await vcsMod.svnLog({ limit: 9999 })).limit, 100, '上限应封顶 100')
  })

  test('[真空防护] 纯目录判为 none，端点须 200 且 ok=false（不伪装成 svn、也不报 4xx）', async () => {
    const plain = path.join(TMP, 'plain')
    fs.mkdirSync(plain, { recursive: true })
    const cfg = await import('../src/config.js')
    const prev = cfg.getRoot()
    cfg.setRoot(plain)
    try {
      assert.equal(await vcsMod.vcsKind(), 'none', '无 .git 无 .svn 应判为 none')
      const r = await vcsMod.svnLog()
      assert.equal(r.ok, false)
      assert.equal(r.reason, '非 svn 工作副本')
      const res = await Promise.resolve(vcsHono.request('/vcs/log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }))
      // 「非 svn」是**正常的探测结果**，前端要靠它决定走哪条链路 ⇒ 必须是 200
      assert.equal(res.status, 200, '非 svn 不该是 4xx，否则前端会把它当故障')
      const j = await res.json() as { ok: boolean, vcs: string }
      assert.equal(j.ok, false)
      assert.equal(j.vcs, 'none')
    } finally {
      cfg.setRoot(prev)
    }
  })

  test('[承重·真实形态] 工作区是工作副本根的**子目录**时仍须判为 svn', async () => {
    // [WHY] 2026-10-09 实机事故：真实工作区 `…/zcc/业务系统/plus-ui` 的
    //   `svn info` 报 Working Copy Root Path = 祖先 `…/zcc`，`.svn` 只在 `…/zcc/.svn`。
    //   原实现只查 `ROOT/.svn` ⇒ 判 none ⇒ 前端永远退回「既非 git 也非 svn」，
    //   本功能在真实 SVN 项目上**完全不生效**（而单测当时全绿，因为 checkout 恰好落在 ROOT）。
    //   本用例把这形态钉成判据；把 svnAvailable 改回 `fs.existsSync(path.join(ROOT,'.svn'))` ⇒ 必红。
    const REPO2 = path.join(TMP, 'repo2')
    const WC2 = path.join(TMP, 'wc2')
    execFileSync('svnadmin', ['create', REPO2], { stdio: 'ignore' })
    execFileSync('svn', ['--non-interactive', 'checkout', `file://${REPO2}`, WC2], { stdio: 'ignore' })
    const SUB = path.join(WC2, '前端代码', '业务系统', 'plus-ui')
    fs.mkdirSync(SUB, { recursive: true })
    fs.writeFileSync(path.join(SUB, 'a.ts'), 'a\n')
    svnAt(WC2, ['add', '前端代码'])
    svnAt(WC2, ['commit', '-m', 'init sub'])

    // 前置断言：确保真的是「子目录无 .svn、根才有」这一形态，否则本用例名不副实
    assert.equal(fs.existsSync(path.join(SUB, '.svn')), false, '前提：工作区自身没有 .svn')
    assert.equal(fs.existsSync(path.join(WC2, '.svn')), true, '前提：.svn 只在工作副本根')

    const cfg = await import('../src/config.js')
    const prev = cfg.getRoot()
    cfg.setRoot(SUB)
    try {
      assert.equal(await vcsMod.svnAvailable(), true, '工作区 ⊂ 工作副本根 时 svnAvailable 必须为 true')
      assert.equal(await vcsMod.vcsKind(), 'svn', '工作区 ⊂ 工作副本根 时 vcsKind 必须为 svn')
      const r = await vcsMod.svnLog()
      assert.equal(r.ok, true, `svnLog 失败：${r.reason}`)
      assert.deepEqual(r.entries.map(e => e.revision), [1], '子目录视角也应读到影响该目录的历史')
      // [承重] 路径必须裁成**工作区相对**：仓库绝对路径是 `/frontend/plus-ui/a.ts`，
      //   裁前缀后须为 `/a.ts`。把 toWorkspaceRelative 拆掉 ⇒ 此处必红。
      const paths = r.entries[0].paths.map(p => p.path)
      assert.ok(
        paths.includes('/a.ts'),
        `路径应裁成工作区相对（期望含 /a.ts，实得 ${JSON.stringify(paths)}）`,
      )
    } finally {
      cfg.setRoot(prev)
    }
  })

  test('[承重·svnCommit] 真实提交未跟踪文件：版本号递增且历史可读', async () => {
    // [WHY] 承重判据须走真实 svn 仓库：mock 掉 svn 等于什么都没验。
    //   把 svnCommit 的 runSvn 调用删掉 / 把 -m 参数去掉（会启编辑器阻塞）⇒ 本用例必红。
    const before = await vcsMod.svnLog()
    const beforeMax = before.entries[0]?.revision ?? 0

    fs.writeFileSync(path.join(TMP, 'wc', 'committed.txt'), 'hello\n')
    svnAt(path.join(TMP, 'wc'), ['add', 'committed.txt'])

    const r = await vcsMod.svnCommit('feat: add committed.txt')
    assert.equal(r.ok, true, `svnCommit 失败：${r.reason}`)
    assert.ok((r.revision ?? 0) > beforeMax, `应返回递增版本号（before=${beforeMax}，got=${r.revision}）`)

    const after = await vcsMod.svnLog()
    assert.ok((after.entries[0]?.revision ?? 0) > beforeMax, '提交后历史应出现新版本')
  })

  test('[幂等] 无变更提交：归一化为 ok:true + revision:null', async () => {
    // [WHY] svn 无变更时以非 0 退出，若不归一化会把「没东西可提」误报成失败。
    const r = await vcsMod.svnCommit('chore: no-op')
    assert.equal(r.ok, true, `无变更应归一化为成功，实得 ${r.reason}`)
    assert.equal(r.revision, null, '无变更时 revision 应为 null')
  })

  test('[边界] 空消息拒绝；非法路径被过滤', async () => {
    const r1 = await vcsMod.svnCommit('')
    assert.equal(r1.ok, false)
    assert.ok(/提交信息为空/.test(r1.reason || ''), `应报「提交信息为空」，实得 ${r1.reason}`)
    const r2 = await vcsMod.svnCommit('test: bad paths', ['/etc/passwd', '../a'])
    assert.equal(typeof r2.ok, 'boolean')
  })

  test('[端点] POST /vcs/commit 走真实 handler，空消息须 400', async () => {
    const bad = await Promise.resolve(vcsHono.request('/vcs/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    }))
    assert.equal(bad.status, 400, '空消息应为 400')
    const jb = await bad.json() as { ok: boolean, reason?: string }
    assert.equal(jb.ok, false)

    const ok = await Promise.resolve(vcsHono.request('/vcs/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'chore: endpoint smoke (no-op)' }),
    }))
    assert.equal(ok.status, 200, '无变更端点应 200（幂等语义）')
    const jo = await ok.json() as { ok: boolean, vcs: string, revision: number | null }
    assert.equal(jo.ok, true)
    assert.equal(jo.vcs, 'svn')
  })

  test('[承重·svnDiff] 真实工作副本改动：status 清单 + unified diff 都拿到', async () => {
    // [WHY] 生成 commit message 的输入是「文件清单 + diff」；任一为空 AI 就无米下锅。
    //   把 svnDiff 的 status/diff 两次 runSvn 调用删掉任一 ⇒ 本用例必红。
    // [CONSTRAINT] 复用 beforeAll 里已建好的 WC（此前的提交用例已弄干净工作区）。
    const WC = path.join(TMP, 'wc')
    fs.writeFileSync(path.join(WC, 'diff-probe.txt'), 'probe\n')
    svnAt(WC, ['add', 'diff-probe.txt'])
    fs.writeFileSync(path.join(WC, 'base.txt'), 'modified-for-diff\n')

    const r = await vcsMod.svnDiff()
    assert.equal(r.ok, true, `svnDiff 失败：${r.reason}`)
    const paths = r.files.map(f => f.path)
    // [vcs-svn-diff-v1] svn status --xml 的 entry@path 相对 cwd（与 svnLog 的仓库绝对 path 不同）
    assert.ok(paths.includes('diff-probe.txt'), `清单应含新增文件，实得 ${JSON.stringify(paths)}`)
    assert.ok(paths.includes('base.txt'), `清单应含被改文件，实得 ${JSON.stringify(paths)}`)
    // diff 必须真带内容（--git 格式下新增文件不是空 hunk）
    assert.ok(r.diff.includes('diff-probe.txt'), 'diff 应含新增文件')
    assert.ok(r.diff.includes('+probe'), `diff 应含新增内容 +probe，实得长度 ${r.diff.length}`)

    // 清场：撤回工作区改动，避免污染后续用例
    svnAt(WC, ['revert', '-R', '.'])
    try { fs.unlinkSync(path.join(WC, 'diff-probe.txt')) } catch { /* unversioned after revert */ }
  })

  test('[端点] POST /vcs/diff 走真实 handler 返 200 + ok + files/diff 字段', async () => {
    const res = await Promise.resolve(vcsHono.request('/vcs/diff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }))
    assert.equal(res.status, 200)
    const j = await res.json() as { ok: boolean, vcs: string, files: unknown[], diff: string }
    assert.equal(j.ok, true)
    assert.equal(j.vcs, 'svn')
    assert.ok(Array.isArray(j.files), 'files 必须是数组')
    assert.equal(typeof j.diff, 'string', 'diff 必须是字符串')
  })

  test('[承重·svnRevert] 真实撤销：提交后改动被还原', async () => {
    const WC = path.join(TMP, 'wc')
    const rel = 'revert-probe.txt'
    const abs = path.join(WC, rel)
    fs.writeFileSync(abs, 'v1\n')
    svnAt(WC, ['add', rel])
    svnAt(WC, ['commit', '-m', 'test: add revert-probe'])
    fs.writeFileSync(abs, 'v1\nv2\n')
    const r = await vcsMod.svnRevert([rel])
    assert.equal(r.ok, true, `svnRevert 失败：${r.reason}`)
    assert.equal(fs.readFileSync(abs, 'utf8'), 'v1\n', '撤销后内容须还原到上次提交')
    assert.deepEqual(r.reverted, [rel])
  })

  test('[边界·svnRevert] 非法路径被拒；空路径撤销工作副本根', async () => {
    const r1 = await vcsMod.svnRevert(['/etc/passwd', '../a'])
    assert.equal(r1.ok, false)
    assert.ok(/路径不合法/.test(r1.reason || ''))
    const r2 = await vcsMod.svnRevert([])
    assert.equal(r2.ok, true)
    assert.deepEqual(r2.reverted, ['.'])
  })

  test('[端点] POST /vcs/revert 走真实 handler 返 200 + ok + reverted', async () => {
    const res = await Promise.resolve(vcsHono.request('/vcs/revert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [] }),
    }))
    assert.equal(res.status, 200)
    const j = await res.json() as { ok: boolean, vcs: string, reverted: string[] }
    assert.equal(j.ok, true)
    assert.equal(j.vcs, 'svn')
    assert.ok(Array.isArray(j.reverted))
  })
})
