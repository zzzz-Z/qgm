// [site-switch-rules-reset-v1] 切 AI 站点（换服务商）必须清目标工作区「新站点」的首问标记。
// [WHY] 首问状态按 (wsId, modelId) 复合键持久化，命中即硬短路——切站点不清新站点的键，
//   新 AI 上下文将永久收不到 SYSTEM.md（用户实测报告）。
// [site-switch-tab-follow-v1] 2026-10-16 起去整页 reload，改为显式 resetSession + 激活/新开目标 tab。
// [承重] 变异验证：删掉 App.vue onSiteChange 里的 setFirstPromptSent(wsId, v, false) → 用例必红。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..', '..')
const APP_SRC = 'packages/client/App.vue'

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

test('[site-switch-ui-removed-v1] 顶部站点下拉已移除：App.vue 不得再有 site-select / onSiteChange', () => {
  const src = readSrc(APP_SRC)
  // 判据承重：把下拉或 handler 任一加回去，本条必红。
  assert.ok(!/class="site-select"/.test(src), 'App.vue 顶部仍渲染站点下拉（已按需求移除）')
  assert.ok(!/function onSiteChange\s*\(/.test(src), 'App.vue 仍有 onSiteChange handler（已随下拉移除）')
  // 站点切换的职责已由 watch(modelId) → switchSite 承担（见 sessionManager.node-test.ts 的接线断言），
  //   此处只保证 UI 入口不再回来；不得顺手把 setModel/MODELS 解构留在 App.vue 里当死代码。
  assert.ok(!/\bsetModel\b/.test(src), 'App.vue 残留 setModel 死引用')
  assert.ok(!/\bMODELS\b/.test(src), 'App.vue 残留 MODELS 死引用')
})

// [site-select-row-removed-v1] 左侧面板工作区行内的站点下拉也已移除（2026-10-18 用户要求）。
// [WHY] 与顶部下拉同族：行内 select 既是重复入口，又让「矩阵视图」在窄宽度下挤成一列。
//   移除后站点绑定只能由「首次使用该工作区」隐式形成；换站点走顶部切换 / 重开该工作区。
// [承重] 把 <select class="awl-site-select"> 或 onSiteChange 任一加回去，本条必红；
//   同时禁止留下 MODELS / setSession 死引用（Vue <script setup> 里未被模板消费即死代码）。
test('[site-select-row-removed-v1] 工作区行内站点下拉已移除：AiWindowList.vue 不得再有 awl-site-select / onSiteChange', () => {
  // [CONSTRAINT] 必须先剥注释：本组件刻意在注释里复述被删的标识符（记录 WHY），
  //   不剥则断言自绊（AGENTS.md「收尾 residual 断言必须排除注释行」）。
  const src = readSrc('packages/client/components/panels/AiWindowList.vue')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  assert.ok(!/awl-site-select/.test(src), 'AiWindowList.vue 仍渲染行内站点下拉（含样式残留）')
  assert.ok(!/function onSiteChange\s*\(/.test(src), 'AiWindowList.vue 仍有 onSiteChange handler（已随下拉移除）')
  assert.ok(!/选择站点/.test(src), 'AiWindowList.vue 仍残留「选择站点」占位文案')
  assert.ok(!/\bMODELS\b/.test(src), 'AiWindowList.vue 残留 MODELS 死引用（<script setup> 未消费即死代码）')
  assert.ok(!/\bsetSession\b/.test(src), 'AiWindowList.vue 残留 setSession 死引用')
})

// [key-composite-v1] useAiWindow 4 处 firstPromptSent 调用点必须带站点参数（复合键）。
// [site-from-sid-v1] 站点 id 从 activeWinSid / useSid / winSid 反推（modelIdFromSid），不取全局 modelId，
//   否则切工作区换槽位后写的是旧站点的键。
// 判据承重：把任一处的站点参去掉，或退回 _useAiSite().modelId.value，本条必红。
test('key-composite: useAiWindow 4 处 firstPromptSent 调用均带站点参数', () => {
  const src = readSrc('packages/client/composables/ai/useAiWindow.ts')
  // 3 处 set：写 true / false（第二参为 curModel，其定义为 modelIdFromSid(...)）
  const setHits = src.match(/setFirstPromptSent\(wsId, curModel, (?:true|false)\)/g) || []
  // 1 处 get：读（第二参同样为 curModel）
  const getHits = src.match(/getFirstPromptSent\(wsId, curModel\)/g) || []
  assert.equal(setHits.length, 3, `应有 3 处带站点参的 setFirstPromptSent，实际 ${setHits.length}`)
  assert.equal(getHits.length, 1, `应有 1 处带站点参的 getFirstPromptSent，实际 ${getHits.length}`)
  // [site-from-sid-v1] curModel 定义必须来自 modelIdFromSid（3 处 set + 1 处 get 各一次），
  //   不得取全局 modelId —— 判据承重：把任一 curModel 定义改回全局取值，本条必红。
  const defHits = src.match(/const curModel = modelIdFromSid\(/g) || []
  assert.equal(defHits.length, 4, `应有 4 处 curModel = modelIdFromSid(...)，实际 ${defHits.length}`)
  assert.ok(!/setFirstPromptSent\(wsId, (?:true|false)\)/.test(src), '存在回退为两参的调用点')
  assert.ok(!/getFirstPromptSent\(wsId\)/.test(src), '存在回退为单参的调用点')
  // [site-from-sid-v1] 不得回退为从全局 useAiSite().modelId 取站点（切工作区会串键）
  assert.ok(!/_useAiSite\(\)\.modelId\.value/.test(src), '不得从全局 modelId 取站点：切工作区后串键')
  assert.ok(!/_useAiSiteBoot\(\)\.modelId\.value/.test(src), '不得从全局 modelId 取站点：切工作区后串键')
  assert.ok(!/_useAiSiteOpen\(\)\.modelId\.value/.test(src), '不得从全局 modelId 取站点：切工作区后串键')
  assert.ok(!/_useAiSiteRead\(\)\.modelId\.value/.test(src), '不得从全局 modelId 取站点：切工作区后串键')
})
