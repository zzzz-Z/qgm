// 任务清单同步：向服务端 POST /__ai/tasks 写 state.json
// 展示端由 useTasks.ts 1.5s 轮询 GET /__ai/tasks 消费

const ENDPOINT = '/__ai/tasks'

export interface TaskSyncBody {
  mode?: 'set' | 'push' | 'complete'
  todo?: string[]
  done?: Array<{ item: string, at: number, round?: number, note?: string }>
  status?: string
  round?: number
  pushTodo?: string[]
  complete?: string[]
}

export async function syncTasks(body: TaskSyncBody): Promise<void> {
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
  } catch { /* 网络失败不阻塞主流程 */ }
}
