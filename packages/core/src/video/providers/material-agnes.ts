// [video-material-agnes-v1] Agnes AI 素材源：文生视频，异步创建 + 轮询。
// [WHY] 零成本 AI 生成路径，与 CogVideoX 互补；未配置时不被选中。
// [CONSTRAINT] 端点与帧数规则来自公开文档，未经本机实测；
//   故开放 AGNES_CREATE_URL / AGNES_STATUS_URL 环境变量覆盖，便于校正。
//   帧数遵循 8n+1 规则（v2.0 要求），越界由服务端拒绝。
import fs from 'node:fs'
import path from 'node:path'
import type { MaterialInfo } from '../types.js'
import type { MaterialProvider, SearchOptions } from './material-types.js'

/** 创建任务端点；可经环境变量覆盖（端点未实测） */
const CREATE_URL = process.env.AGNES_CREATE_URL || 'https://apihub.agnes-ai.com/v1/videos'
/** 查询任务端点；可经环境变量覆盖 */
const STATUS_URL = process.env.AGNES_STATUS_URL || 'https://apihub.agnes-ai.com/agnesapi'
/** 轮询上限与间隔：120 × 2s = 4 分钟 */
const MAX_POLLS = 120
const POLL_INTERVAL_MS = 2000
/** 默认时长（秒）；Agnes 按帧计费，这里换算成帧 */
const DEFAULT_SECONDS = 5
/** 默认帧率 */
const FRAME_RATE = 24

/** 把秒数换算为满足 8n+1 的帧数（v2.0 硬性规则） */
function framesFor(seconds: number): number {
  const raw = Math.max(9, Math.round(seconds * FRAME_RATE))
  return Math.round((raw - 1) / 8) * 8 + 1
}

/** 按画幅解析宽高（Agnes 只认具体像素，不认比例字符串） */
function sizeFor(aspect?: string): { width: number, height: number } {
  return aspect === '16:9' ? { width: 1152, height: 768 } : { width: 768, height: 1152 }
}

/** 沉睡 */
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Agnes AI 素材适配器 */
export class AgnesMaterialProvider implements MaterialProvider {
  readonly name = 'agnes'

  /** @param apiKey Agnes 平台密钥 */
  constructor(private readonly apiKey: string) {}

  async search(terms: string[], opts: SearchOptions): Promise<MaterialInfo[]> {
    if (!this.apiKey) throw new Error('Agnes 缺少 API Key')
    const prompt = terms.join('，')
    const seconds = DEFAULT_SECONDS
    const { width, height } = sizeFor(opts.aspect)
    const body = {
      model: 'agnes-video-v2.0',
      prompt,
      width,
      height,
      num_frames: framesFor(seconds),
      frame_rate: FRAME_RATE,
    }
    const res = await fetch(CREATE_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const created = await res.json() as { video_id?: string, id?: string, task_id?: string, error?: { message?: string } }
    const videoId = created.video_id || created.id || created.task_id
    if (!videoId) throw new Error(`Agnes 创建失败：${created.error?.message || res.status}`)
    const url = await this.poll(videoId)
    return [{ provider: 'ai', url, duration: seconds, width, height }]
  }

  /** 轮询至 completed；failed / 超时即抛错 */
  private async poll(videoId: string): Promise<string> {
    const url = `${STATUS_URL}?video_id=${encodeURIComponent(videoId)}&model_name=agnes-video-v2.0`
    for (let i = 0; i < MAX_POLLS; i++) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${this.apiKey}` } })
      const data = await res.json() as { status?: string, url?: string, video_url?: string }
      const link = data.url || data.video_url
      if (data.status === 'completed' && link) return link
      if (data.status === 'failed') throw new Error(`Agnes 任务失败：${videoId}`)
      await sleep(POLL_INTERVAL_MS)
    }
    throw new Error(`Agnes 轮询超时：${videoId}`)
  }

  async download(material: MaterialInfo, destPath: string): Promise<string> {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const res = await fetch(material.url)
    if (!res.ok) throw new Error(`Agnes 下载失败：${res.status}`)
    fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()))
    return destPath
  }
}
