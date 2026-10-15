// [multi-site-parallel-v1] sid ↔ modelId 双向映射承重测试
// [WHY] 判据必须承重：若 modelIdFromSid 恒返 default，本测试应变红。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { modelIdFromSid, sidForUrl } from '../composables/ai/useAiSite.js'

test('modelIdFromSid 剥离 win_ 前缀', () => {
  assert.equal(modelIdFromSid('win_deepseek'), 'deepseek')
  assert.equal(modelIdFromSid('win_chatglm'), 'chatglm')
  assert.equal(modelIdFromSid('win_qianwen'), 'qianwen')
})

test('modelIdFromSid 空/无前缀回退默认站点', () => {
  assert.equal(modelIdFromSid(''), 'deepseek')
  assert.equal(modelIdFromSid('default'), 'deepseek')
})

test('sidForUrl 按 host 命中站点', () => {
  assert.equal(sidForUrl('https://chat.deepseek.com/'), 'win_deepseek')
  assert.equal(sidForUrl('https://chatglm.cn/main/detail/abc'), 'win_chatglm')
})

test('sidForUrl 未命中 host / 非法 URL 回退', () => {
  assert.equal(sidForUrl('https://unknown.example.com/'), 'win_deepseek')
  assert.equal(sidForUrl('not-a-url'), 'win_deepseek')
})

test('双向互逆：modelIdFromSid(sidForUrl(u)) === 期望 modelId', () => {
  assert.equal(modelIdFromSid(sidForUrl('https://chat.deepseek.com/')), 'deepseek')
  assert.equal(modelIdFromSid(sidForUrl('https://chatglm.cn/')), 'chatglm')
})

// [callDs-naming-v1] 命名契约：callDs(name) 访问 ds[name]，故名字必须是 Impl 后缀。
// [WHY] 实坑：callDs('sendFill') 访问不存在的 ds.sendFill（模块只导出 sendFillImpl）→ 恒 false。
//   本测试固化「短名不存在、Impl 名存在」，防止将来有人把 callDs 改回短名。
test('useAiWindowSend 导出 Impl 后缀名，无短名（callDs 契约）', async () => {
  const mod = await import('../composables/ai/useAiWindowSend.js')
  const keys = Object.keys(mod)
  assert.ok(keys.includes('sendFillImpl'), 'sendFillImpl 应存在')
  assert.ok(keys.includes('sendStopImpl'), 'sendStopImpl 应存在')
  assert.ok(!keys.includes('sendFill'), 'sendFill 短名不应存在——callDs 用短名会恒 false')
  assert.ok(!keys.includes('sendStop'), 'sendStop 短名不应存在')
})
