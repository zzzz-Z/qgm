// [bg-stream-v1] GET /shell-log —— 后台长任务日志**增量**读取（供前端流式显示）
// [WHY] `shell(cmd,{background:true})` 的子进程 stdio 被重定向到 .ai-runner/tmp/<id>.log，
//   不经过 /run 的 onChunk ⇒ NDJSON chunk 帧里没有它的输出；而发出任务的那一轮 /run 一结束，
//   推送通道就关闭了 ⇒ 跨轮没有任何服务端推流路径。前端若想「边跑边看」，只能自己按偏移拉增量。
//   这条只读端点就是为此存在：配合 startBackground 打印的 `BG_ID=<id>`（走前台 stdout，随 chunk
//   实时上屏），前端拿到 id 后即可秒级轮询本端点，实现**不占 AI 轮次、不受 180s 限制**的流式显示。
// [CONSTRAINT] 只读、且 id 受 `^sh-[A-Za-z0-9_-]+$` 约束（禁止穿越到 tmp 目录外）；不提供 kill。
import { Hono } from 'hono'
import { createRequire } from 'node:module'
import { getRoot } from '../config.js'

/** readShell / shellStatus 的返回面（只声明本路由用到的字段） */
interface ShellLogApi {
  readShell: (id: string, opts?: { from?: number, cwd?: string }) => {
    ok: boolean
    text?: string
    size?: number
    next?: number
    done?: boolean
    running?: boolean
    exitCode?: number
    error?: string
    code?: number
  }
}

// [bg-stream-v1] 运行时 .cjs 不进 bundle（由 copy-runtime / build-all step3 拷贝），故用 createRequire。
//   三处解析位置均已对齐：src（vitest）/ packages/core/dist / apps/standalone/dist/_server。
//   dist 兜底用于 bundle 后 import.meta.url 落点与 src 不一致的极端情形。
const _require = createRequire(import.meta.url)
/** 加载执行族模块；失败返回 null（路由降级为 503，不阻断服务） */
function loadShellApi(): ShellLogApi | null {
  try {
    return _require('../helpers/shell.cjs') as ShellLogApi
  } catch {
    try {
      return _require(`${getRoot()}/packages/core/dist/helpers/shell.cjs`) as ShellLogApi
    } catch {
      return null
    }
  }
}
const shellApi = loadShellApi()

/** shell-log 路由的 Hono 实例 */
export const shellLogHono = new Hono()

shellLogHono.get('/shell-log', (c) => {
  if (!shellApi) return c.json({ ok: false, error: 'helpers/shell.cjs 未加载（运行时文件缺失）' }, 503)
  const q = c.req.query()
  const id = String(q.id || '').trim()
  if (!id) return c.json({ ok: false, error: 'missing id' }, 400)
  // [bg-stream-v1] 只读固定目录下的 <id>.log：限定 id 形态即堵住路径穿越
  if (!/^sh-[\w-]+$/.test(id)) return c.json({ ok: false, error: '非法 id' }, 400)
  const from = Math.max(0, Number(q.from) || 0)
  // [bg-stream-v1] 优先按工作区根定位；沙箱脚本写盘时用的是自己的 cwd，两者可能不同 ⇒ 失败再按进程 cwd 兜底
  let r = shellApi.readShell(id, { from, cwd: getRoot() })
  if (!r.ok && r.code === 404) r = shellApi.readShell(id, { from })
  if (!r.ok) return c.json({ ok: false, error: r.error || 'read failed', code: r.code ?? 400 }, r.code === 404 ? 404 : 400)
  return c.json({
    ok: true,
    id,
    text: r.text || '',
    next: r.next ?? 0,
    size: r.size ?? 0,
    done: Boolean(r.done),
    running: Boolean(r.running),
    exitCode: r.exitCode ?? null,
  })
})
