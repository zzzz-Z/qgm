// [url-parse-guard-v2] `new URL(req.url, base)` 的第五处 —— 在 **'upgrade' 事件监听器**里。
// [WHY] 与 serveStatic 同族（req.url 是任意字节串，`GET // HTTP/1.1` + Upgrade 头 会让
//   new URL('//', base) 抛 ERR_INVALID_URL），但后果形态不同、更隐蔽：
//   - 普通请求路径抛穿后有调用方 `.catch` 接（plugin.ts:55 / server.ts:255）⇒ 至少还能回 500；
//   - 'upgrade' 监听器是注册在 `httpServer.on('upgrade')` 上的，**没有调用方** ⇒ 抛穿后只能落到
//     进程级 uncaughtException。旧实现下 D8 兜底让进程没死，于是症状被掩盖成两件事：
//       ① 客户端收不到任何字节（裸 TCP 实测 head="" bytes=0，挂到客户端超时）；
//       ② 每次畸形请求都往 server-crash.log 写一条 **假崩溃**，把真正的崩溃信号淹掉
//          （实测 488 B → 859 B，堆栈顶部 Server.onUpgrade）。
// [CONSTRAINT] 解析失败**只 return、绝不 socket.destroy()**：attachWs 与 Vite dev server 共用
//   同一个 http server（apps/vite-plugin/src/plugin.ts 把它挂在 server.httpServer 上），HMR 的
//   websocket 监听器也挂在 'upgrade' 上。抢着销毁 socket 会打死 HMR。
// [INVARIANT] 本文件把以下四条钉在源码文本上：
//   ① onUpgrade 里不得裸调 new URL(req.url …)；
//   ② 解析失败分支必须 return（不得 destroy）；
//   ③ pathname 不匹配分支仍然是裸 return（「交给别的监听器试」这一策略不许改成销毁）；
//   ④ 上面 ② 的依据（Vite 共用 http server）仍然成立。
// CHANGE-IMPACT: 删掉 try/catch、把 catch 改成 socket.destroy()、或改掉 pathname 不匹配分支，
//   本文件立刻变红。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ATTACH_WS = path.join(ROOT, 'packages', 'core', 'src', 'server', 'attach-ws.ts')
const VITE_PLUGIN = path.join(ROOT, 'apps', 'vite-plugin', 'src', 'plugin.ts')

const TXT = fs.readFileSync(ATTACH_WS, 'utf8')

const HEAD = 'const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {'
const TAIL = 'httpServer.on(\'upgrade\', onUpgrade)'
const HEAD_AT = TXT.indexOf(HEAD)
const TAIL_AT = TXT.indexOf(TAIL)

// 该区间内没有跨行的字符串字面量，所以「按行剥纯注释行」是安全的；
// 必须剥，否则本文件里 CONSTRAINT 注释中提到的 `socket.destroy()` 会被当成真实调用。
const RAW_BODY = HEAD_AT !== -1 && TAIL_AT > HEAD_AT ? TXT.slice(HEAD_AT, TAIL_AT) : ''
const BODY = RAW_BODY.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

test('防空转：onUpgrade 片段被真正取到（否则下面全是空断言）', () => {
  assert.notEqual(HEAD_AT, -1, `attach-ws.ts 找不到 onUpgrade 定义，需重写本守卫：${HEAD}`)
  assert.ok(TAIL_AT > HEAD_AT, `找不到 ${TAIL}`)
  assert.ok(BODY.includes('handleUpgrade('), 'onUpgrade 片段里应含 wss.handleUpgrade —— 否则切片范围取错了')
  assert.ok(BODY.length > 120, `onUpgrade 片段过短（${BODY.length} 字符），判据会变成空转`)
})

test('onUpgrade 里不得裸调 new URL(req.url …)：\'upgrade\' 监听器没有调用方能接住抛出', () => {
  const at = BODY.indexOf('new URL(req.url')
  assert.notEqual(at, -1, 'onUpgrade 里应有 new URL(req.url …)')
  assert.ok(!/(?:const|let)\s+url\s*=\s*new URL\(req\.url/.test(BODY), '不得裸调：解析失败会抛穿 \'upgrade\' 监听器，客户端收不到任何响应')
  const head = BODY.slice(Math.max(0, at - 120), at)
  assert.match(head, /try\s*\{/, 'new URL(req.url …) 之前必须紧邻 try { —— 解析失败要走 return，与「非本路径」同一策略')
})

test('解析失败分支必须 return，且不得销毁 socket（会打死共用同一 server 的 Vite HMR）', () => {
  assert.match(BODY, /catch\s*\{\s*return\s*\}/, '解析失败分支应是 `catch { return }`：与「pathname 不匹配就 return」保持一致')
  assert.ok(!/\.destroy\(/.test(BODY), 'onUpgrade 里不得出现任何 .destroy()：该 server 与 Vite dev 共用，销毁 socket 会把 HMR 的升级请求一起打掉')
})

test('pathname 不匹配仍是裸 return（「交给别的监听器试」这一策略不许改成销毁）', () => {
  assert.match(BODY, /if\s*\(url\.pathname !== WS_PATH\)\s*return/, 'pathname 不匹配必须直接 return，交给挂在同一 upgrade 事件上的其他监听器')
  assert.ok(!/if\s*\(url\.pathname !== WS_PATH\)\s*\{[^}]*destroy/.test(BODY), 'pathname 不匹配不得销毁 socket')
})

test('上面「不得销毁」的依据仍然成立：attachWs 确实挂在 Vite 的 httpServer 上', () => {
  const plugin = fs.readFileSync(VITE_PLUGIN, 'utf8')
  // [guard-tighten-v1] 必须卡标识符边界：只写 `attachWs\(\s*server\.httpServer` 是**前缀匹配**，
  // 把调用改成 `server.httpServerLegacy` 也能溜过去 —— 变异验证实测（M4 未承重）暴露。
  // 用 (?![\w$]) 而非要求逗号，是为了同时接受 attachWs(server.httpServer) 这种省略 opts 的写法。
  assert.match(
    plugin,
    /attachWs\(\s*server\.httpServer(?![\w$])/,
    'apps/vite-plugin 不再把 attachWs 挂到 Vite 的 httpServer 上了 —— 那「不得销毁 socket」的理由已失效，请复查本守卫与 attach-ws.ts 的 CONSTRAINT 注释',
  )
})
