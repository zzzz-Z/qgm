// @desc 按固定顺序拼回 packages/core/src/tampermonkey/*.js → scripts/tampermonkey-session-id.user.js
// @why 用户脚本按职责拆成多段维护，但分发链路（/__ai/userscript/info）只认单文件产物

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'packages/core/src/tampermonkey')
const OUT_FILE = join(ROOT, 'scripts/tampermonkey-session-id.user.js')

/** 拼接顺序即 IIFE 内部声明顺序，改动会破坏闭包作用域：上一段定义的符号下一段才可见 */
const SEGMENTS = ['header', 'channel', 'parse', 'stop', 'dispatch', 'observer', 'dom', 'listener']

const parts = SEGMENTS.map(name => readFileSync(join(SRC_DIR, `${name}.js`), 'utf8'))
const out = parts.join('\n')

const prev = (() => { try { return readFileSync(OUT_FILE, 'utf8') } catch { return null } })()
if (prev === out) {
  console.log('[userscript] 产物无变化，跳过写入')
} else {
  writeFileSync(OUT_FILE, out)
  console.log(`[userscript] 已拼回 ${SEGMENTS.length} 段 → ${out.length} B`)
  console.log('[userscript] ⚠ 内容已变：必须同步递增 @version，否则 Tampermonkey 更新链路静默失效')
}
