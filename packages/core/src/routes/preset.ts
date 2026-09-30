// [preset-rules-v1] GET /preset/system：返回应用预置 SYSTEM.md（非工作区文件）
// WHY: /files/read 从 getRoot() 读工作区；预置规则必须绕开工作区，否则用户覆盖根 SYSTEM.md 即篡改规则
// CONSTRAINT: 定位方式从 import.meta.url 回溯 rules/SYSTEM.md —— dev(src/routes→src/rules) 与
//             发布(dist/routes→dist/rules) 两态同一相对路径；dist/rules 由 copy-runtime.cjs 复制
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** preset 路由的 Hono 实例 */
export const presetHono = new Hono()

/**
 * 从当前文件位置向上回溯定位 rules/SYSTEM.md
 * @returns 绝对路径；不存在时返回 null（调用方转 404，不抛出以免中断请求）
 */
function resolvePresetSystemPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url))
  let dir = here
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, 'rules', 'SYSTEM.md')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

presetHono.get('/preset/system', (c) => {
  const p = resolvePresetSystemPath()
  if (!p) return c.json({ ok: false, error: 'preset SYSTEM.md not found' }, 404)
  try {
    const content = fs.readFileSync(p, 'utf8')
    return c.json({ ok: true, path: 'SYSTEM.md', content })
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500)
  }
})
