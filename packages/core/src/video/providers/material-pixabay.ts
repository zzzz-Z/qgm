// [video-material-pixabay-v1] Pixabay 在线素材：REST 检索 + 下载。
// [WHY] 与 Pexels 互补的第二在线源，API 结构不同但语义一致。
// [CONSTRAINT] Pixabay 的 key 走 query 参数（不是 header），与 Pexels 相反。
import fs from 'node:fs'
import path from 'node:path'
import type { MaterialInfo } from '../types.js'
import type { MaterialProvider, SearchOptions } from './material-types.js'

/** Pixabay 单条 video hit 的最小形态 */
interface PixabayHit {
  id: number
  duration: number
  videos: Record<string, { url: string, width: number, height: number }>
}

/** Pixabay 适配器 */
export class PixabayMaterialProvider implements MaterialProvider {
  readonly name = 'pixabay'

  constructor(private readonly apiKey: string) {}

  async search(terms: string[], opts: SearchOptions): Promise<MaterialInfo[]> {
    const q = encodeURIComponent(terms.join(' '))
    const url = `https://pixabay.com/api/videos/?key=${this.apiKey}&q=${q}&per_page=${opts.limit || 10}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`pixabay 检索失败: ${res.status}`)
    const data = await res.json() as { hits?: PixabayHit[] }
    const out: MaterialInfo[] = []
    for (const h of data.hits || []) {
      // 优先 medium/large 竖屏；找不到则取任意一条
      const pick = h.videos.medium || h.videos.large || h.videos.small || Object.values(h.videos)[0]
      if (!pick) continue
      out.push({ provider: 'pixabay', url: pick.url, duration: h.duration, width: pick.width, height: pick.height })
    }
    return out
  }

  async download(material: MaterialInfo, destPath: string): Promise<string> {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const res = await fetch(material.url)
    if (!res.ok) throw new Error(`pixabay 下载失败: ${res.status}`)
    fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()))
    return destPath
  }
}
