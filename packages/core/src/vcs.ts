// [vcs-svn-log-v1] VCS 类型探测 + SVN 提交历史读取（**只读**）。
// [WHY] 主线只认 git：`gitAvailable()` 判 `.git`，非 git 一律落到「`.before` 内容副本」降级
//   （[git-first-rollback-v1]）。那条降级链能回滚、能出单文件 diff，但**看不到提交历史**——
//   `/git/worklog`、`/git/diff` 在非 git 下一律返回「非 git 仓库」。SVN 工作副本恰好整体命中降级，
//   于是「看提交记录 / 每次提交改了哪些文件」在 SVN 下彻底缺失。本模块只补这一段只读能力。
// [CONSTRAINT] 只读：不实现 revert / commit / update 等任何写操作（写仍归人）。
// [CONSTRAINT] 不改动 git 路径的任何行为：git 仓库下 svnLog 直接返回「非 svn 工作副本」。
// [CHANGE-IMPACT] 由 routes/vcs.ts 消费；探针缓存必须按 ROOT 失效（git-runner 的 [root-track-v1] 教训）。

import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './config.js'
import { runProcess } from './process/proc.js'

/** 版本控制类型：git / svn / 无（纯目录） */
export type VcsKind = 'git' | 'svn' | 'none'

/** 一次提交里的单个路径变更 */
export interface SvnPathChange {
  /** 单字符动作：A=新增 M=修改 D=删除 R=替换 */
  action: string
  /** 节点类型：file / dir */
  kind: string
  /** 仓库内绝对路径（含前导 `/`） */
  path: string
}

/** SVN 提交历史条目 */
export interface SvnLogEntry {
  revision: number
  author: string
  /** ISO8601 UTC 原始字符串（如 `2026-10-09T10:55:57.968770Z`），格式化交前端做 */
  date: string
  msg: string
  paths: SvnPathChange[]
}

/** SVN 提交历史读取结果 */
export interface SvnLogResult {
  ok: boolean
  reason?: string
  entries: SvnLogEntry[]
  /** 本次请求的条数上限（已钳位） */
  limit: number
}

/** 单次 svn 调用的输出上限（`-v` 下每条提交含全部路径，条数上限 100 足够） */
const SVN_MAX_OUTPUT_BYTES = 10_000_000
/** svn 调用超时：HTTP 仓库不可达时要能及时失败，不能拖住面板 */
const SVN_TIMEOUT_MS = 20_000
/** 提交历史条数上限（防一次拉过多） */
const MAX_LOG_LIMIT = 100

/**
 * [svn-tls-tolerant-v1] 容忍**具名**的服务器证书缺陷。
 * [WHY] 内网 SVN 常用「裸 IP + 自签 / 非公共 CA」证书，svn CLI 默认一律拒绝：
 *   2026-10-09 在真实工作区实测 —— `svn log` 报 `E170013 Unable to connect …` 伴随
 *   `E230001 Server SSL certificate verification failed: certificate issued for a different
 *   hostname, issuer is not trusted`（同环境 `curl -k` 得 401 ⇒ 网络通，纯证书问题）。
 *   不加此参数，本功能在真实内网仓库上**完全读不出历史**。
 * [CONSTRAINT] 只列 `unknown-ca`/`cn-mismatch`/`expired`，**刻意不含 `other`**：
 *   `other` 会把「证书本身有问题」也一并放行。仅在相应缺陷真的出现时生效，证书正常时是空操作。
 * [安全] 若要恢复严格校验（宁可不读也不容忍），设环境变量 `AI_RUNNER_SVN_STRICT_TLS=1`。
 * [兼容] `--trust-server-cert-failures` 需 svn ≥ 1.9（本机 1.14.5）；更老版本会因未知选项而失败。
 */
function svnTlsArgs(): string[] {
  return process.env.AI_RUNNER_SVN_STRICT_TLS === '1'
    ? []
    : ['--trust-server-cert-failures=unknown-ca,cn-mismatch,expired']
}

