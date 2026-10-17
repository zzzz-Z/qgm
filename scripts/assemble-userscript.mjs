// @desc 拼回用户脚本：读 packages/core/src/tampermonkey/*.ts，剥离类型后按序组装
// @why 片段是 IIFE 的物理切分而非模块；组装逻辑与守卫共用 scripts/lib/userscript-segments.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildUserscript, SEGMENTS } from './lib/userscript-segments.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'packages/core/src/tampermonkey')
const OUT_FILE = join(ROOT, 'scripts/tampermonkey-session-id.user.js')

const out = buildUserscript(SRC_DIR)

const prev = (() => { try { return readFileSync(OUT_FILE, 'utf8') } catch { return null } })()
if (prev === out) {
  console.log('[userscript] 产物无变化，跳过写入')
} else {
  writeFileSync(OUT_FILE, out)
  console.log(`[userscript] 已拼接 ${SEGMENTS.length} 段 → ${out.length} B`)
  console.log('[userscript] ⚠ 内容已变：必须同步递增 @version，否则 Tampermonkey 更新链路静默失效')
}
