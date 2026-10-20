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

import { evaluateUserscriptInfo, isNewerVersion } from '../composables/ui/useUserscriptUpdate.js'

const ROOT = process.cwd()
const APP_VUE = 'packages/client/App.vue'
const APP_SCSS = 'packages/client/App.scss'
// [hdr-group-dock-sidepane-v1] 主题/传输链路/更新油猴脚本已从 App.vue 顶部迁入右侧面板底部
const SIDE_VUE = 'packages/client/components/panels/SidePane.vue'

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

// ── 版本比较（[userscript-update-v1] 版本角标的判据）────────────────────────
// [WHY] 构建会自动递增版本（[userscript-version-inject-v1]），前端靠这个函数决定要不要亮角标。
//   最容易写错的是「按字符串比较」：那样 1.9.10 会被判成小于 1.9.9，角标永远不亮。

it('版本比较：逐段数字比较，1.9.10 比 1.9.9 新（字符串比较会判反）', () => {
  assert.equal(isNewerVersion('1.9.10', '1.9.9'), true)
  assert.equal(isNewerVersion('1.9.9', '1.9.10'), false)
})

it('版本比较：主次位递增也算新', () => {
  assert.equal(isNewerVersion('1.10.0', '1.9.11'), true)
  assert.equal(isNewerVersion('2.0.0', '1.99.99'), true)
})

it('版本比较：相同或本地没有记录/服务端无版本时不得误报', () => {
  assert.equal(isNewerVersion('1.9.11', '1.9.11'), false)
  assert.equal(isNewerVersion(null, '1.9.11'), false)
  assert.equal(isNewerVersion(undefined, '1.9.11'), false)
})

it('版本比较：本地从未记录过 ⇒ 视为有新版本（首次使用应提示一次）', () => {
  assert.equal(isNewerVersion('1.9.11', null), true)
  assert.equal(isNewerVersion('1.9.11', ''), true)
})
// ── 接线结构断言：防「函数写了但按钮没接上」──────────────────────────────────

it('wiring: SidePane.vue 的按钮绑到 onUpdateUserscript，且该函数转发给 updateUserscript', () => {
  const src = read(SIDE_VUE)
  assert.match(src, /@click="onUpdateUserscript"/, '按钮未绑定 handler')
  assert.match(src, /class="userscript-toggle"/, '按钮缺少样式类')
  assert.match(src, /function onUpdateUserscript\(\)[\s\S]{0,300}?updateUserscript\(\)/, 'handler 未转发到 updateUserscript')
  // 已迁入面板：按钮组不再位于 App.vue
  assert.ok(!read(APP_VUE).includes('class="userscript-toggle"'), 'App.vue 仍残留按钮 DOM')
})

it('wiring: SidePane 必须有 .userscript-toggle 样式（不可见等于没做）', () => {
  const scss = read(SIDE_VUE)
  assert.match(scss, /\.userscript-toggle\s*\{/, '缺少按钮基础样式')
  assert.match(scss, /\.userscript-toggle:hover\s*\{/, '缺少 hover 态，header 里会显得像坏掉的控件')
})

// ── 合并结构断言（[hdr-transport-group-v1]，2026-10-09）──────────────────────
// 用户要求把「油猴 / 无头」选择与「更新脚本」按钮合并成同一个分段控件。此处钉住「合并」本身：
// 一旦有人把某个子控件挪出组容器、或让按钮重新长出独立描边（退回两个各自描边的控件），必须变红。

/** 截出 `.transport-switch` 组容器的模板片段（组内无嵌套 div，故首个 `</div>` 即组尾） */
function transportGroupMarkup(): string {
  const src = read(SIDE_VUE)
  const start = src.indexOf('class="transport-switch"')
  assert.ok(start >= 0, '找不到 .transport-switch 组容器')
  const end = src.indexOf('</div>', start)
  assert.ok(end > start, '.transport-switch 组容器未闭合')
  return src.slice(start, end)
}

it('合并：链路选择与更新按钮必须同处一个 .transport-switch 容器（拆开即红）', () => {
  const group = transportGroupMarkup()
  assert.ok(group.includes('class="transport-select"'), '「油猴 / 无头」选择不在组容器内 —— 已退回独立控件')
  assert.ok(group.includes('class="userscript-toggle"'), '更新按钮不在组容器内 —— 已退回独立控件')
  assert.ok(group.includes('transport-sep'), '缺少组内分隔线，两栏会糊在一起')
})

it('合并：组内按钮不得带独立描边/圆角（由分组统一提供，否则是「控件里套控件」）', () => {
  const scss = read(SIDE_VUE)
  assert.match(
    scss,
    /\.side-tools \.userscript-toggle\s*\{[^}]*?border:\s*0/,
    '组内更新按钮未消掉自身描边（.hdr button:not(.btn) 的 !important 会把它重新画出来）',
  )
  assert.match(
    scss,
    /\.side-tools \.userscript-toggle\s*\{[^}]*?border:\s*0/,
    '组内更新按钮未消掉自身圆角',
  )
  assert.match(scss, /\.side-tools \.transport-switch\s*\{[^}]*?overflow:\s*hidden/, '组容器未裁边，内部描边会溢出')
  // 注意：`.transport-switch .transport-sep` 在文件里有两份（旧段 + 权威段），只断言其中一份会空转
  // （删一份另一份仍满足 ⇒ 改坏也不红）。必须锚定**真正生效**的 `.hdr` 权威段。
  assert.match(
    scss,
    /\.side-tools \.transport-sep\s*\{[^}]*?width:\s*1px/,
    '权威段未定义组内分隔线宽度（旧段那一条会被 .hdr 段的 !important 压掉，等于没有分隔线）',
  )
})