/**
 * 以项目根为 cwd 执行 svn 命令。
 * [CONSTRAINT] 不抛错 —— 失败通过返回结构的 code 表达（与 git-runner.run 同一约定）。
 * [WHY] 钉死 `LC_ALL=C`：`--xml` 的标签结构虽与语言无关，但 stderr 文案要被可判读地匹配
 *   （如 `No such revision`），且避免用户 locale 改变 svn 的输出编码。
 *   另加 `--non-interactive`：服务端进程无 TTY，认证/证书提示会让 svn 阻塞到超时，
 *   改为立刻失败（真实原因仍由 stderr 带出，不丢信息）。
 * [CHANGE-IMPACT] 只被本模块消费；改签名不影响 git 路径。
 */
async function runSvn(args: string[], timeoutMs = SVN_TIMEOUT_MS): Promise<{ code: number, stdout: string, stderr: string }> {
  const proc = await runProcess('svn', {
    args: ['--non-interactive', ...svnTlsArgs(), ...args],
    cwd: ROOT,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    timeoutMs,
    timeoutLabel: 'svn 超时',
    maxOutputBytes: SVN_MAX_OUTPUT_BYTES,
  })
  return { code: proc.code, stdout: proc.stdout, stderr: proc.stderr }
}

/** svn 可用性缓存；null 表示尚未探测 */
let cachedSvn: boolean | null = null
// [root-track-v1] 记录上次探测时的 ROOT：setRoot 换工作区后旧缓存必须失效
let cachedSvnRoot: string | null = null

/**
 * 向上逐级查找 `.svn`（直至文件系统根）。
 * [WHY] SVN 1.7+ 只在**工作副本根**放 `.svn`，而工作区常常是工作副本根的**子目录**：
 *   2026-10-09 实测真事故 —— 工作区 `…/zcc/业务系统/plus-ui` 的 `.svn` 在祖先
 *   `/Users/apple/zcc/.svn`，原实现只查 `ROOT/.svn` ⇒ 判为非 SVN ⇒ 本功能在真实 SVN 仓库上
 *   完全不生效（前端永远退回「既非 git 也非 svn」）。原测试把 checkout 落在 ROOT，
 *   恰好漏掉了「工作区 ⊂ 工作副本根」这一最常见形态。
 * [CONSTRAINT] 仅作**廉价预筛**（几次 stat），避免在无关项目里 spawn svn；
 *   **权威判定仍是 `svn info`** —— 它按 wc.db 精确回答「本路径是否在被跟踪的工作副本内」：
 *   实测 `/Users/apple/.svn` 存在，但 `/Users/apple/web-ai-qgm` 仍返回 W155010 not found，
 *   故预筛即便过宽（祖先有 .svn）也不会造成误判。
 */
function hasSvnAncestor(start: string): boolean {
  let d = start
  for (;;) {
    if (fs.existsSync(path.join(d, '.svn'))) return true
    const up = path.dirname(d)
    if (up === d) return false
    d = up
  }
}

/**
 * 工作区是否为可用的 SVN 工作副本。
 * [CONSTRAINT] 双确认：祖先链上存在 `.svn`（廉价预筛）**且** `svn info` 成功（权威）——
 *   只看目录会把「残留的空 .svn」误判成工作副本；只看 ROOT 又会漏掉「工作区 ⊂ 工作副本根」。
 */
export async function svnAvailable(): Promise<boolean> {
  if (cachedSvnRoot !== ROOT) { cachedSvn = null; cachedSvnRoot = ROOT }
  if (cachedSvn !== null) return cachedSvn
  if (!hasSvnAncestor(ROOT)) { cachedSvn = false; return false }
  const r = await runSvn(['info', '--show-item', 'revision'])
  cachedSvn = r.code === 0
  return cachedSvn
}

/** VCS 类型缓存（同 svnAvailable 的 ROOT 失效规则） */
let cachedKind: VcsKind | null = null
let cachedKindRoot: string | null = null

