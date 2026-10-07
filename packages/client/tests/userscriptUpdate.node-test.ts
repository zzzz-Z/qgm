// [userscript-update-v1] 守卫：把服务端元信息 → 「该干什么」的判定钉死。
//
// 为什么值得单独守：这条链路的失败模式全是**沉默**的 —— 端点没起时浏览器只显示「无法连接」，
// 文件缺失时点一下什么都不发生，弹窗被拦时连标签页都没有。用户唯一能看到的信号就是这段判定
// 产出的 toast 文案，所以每个分支都必须给出「原因 + 可执行动作」，且分支之间不得互相串味。
//
// 本文件钉住三件事：
//   ① 四态分流（无效响应 / 文件缺失 / 端点未起 / 正常）各归其位；
//   ② 分层顺序：文件缺失优先于端点未起 —— 否则「脚本没了」会被误报成「端点没起」，用户去重启端点是白费；
//   ③ 接线：App.vue 的按钮真的绑到了这个函数，且样式类存在于 App.scss（按钮不可见等于没做）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { it } from 'vitest'

import { evaluateUserscriptInfo } from '../composables/ui/useUserscriptUpdate.js'

const ROOT = process.cwd()
const APP_VUE = 'packages/client/App.vue'
const APP_SCSS = 'packages/client/App.scss'

/** 读仓库内文件 */
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 一份「一切正常」的服务端响应，用例按需覆盖字段 */
function info(over: Record<string, unknown> = {}): Parameters<typeof evaluateUserscriptInfo>[0] {
  return {
    ok: true,
    exists: true,
    file: 'scripts/tampermonkey-session-id.user.js',
    version: '1.5.0',
    bytes: 39763,
    mtimeMs: 1759000000000,
    servePort: 5178,
    serveAlive: true,
    updateUrl: 'http://127.0.0.1:5178/tampermonkey-session-id.user.js',
    pageUrl: 'http://127.0.0.1:5178/',
    ...over,
  } as Parameters<typeof evaluateUserscriptInfo>[0]
}

it('正常：给出 open 与更新页地址，文案带版本号', () => {
  const d = evaluateUserscriptInfo(info())
  assert.equal(d.action, 'open')
  assert.equal(d.url, 'http://127.0.0.1:5178/tampermonkey-session-id.user.js')
  assert.match(d.message, /1\.5\.0/)
  assert.match(d.message, /Tampermonkey/)
})

it('版本缺失时退化为「未知」，不得拼出 undefined', () => {
  const d = evaluateUserscriptInfo(info({ version: null }))
  assert.equal(d.action, 'open')
  assert.match(d.message, /v未知/)
  assert.doesNotMatch(d.message, /undefined/)
})

it('网络失败（null）：error，且必须说明失败而不是假装成功', () => {
  const d = evaluateUserscriptInfo(null)
  assert.equal(d.action, 'error')
  assert.match(d.message, /失败/)
  assert.equal(d.url, undefined)
})

it('响应 ok 非 true：error，带上服务端给的原因', () => {
  const d = evaluateUserscriptInfo(info({ ok: false, error: 'boom' }))
  assert.equal(d.action, 'error')
  assert.match(d.message, /boom/)
})

it('文件缺失：error，文案给出具体路径，便于用户自己核对', () => {
  const d = evaluateUserscriptInfo(info({ exists: false }))
  assert.equal(d.action, 'error')
  assert.match(d.message, /tampermonkey-session-id\.user\.js/)
})

it('端点未起：warn（不是 error），文案含端口与可复制的启动命令', () => {
  const d = evaluateUserscriptInfo(info({ serveAlive: false }))
  assert.equal(d.action, 'warn', '端点没起是「先启动它」这一可执行动作，不是故障')
  assert.match(d.message, /5178/)
  // [serve-userscript-pm2-v1] 启动命令已从「node .ai-runner/tmp/serve-userscript.mjs」改为
  //   pm2 托管：端点脚本迁到 scripts/（持久目录）并由 ecosystem.config.cjs 常驻。
  assert.match(d.message, /pm2 start ecosystem\.config\.cjs --only ai-runner-userscript/)
  assert.equal(d.url, undefined)
})

it('分层顺序：文件缺失优先于端点未起（否则用户会被指去重启端点而白费功夫）', () => {
  const d = evaluateUserscriptInfo(info({ exists: false, serveAlive: false }))
  assert.equal(d.action, 'error')
  assert.match(d.message, /未找到/)
})

it('端点未起且端口缺失：文案回落 5178，不得出现 undefined', () => {
  const d = evaluateUserscriptInfo(info({ serveAlive: false, servePort: undefined }))
  assert.match(d.message, /5178/)
  assert.doesNotMatch(d.message, /undefined/)
})

it('存活但地址为空：error（拿到了「可以打开」却没有地址是矛盾态）', () => {
  const d = evaluateUserscriptInfo(info({ updateUrl: '' }))
  assert.equal(d.action, 'error')
  assert.equal(d.url, undefined)
})

// ── 接线结构断言：防「函数写了但按钮没接上」──────────────────────────────────

it('wiring: App.vue 的按钮绑到 onUpdateUserscript，且该函数转发给 updateUserscript', () => {
  const src = read(APP_VUE)
  assert.match(src, /@click="onUpdateUserscript"/, '按钮未绑定 handler')
  assert.match(src, /import \{ updateUserscript \} from '\.\/composables\/ui\/useUserscriptUpdate'/, '未显式导入更新函数')
  assert.match(src, /function onUpdateUserscript\(\)[\s\S]{0,300}?updateUserscript\(\)/, 'handler 未转发到 updateUserscript')
  assert.match(src, /class="userscript-toggle"/, '按钮缺少样式类')
})

it('wiring: App.scss 必须有 .userscript-toggle 样式（不可见等于没做）', () => {
  const scss = read(APP_SCSS)
  assert.match(scss, /\.userscript-toggle\s*\{/, '缺少按钮基础样式')
  assert.match(scss, /\.userscript-toggle:hover\s*\{/, '缺少 hover 态，header 里会显得像坏掉的控件')
})
