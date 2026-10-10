// [pm2-restart-v1] /restart —— 按需延迟重启 pm2 托管的 ai-runner 实例
// [WHY] 供用户在需要时（如产物更新后）主动触发；直接在业务进程内 pm2 restart 会杀掉
//   承载请求的进程 → 请求截断（实测 TypeError: network error）。
// [CONSTRAINT] 用 detached + unref 起独立子进程，延迟 5s 再执行 pm2 restart；
//   HTTP 响应先返回 ok，父进程退出不影响子进程执行。
// [CHANGE-IMPACT] 仅作用于 pm2 托管的 ai-runner；未装 pm2 时静默失败。
// [auto-restart-removed-v1] 2026-10-10 起 DONE 后不再自动调用本端点（原触发点在
//   client 的 useAiReplyHandlers.ts，已删除），改为用户主动调用。原先的自动触发在
//   页面挂 5174 而 5174 未运行时请求静默失败，但弹窗照弹，属误导；删掉比修更稳。
//   历史开关 .ai-runner/auto-restart.json 从未被本路由读取（客户端注释所称的
//   enabled 闸门在实现里不存在），已随本次清理删除。
import { Hono } from 'hono'
import { spawn } from 'node:child_process'

/** 延迟重启秒数：给 DONE 序列化 / lessons 落盘 / WS 帧送达留余量 */
const RESTART_DELAY_SECONDS = 5

export const restartHono = new Hono()

restartHono.post('/restart', async (c) => {
  try {
    // [no-shell-v1] 直接 spawn pm2 可执行文件，不经过 shell；args 数组规避注入
    const child = spawn(
      'sh',
      ['-c', `sleep ${RESTART_DELAY_SECONDS} && pm2 restart ai-runner`],
      { detached: true, stdio: 'ignore', cwd: process.cwd() },
    )
    child.unref()
    return c.json({ ok: true, delaySeconds: RESTART_DELAY_SECONDS })
  } catch (e) {
    return c.json({ ok: false, reason: e instanceof Error ? e.message : String(e) }, 500)
  }
})