/** 探测工作区的版本控制类型：`.git` 优先，其次 SVN，都没有即 none */
export async function vcsKind(): Promise<VcsKind> {
  if (cachedKindRoot !== ROOT) { cachedKind = null; cachedKindRoot = ROOT }
  if (cachedKind !== null) return cachedKind
  if (fs.existsSync(path.join(ROOT, '.git'))) { cachedKind = 'git'; return 'git' }
  cachedKind = (await svnAvailable()) ? 'svn' : 'none'
  return cachedKind
}

const XML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': '\'',
  '&amp;': '&',
}

/**
 * 反转义 XML 实体。
 * [WHY] 单次 `replace` 扫描即可安全处理 `&amp;lt;`：替换结果不会被二次扫描，
 *   因此不需要「必须先换 &amp; 」那类顺序技巧。多轮 replace 反而会把它解成 `<`（错）。
 */
function unescapeXml(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp);/g, m => XML_ENTITIES[m] ?? m)
}

/**
 * 取 `<tag>...</tag>` 的文本内容；自闭合（`<msg/>`）或缺失时返回空串。
 * [CONSTRAINT] `\s*` 不能省：svn 会在部分节点上换行排版。
 */
function tagText(body: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(body)
  return m ? unescapeXml(m[1]) : ''
}

/** 从标签属性串里取某个属性的值（属性顺序不固定，必须单个查找） */
function attrOf(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)
  return m ? m[1] : ''
}

/**
 * 解析 `svn log --xml -v` 输出。
 * [CONSTRAINT] 必须容忍 svn 1.14 的真实排版——这两点都是 2026-10-09 用真实仓库探针实测得到的，
 *   按「属性都在同一行」写的正则会**全空**且不报错（静默失效）：
 *   ① `revision` 属性换行：`<logentry\n   revision="2">`；
 *   ② `<path>` 的 `kind` / `action` / `prop-mods` / `text-mods` **顺序随机**，不能靠固定顺序正则。
 * [CONSTRAINT] 属性值用 `[^>]*` 捕获（含换行）；文本用非贪婪 `[\s\S]*?`。
 */
export function parseSvnLogXml(xml: string): SvnLogEntry[] {
  const out: SvnLogEntry[] = []
  const entryRe = /<logentry\s+revision="(\d+)"\s*>([\s\S]*?)<\/logentry>/g
  let m: RegExpExecArray | null
  while ((m = entryRe.exec(xml)) !== null) {
    const body = m[2]
    const paths: SvnPathChange[] = []
    const pathRe = /<path\b([^>]*)>([\s\S]*?)<\/path>/g
    let p: RegExpExecArray | null
    while ((p = pathRe.exec(body)) !== null) {
      const attrs = p[1]
      paths.push({
        action: attrOf(attrs, 'action'),
        kind: attrOf(attrs, 'kind'),
        path: unescapeXml(p[2]),
      })
    }
    out.push({
      revision: Number(m[1]),
      author: tagText(body, 'author'),
      date: tagText(body, 'date'),
      msg: tagText(body, 'msg'),
      paths,
    })
  }
  return out
}

/**
 * 读取 SVN 提交历史（含每次提交涉及的路径）
 * [WHY] `-v` 才能拿到 changed paths，这是「提交文件」需求的数据源；`--xml` 给出可稳定解析的结构。
 * [CONSTRAINT] 必须显式给 `-r HEAD:1`：`svn log` 不带 `-r` 时从**工作副本 BASE** 回溯，
 *   checkout 后未 update（BASE=r0）会返回空结果且 exit 0 —— 2026-10-09 探针实测踩过，
 *   这种「成功但空」比报错更难排查。用 HEAD 也顺带覆盖「工作副本落后于仓库」的场景。
 * [CONSTRAINT] 空仓库（只有 r0）时 `HEAD:1` 报 E160006 ⇒ 视为「暂无提交」而非失败。
 */
