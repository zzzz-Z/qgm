// [video-material-cogvideox-v1] CogVideoX AI 生成素材：提交任务 → 轮询 → 下载。
// [WHY] MPT 没有的能力；在无现成素材可用时按提示词生成。
// [CONSTRAINT] 单次生成 5-10s，慢于检索；由 orchestrator 按需调用，不默认开启。
//   任务提交后轮询间隔 5s，上限 180 次（15 分钟），失败即抛错不静默降级。
import fs from 'node:fs'
import path from 'node:path'
import type { MaterialInfo } from '../types.js'
import type { MaterialProvider, SearchOptions } from './material-types.js'

/** 智谱 CogVideoX 提交端点 */
const SUBMIT_URL = 'https://open.bigmodel.cn/api/paas/v4/videos/generations'
/** 异步结果轮询端点前缀 */
const RESULT_URL = 'https://open.bigmodel.cn/api/paas/v4/async-result/'
/** 轮询上限（次）与间隔（毫秒） */
const MAX_POLLS = 180
const POLL_INTERVAL_MS = 5000

/** 提交响应最小形态 */
interface SubmitRes { id?: string, error?: { message?: string } }
/** 轮询响应最小形态 */
interface PollRes {
  task_status?: string
  video_result?: Array<{ url?: string }>
  error?: { message?: string }
}

/** 沉睡指定毫秒 */
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** CogVideoX 素材 provider：search 生成视频，download 拉取到本地 */
export class CogVideoXMaterialProvider implements MaterialProvider {
  readonly name = 'ai'

  /** @param apiKey 智谱 API Key；@param model 模型编码（默认 cogvideox-3） */
  constructor(private readonly apiKey: string, private readonly model = 'cogvideox-3') {}

  /** 按提示词生成一个视频；terms 逐条试，首个成功即返回 */
  async search(terms: string[], opts: SearchOptions): Promise<MaterialInfo[]> {
    if (!this.apiKey) throw new Error('CogVideoX 缺少 API Key（config.material 未配置）')
    const prompt = terms.join('，')
    const size = opts.aspect === '16:9' ? '1280x720' : '720x1280'
    const submit = await fetch(SUBMIT_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt, size }),
    })
    const sres = await submit.json() as SubmitRes
    if (!sres.id) throw new Error(`CogVideoX 提交失败：${sres.error?.message || submit.status}`)
    const url = await this.poll(sres.id)
    return [{ provider: 'ai', url, duration: 0, width: 0, height: 0 }]
  }

  /** 轮询直到 SUCCESS；FAIL/超时抛错 */
  private async poll(id: string): Promise<string> {
    for (let i = 0; i < MAX_POLLS; i++) {
      const res = await fetch(RESULT_URL + id, { headers: { Authorization: `Bearer ${this.apiKey}` } })
      const data = await res.json() as PollRes
      if (data.task_status === 'SUCCESS') {
        const url = data.video_result?.[0]?.url
        if (!url) throw new Error('CogVideoX 成功但无视频 URL')
        return url
      }
      if (data.task_status === 'FAIL') throw new Error(`CogVideoX 任务失败：${data.error?.message || ''}`)
      await sleep(POLL_INTERVAL_MS)
    }
    throw new Error(`CogVideoX 轮询超时：${id}`)
  }

  /** 下载生成的视频到目标路径 */
  async download(material: MaterialInfo, destPath: string): Promise<string> {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const res = await fetch(material.url)
    if (!res.ok) throw new Error(`CogVideoX 下载失败：${res.status}`)
    fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()))
    return destPath
  }
}
