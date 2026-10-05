// [reply-poll-stop-v1] headless:stop 必须同步停掉该 sid 的 replyPoller。
// [WHY] 前端 finish('ai-stopped') 会 sendStop('') 打到服务端 headless:stop 分支。
// 若该分支只调 pool.stopGenerating 而不管 replyPollers，800ms 轮询会继续空转。
// 承重：删掉 headless:stop 分支里的 replyPollers.delete 即变红。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const SRC = path.join(ROOT, 'packages/core/src/server/attach-ws.ts')

function stopBranchBody(): string {
  const s = fs.readFileSync(SRC, 'utf8')
  const start = s.indexOf('case \'headless:stop\':')
  assert.ok(start >= 0, 'headless:stop 分支必须存在')
  const end = s.indexOf('case \'', start + 10)
  return s.slice(start, end > 0 ? end : start + 900)
}

test('headless:stop 分支必须停掉该 sid 的 replyPoller', () => {
  const body = stopBranchBody()
  assert.ok(
    body.includes('replyPollers.delete'),
    `headless:stop 不清 poller 会导致 800ms 轮询继续空转：${body}`,
  )
})