export async function svnLog(opts: { limit?: number } = {}): Promise<SvnLogResult> {
  const raw = Number(opts.limit)
  const limit = Math.min(Math.max(Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20, 1), MAX_LOG_LIMIT)
  if (!(await svnAvailable())) return { ok: false, reason: '非 svn 工作副本', entries: [], limit }

  let r = await runSvn(['log', '--xml', '-v', '-l', String(limit), '-r', 'HEAD:1'])
  if (r.code !== 0 && /No such revision|E160006/i.test(r.stderr)) {
    return { ok: true, entries: [], limit }
  }
  if (r.code !== 0) {
    // 回退：个别 svn 版本 / 访问方式下显式 rev 范围不可用，退回默认范围（此刻 BASE 路径仍可能为空，故只在失败时用）
    r = await runSvn(['log', '--xml', '-v', '-l', String(limit)])
    if (r.code !== 0) {
      return { ok: false, reason: `svn log 失败: ${r.stderr.slice(-300)}`, entries: [], limit }
    }
  }
  return { ok: true, entries: await toWorkspaceRelative(parseSvnLogXml(r.stdout)), limit }
}

/**
 * 工作区在工作副本内的相对 URL 前缀**候选列表**（按 ROOT 失效，规则同 svnAvailable）。
 *  [WHY] 存候选而非单值，是因为两个来源的编码口径不同（2026-10-09 真实仓库实测）：
 *    `svn info --show-item relative-url` 返回**百分号编码**的 URL（`^/%E5%89%8D%E7%AB%AF...`），
 *    而 `svn log --xml` 的 `<path>` 是**已解码的 UTF-8**（`/前端代码/...`）——直接比较永不相等，
 *    非 ASCII 前缀永远裁不掉。故同时保留原文与 `decodeURIComponent` 结果，任一匹配即可裁。
 */
let cachedPrefix: string[] | null = null
let cachedPrefixRoot: string | null = null

/**
 * 取工作区在工作副本内的相对 URL 前缀候选。
 * 例：工作副本根是 `…/zcc`、工作区是 `…/zcc/业务系统/plus-ui` ⇒ 前缀 `/业务系统/plus-ui`；
 * 工作区本身就是工作副本根 ⇒ 空列表（不裁）。
 * [WHY] `svn log -v` 的 `<path>` 是**仓库绝对路径**：实测真实工作区拿到
 *   `/前端代码/业务系统/plus-ui/package.json`，面板每行都要重复长前缀，既难读又丢掉了
 *   「相对工作区」这一最有用的信息。裁前缀后为 `/package.json`。
 * [CONSTRAINT] 纯本地读（`relative-url` 不联网）；取不到时返回空列表（不裁，保持原状）。
 */
async function wcRelativePrefixes(): Promise<string[]> {
  if (cachedPrefixRoot !== ROOT) { cachedPrefix = null; cachedPrefixRoot = ROOT }
  if (cachedPrefix !== null) return cachedPrefix
  const r = await runSvn(['info', '--show-item', 'relative-url'])
  const raw = r.stdout.trim()
  const out = new Set<string>()
  if (r.code === 0 && raw.startsWith('^')) {
    const p = raw.slice(1).replace(/\/+$/, '')
    if (p) {
      out.add(p)
      try { out.add(decodeURIComponent(p)) } catch { /* 非法百分号序列：只用原文，不抛 */ }
    }
  }
  cachedPrefix = [...out]
  return cachedPrefix
}

/** 把仓库绝对路径裁成工作区相对路径（任一前缀都不匹配时原样保留） */
async function toWorkspaceRelative(entries: SvnLogEntry[]): Promise<SvnLogEntry[]> {
  const prefixes = await wcRelativePrefixes()
  if (!prefixes.length) return entries
  return entries.map(e => ({
    ...e,
    paths: e.paths.map((p) => {
      for (const prefix of prefixes) {
        // 边界必须卡在 `/`：prefix=`/a/b` 时 `/a/bc` 不是它的子路径，不能裁
        if (p.path === prefix || p.path.startsWith(`${prefix}/`)) {
          const rest = p.path.slice(prefix.length)
          return { ...p, path: rest === '' ? '/' : rest }
        }
      }
      return p
    }),
  }))
}
