// @desc 拼回用户脚本：读 packages/core/src/tampermonkey/*.ts，剥离类型后按序组装
// @why 片段是 IIFE 的物理切分而非模块；组装逻辑与守卫共用 scripts/lib/userscript-segments.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildUserscript, readVersion, SEGMENTS, VERSION_PLACEHOLDER, writeVersion } from './lib/userscript-segments.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'packages/core/src/tampermonkey')
const OUT_FILE = join(ROOT, 'scripts/tampermonkey-session-id.user.js')

/** 版本行在产物里的形态；比对时先抹掉它，避免「只差版本」被当成内容变化 */
const VERSION_LINE_RE = /^\/\/ @version\s+\S+$/m

/** 递增 patch 位；1.9.8 → 1.9.9（不解析预发布后缀，非纯数字则原样追加 .1） */
function bumpPatch(v) {
  const parts = String(v).split('.')
  if (parts.length !== 3 || parts.some(p => !/^\d+$/.test(p))) return `${v}.1`
  return `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`
}

const version = readVersion()
const rendered = buildUserscript(SRC_DIR, version)
const prev = (() => { try { return readFileSync(OUT_FILE, 'utf8') } catch { return null } })()

// [userscript-version-auto-bump-v1] 比对时忽略版本行：只改版本不构成「内容变化」，保证收敛。
// [CONSTRAINT] 占位符残留说明注入没生效，必须报错而非静默写出坏产物。
if (rendered.includes(VERSION_PLACEHOLDER)) {
  console.error('[userscript] ✗ 产物仍含版本占位符，注入失败；未写入')
  process.exit(1)
}

const strip = s => (s === null ? null : s.replace(VERSION_LINE_RE, ''))
if (strip(prev) === strip(rendered)) {
  console.log(`[userscript] 内容无变化（版本 ${version}），跳过写入`)
} else {
  const next = bumpPatch(version)
  writeVersion(next)
  const out = buildUserscript(SRC_DIR, next)
  writeFileSync(OUT_FILE, out)
  console.log(`[userscript] 已拼接 ${SEGMENTS.length} 段 → ${out.length} B`)
  console.log(`[userscript] 内容有变：@version ${version} → ${next}（已写入 scripts/tampermonkey-version.json）`)
}
