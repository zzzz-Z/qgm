// [pm2-restart-v1] /restart —— DONE 回执完成后延迟重启 pm2 托管实例
// [WHY] 用户要求任务完成后自动重启使新产物生效；直接在 DONE 处理链内 pm2 restart 会杀掉
//   承载回执的进程 → 本轮 DONE 截断（实测 TypeError: network error）。
// [CONSTRAINT] 用 detached + unref 起独立子进程，延迟 5s 再执行 pm2 restart；
//   HTTP 响应先返回 ok，父进程退出不影响子进程执行。
// [CHANGE-IMPACT] 仅作用于 pm2 托管的 ai-runner；未装 pm2 时静默失败。
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
