// [workspace-guide-inplace-v1] 引导页选定目录必须原地切换，不得整页 reload。
// [WHY] reload 是唯一绕过 useWorkspaces.applyRootChanged 的切 root 路径：
//   它靠页面重建兜住模块级缓存（规则 Promise 缓存等），一旦去掉即泄漏到新工作区。
// [承重] 变异验证：把 adopt 改回 window.location.reload() → 用例必红。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'vitest'

const SRC = () => fs.readFileSync(new URL('../components/panels/WorkspaceGuide.vue', import.meta.url), 'utf8')

describe('workspace-guide-inplace-v1：引导页切工作区不得整页 reload', () => {
  it('组件内不得出现 window.location.reload', () => {
    assert.ok(!/location\.reload/.test(SRC()), '引导页仍在 reload：绕过 applyRootChanged，模块级缓存不会失效')
  })

  it('入册+激活必须走 useWorkspaces().register(path, true)', () => {
    const s = SRC()
    assert.ok(/useWorkspaces\(\)\.register\(/.test(s), '未经 useWorkspaces.register：副作用不走单一出口')
    assert.ok(/register\([^)]*,\s*true\s*\)/.test(s), 'register 未传 activate=true：切了目录但不 setRoot')
  })

  it('系统选择器走 pick-path（只取路径），不得调会自行 setRoot 的 /workspace/pick', () => {
    const s = SRC()
    assert.ok(/\/__ai\/workspace\/pick-path/.test(s), '未使用 pick-path')
    assert.ok(!/\/__ai\/workspace\/pick'/.test(s), '仍在调 /workspace/pick：服务端会自行 setRoot 并绕过前端清理')
  })

  it('成功后必须通知父级（ready），否则去掉 reload 后引导页永不消失', () => {
    const s = SRC()
    assert.ok(/defineEmits<\{\s*ready:\s*\[\]\s*\}>/.test(s), '未声明 ready 事件')
    assert.ok(/emit\('ready'\)/.test(s), '未在成功分支 emit ready：hasWorkspace 不会翻转')
    const app = fs.readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
    assert.ok(/<WorkspaceGuide[^>]*@ready=/.test(app), 'App.vue 未接 ready：引导页无法原地消失')
  })
})
