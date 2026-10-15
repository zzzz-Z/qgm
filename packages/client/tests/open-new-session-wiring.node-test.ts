// [open-new-session-wiring-v1] 「在新窗口打开」按钮源码契约。
// [WHY] 用户报告的回归：该按钮一度改为 window.open(<工作台自身 URL + ?workspaceId>)
//   ⇒ 点击后不仅打开受控 AI 站点，还多开了一个工作台标签页。正确语义是
//   「在受控 AI 站点窗口里开新会话」，即走 ws.activate(id, { newSession: true })
//   → switchDeepSeekSession(_, true) 把导航目标折叠回站点首页（新对话）。
// [CONSTRAINT] 本判据是纯源码断言（与本仓 ai-window-sid-wiring / aiwin-collapse 同范式），
//   避免 e2e 依赖浏览器环境；真实的点击行为由 playwright 侧另行覆盖。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..', '..')
const LIST_REL = 'packages/client/components/panels/AiWindowList.vue'

test('open-new-session: onOpenNewWindow 不调用 window.open（不新开浏览器标签页）', () => {
  const raw = fs.readFileSync(path.join(ROOT, LIST_REL), 'utf8')
  const fnIdx = raw.indexOf('function onOpenNewWindow')
  assert.ok(fnIdx > 0, '缺少 onOpenNewWindow 函数')
  const fnBody = raw.slice(fnIdx, fnIdx + 1200)
  assert.ok(
    !/window\.open\(/.test(fnBody),
    'onOpenNewWindow 不得调用 window.open —— 会额外打开一个工作台标签页（用户实测回归）',
  )
})

test('open-new-session: onOpenNewWindow 以 newSession:true 激活该工作区（走受控窗口新会话）', () => {
  const raw = fs.readFileSync(path.join(ROOT, LIST_REL), 'utf8')
  const fnIdx = raw.indexOf('function onOpenNewWindow')
  const fnBody = raw.slice(fnIdx, fnIdx + 1200)
  assert.match(fnBody, /useWorkspaces/, 'onOpenNewWindow 应读 useWorkspaces')
  assert.match(
    fnBody,
    /activate\([^)]*newSession\s*:\s*true/,
    'onOpenNewWindow 应以 newSession:true 激活该工作区（否则导航会落到旧会话 URL）',
  )
})
