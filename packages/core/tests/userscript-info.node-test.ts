// [userscript-update-v1] 守卫：工作台的「安装 / 更新油猴脚本」按钮完全依赖本端点的字段契约。
//
// 背景：油猴脚本的 @updateURL / @downloadURL 指向本地分发端点（127.0.0.1:5178），而浏览器读不到
// 本地磁盘路径 —— UI 想「一键更新」就只能从服务端拿元信息 + 端点地址。于是本端点成了 UI 与
// 端点之间的唯一契约面：字段名、端口、URL 末尾的 .user.js 后缀，任何一处漂移都让按钮变成哑弹
// （打开一个新标签页却什么也不发生，且没有任何错误信号）。
//
// 本文件钉住四件事：
//   ① 结构面：/userscript/info 返回 ok/file/servePort/serveAlive/updateUrl 等必备字段，类型正确；
//   ② 语义面：updateUrl 必须以 .user.js 结尾（Tampermonkey 靠后缀识别安装/更新），端口与分发端点一致；
//   ③ 体量面：不得把脚本正文塞进响应（该端点每次点击都会被请求，塞正文等于把 40KB 脚本
//      在 header 每次点击时搬进浏览器内存）；
//   ④ 接线面：路由必须真的挂进 HONO_SUB_APPS / HONO_PREFIXES，且 /userscript 要在
//      WORKSPACE_EXEMPT_PREFIXES 里豁免 —— 否则无工作区时按钮返回 409，用户看到的是「选工作区」
//      这种风马牛不相及的提示。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { it } from 'vitest'

import { HONO_PREFIXES, HONO_SUB_APPS } from '../src/routes/index.js'
import { parseUserscriptVersion, userscriptHono } from '../src/routes/userscript.js'

const ROOT = process.cwd()
const HANDLE_SRC = 'packages/core/src/server/handle.ts'
const USERSCRIPT_REL = 'scripts/tampermonkey-session-id.user.js'
const SERVE_PORT = 5178

/** 读仓库内文件；用显式路径而非 cwd 拼接，避免 cwd 漂移时静默读空 */
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 取一次 /userscript/info 响应体 */
async function fetchInfo(): Promise<Record<string, unknown>> {
  const res = await userscriptHono.request('/userscript/info')
  assert.equal(res.status, 200, '探测类端点不得用非 200 表达「端点没起」——那是字段不是错误')
  return await res.json() as Record<string, unknown>
}

it('结构：/userscript/info 必备字段齐全且类型正确', async () => {
  const j = await fetchInfo()
  assert.equal(j.ok, true)
  assert.equal(j.file, USERSCRIPT_REL)
  assert.equal(j.servePort, SERVE_PORT)
  assert.equal(typeof j.serveAlive, 'boolean', 'serveAlive 必须是布尔：UI 靠它区分「端点没起」与「文件缺失」')
  assert.equal(typeof j.exists, 'boolean')
  assert.equal(typeof j.updateUrl, 'string')
  assert.equal(typeof j.pageUrl, 'string')
})

it('语义：updateUrl 必须以 .user.js 结尾，否则 Tampermonkey 不认安装/更新', async () => {
  const j = await fetchInfo()
  const url = String(j.updateUrl)
  assert.ok(url.endsWith('.user.js'), `updateUrl 后缀不对：${url}`)
  assert.ok(url.includes(`:${SERVE_PORT}/`), `updateUrl 端口必须与分发端点一致：${url}`)
  assert.match(url, /^http:\/\/127\.0\.0\.1:/, '分发端点只监听回环地址')
})

it('体量：不得把脚本正文塞进响应（该端点每次点击都会被请求）', async () => {
  const j = await fetchInfo()
  assert.ok(!('content' in j), '响应不得携带脚本正文')
  assert.ok(JSON.stringify(j).length < 600, `元信息响应应远小于脚本本体，实际 ${JSON.stringify(j).length} 字节`)
})

it('存在性：脚本在仓库内时版本与字节数必须可用（UI 要展示版本号）', async () => {
  const j = await fetchInfo()
  assert.ok(fs.existsSync(path.join(ROOT, USERSCRIPT_REL)), '仓库里应当始终有这份脚本')
  assert.equal(j.exists, true)
  assert.equal(j.version, parseUserscriptVersion(read(USERSCRIPT_REL)), 'version 必须来自磁盘脚本头，不得另算一份')
  assert.ok(Number(j.bytes) > 1000, `字节数不合理：${String(j.bytes)}`)
  assert.ok(Number(j.mtimeMs) > 0)
})

it('parseUserscriptVersion：取行首 @version，缺省返回 null 而非编造默认值', () => {
  assert.equal(parseUserscriptVersion('// ==UserScript==\n// @version      1.5.0\n// ==/UserScript=='), '1.5.0')
  assert.equal(parseUserscriptVersion('// @version 2.0.0-beta.1'), '2.0.0-beta.1')
  assert.equal(parseUserscriptVersion('// @name x\n// @description y'), null)
  // 行中出现不算：注释里讨论 @version 的说明文字不得被当成版本号
  assert.equal(parseUserscriptVersion('// 说明：本脚本 @version 由构建注入'), null)
})

it('接线：路由挂进 HONO_SUB_APPS 与 HONO_PREFIXES', () => {
  assert.ok(HONO_SUB_APPS.includes(userscriptHono), 'userscriptHono 未挂进 barrel：请求会落到 404 兜底')
  assert.ok(HONO_PREFIXES.includes('/userscript'), '/userscript 未进 HONO_PREFIXES：工作区守卫会漏掉它')
})

it('接线：无工作区时必须豁免 /userscript（装脚本与「选没选工作区」无关）', () => {
  const src = read(HANDLE_SRC)
  assert.match(
    src,
    /WORKSPACE_EXEMPT_PREFIXES = \[[^\]]*'\/userscript'/,
    '未豁免 → 无工作区时按钮返回 409 NO_WORKSPACE，提示风马牛不相及',
  )
})

it('油猴回传：observer 须开 attributes 监听，但 attributeFilter 不得含高频的 class', () => {
  const src = read(USERSCRIPT_REL)
  assert.match(src, /replyObserver\.observe\([\s\S]*?attributes:\s*true/, 'observer 必须开启 attributes 监听（wake-attrs-v2），否则「停止生成」按钮态变无法唤醒回传')
  const m = src.match(/attributeFilter:\s*\[([^\]]*)\]/)
  assert.ok(m, 'attributeFilter 必须显式声明')
  const attrs = m![1].split(',').map(s => s.trim().replace(/['"]/g, ''))
  assert.ok(!attrs.includes('class'), 'attributeFilter 不得含 class：流式渲染/动画下 class 变更极高频，会制造 observer 回调风暴')
  assert.ok(attrs.includes('disabled') && attrs.includes('aria-label') && attrs.includes('data-state'), '停止生成按钮态变靠 disabled/aria-label/data-state 覆盖')
})

it('油猴回传：生成闸门不得退化为裸 return（须有单飞自巡检 genRetryTimer）', () => {
  const src = read(USERSCRIPT_REL)
  assert.match(src, /\[generating-gate-v2\]/, '生成闸门改造须带标记，便于守卫与历史对照')
  assert.match(src, /genRetryTimer\s*=/, '生成中为 true 时必须挂单飞自巡检定时器')
  assert.match(src, /if \(!genRetryTimer\)\s*\{\s*genRetryTimer = setTimeout/, '生成中须单飞（已挂则不再挂）地排一个自检定时器，否则「生成结束」非 DOM 事件无人唤醒')
})
