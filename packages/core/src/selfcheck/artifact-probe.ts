// [selfcheck-l2-b1-v1] B1 产物反查：源码特征串必须出现在编译产物中
// [WHY] 期一 L0 只证源码改动真实；B1 为「产物 = 源码」提供证据。
// [CONSTRAINT] 映射不到产物 / 抽不出稳定串 / 产物不可读 → skipped，不判 fail（缺证据不拦）。
//
// [selfcheck-l2-b1-v2] A 侧复核修正（2026-10-05，三处实测缺陷）：
//   ① [语义] 本仓库守则明确「**AI 不自行 build/重启，rebuild 归宿主侧**」
//      ⇒「产物没命中新特征串」只意味着「还没 rebuild」，**不等于 AI 造假**。
//      实测：本工单自己的产物比源码旧 11 分钟（bundle 06:35 / 源码 06:46），若按原实现
//      判 fail，则**每一次正常 DONE 都必被拒 → 熔断**（与期一 `5s < 12s` 同族）。
//      现：默认降级为 `[warn]`（计入 degraded，不拦）；只有 DONE **声称已重建产物**
//      而实测产物陈旧/未命中时，才升级为 `[fail]` —— 那才是造假判据。
//   ② [映射] 原实现只映射 `packages/core/src → packages/core/dist`，而**服务实际运行的是
//      `apps/standalone/dist/_server/index.js` bundle**，client 改动更是完全无映射（恒 skipped）
//      ⇒ 判据空转。现同时查 bundle 与 tsc 产物，client 侧查 `apps/standalone/dist/client/assets`。
//   ③ [范围] 由调用方传入 DONE 声称集（原实现拿整个工作区 190+ 项，噪音大且与本轮无关）。
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'
import type { CheckItem } from './executor.js'

/** 客户端 SPA 产物目录（多 chunk，需目录级检索） */
const CLIENT_ASSETS = 'apps/standalone/dist/client/assets'
/** SSR 服务端 bundle（core/apps 的真正运行产物） */
const SERVER_BUNDLE = 'apps/standalone/dist/_server/index.js'
/** 单文件检索上限，防目录级读取过大（assets 全量约数 MB，留足余量） */
const MAX_ARTIFACT_BYTES = 40 * 1024 * 1024

/**
 * 源码路径 → 候选产物路径列表（可能多个：bundle 与 tsc 产物任一命中即算命中）
 * 映射不到返回空数组（触发 skipped）
 */
export function artifactCandidates(srcPath: string): string[] {
  const p = String(srcPath || '').replace(/\\/g, '/')
  if (p.startsWith('packages/core/src/') && /\.tsx?$/.test(p)) {
    const tscOut = p.replace('packages/core/src/', 'packages/core/dist/').replace(/\.tsx?$/, '.js')
    return [tscOut, SERVER_BUNDLE]
  }
  if (p.startsWith('packages/client/') && /\.(?:ts|vue)$/.test(p)) return [CLIENT_ASSETS]
  if (p.startsWith('apps/standalone/src/')) return [SERVER_BUNDLE]
  return []
}

/** 兼容旧名（期二首版导出名，守卫测试在用） */
export function mapToArtifact(srcPath: string): string | null {
  const c = artifactCandidates(srcPath)
  return c.length ? c[0] : null
}

/** 读产物内容：文件直接读；目录则拼接其下全部 .js（跳过 .br/.gz 压缩件） */
function readArtifact(rel: string): string | null {
  const abs = path.join(getRoot(), rel)
  let st: fs.Stats
  try { st = fs.statSync(abs) } catch { return null }
  try {
    if (st.isFile()) return fs.readFileSync(abs, 'utf8')
    if (!st.isDirectory()) return null
    const parts: string[] = []
    let total = 0
    for (const name of fs.readdirSync(abs)) {
      if (!name.endsWith('.js')) continue
      const one = fs.readFileSync(path.join(abs, name), 'utf8')
      total += one.length
      parts.push(one)
      if (total > MAX_ARTIFACT_BYTES) break
    }
    return parts.length ? parts.join('\n') : null
  } catch { return null }
}

/**
 * 从源码抽 1～2 个稳定特征串（导出标识符）
 * [CONSTRAINT] bundle 不做顶层重命名（实测 `reconcileChanges` 等名可原样搜到），故导出名是稳定串；
 *   抽不出（纯 .vue / 无导出）返回空数组 → skipped
 */
export function extractFeatureStrings(source: string): string[] {
  const text = String(source || '')
  const out: string[] = []
  const re = /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push(m[1])
    if (out.length >= 2) break
  }
  return out
}

export interface ProbeOpts {
  /** DONE 声称已重建产物：产物陈旧/未命中 → fail（造假）；否则只 warn */
  enforceFresh?: boolean
}

function skip(id: string, why: string): CheckItem {
  return { id, level: 'L2', ok: true, actual: '无法判定', expected: '跳过', details: [`[skipped] ${why}`] }
}

/** 单文件反查 */
export function probeOne(srcPath: string, opts: ProbeOpts = {}): CheckItem {
  const id = `B1-${srcPath}`
  const candidates = artifactCandidates(srcPath)
  if (!candidates.length) return skip(id, `${srcPath} 无编译产物映射`)
  let src = ''
  try { src = fs.readFileSync(path.join(getRoot(), srcPath), 'utf8') } catch { return skip(id, '源文件不可读') }
  const features = extractFeatureStrings(src)
  if (!features.length) return skip(id, '源码抽不出导出标识符')

  const arts: Array<{ rel: string, body: string }> = []
  for (const c of candidates) {
    const body = readArtifact(c)
    if (body !== null) arts.push({ rel: c, body })
  }
  if (!arts.length) return skip(id, `产物不存在（${candidates.join(' / ')}）`)

  const miss = features.filter(s => !arts.some(a => a.body.includes(s)))
  if (!miss.length) {
    return {
      id,
      level: 'L2',
      ok: true,
      actual: '全部命中',
      expected: '产物命中全部特征串',
      details: [`[info] 命中产物: ${arts.map(a => a.rel).join(' / ')}`],
    }
  }
  const detail = `产物未命中: ${miss.join(', ')}（候选: ${arts.map(a => a.rel).join(' / ')}）`
  if (opts.enforceFresh) {
    return {
      id,
      level: 'L2',
      ok: false,
      actual: `缺 ${miss.length} 串`,
      expected: '声称已重建 → 产物必须命中',
      details: [`[fail] DONE 声称已重建产物，但 ${detail}`],
    }
  }
  // [selfcheck-l2-b1-warn-v2] 默认只提示：rebuild 归宿主侧，未重建 ≠ 造假
  return {
    id,
    level: 'L2',
    ok: true,
    actual: `缺 ${miss.length} 串（未重建）`,
    expected: '产物命中（rebuild 归宿主侧）',
    details: [`[warn] ${detail}`],
  }
}

/** 批量反查；srcs 应为 DONE 声称集（已由调用方过滤） */
export function probeArtifacts(srcs: string[], opts: ProbeOpts = {}): CheckItem[] {
  const list = (srcs || []).filter(f => /\.(?:ts|tsx|vue)$/.test(f) && artifactCandidates(f).length)
  if (!list.length) return []
  return list.map(f => probeOne(f, opts))
}
