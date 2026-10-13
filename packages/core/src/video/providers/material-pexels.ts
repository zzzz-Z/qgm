// [video-material-pexels-v1] Pexels 在线素材：REST 检索 + 下载。
// [WHY] MPT 主素材源；免费 API 限速 200 req/h。
import fs from 'node:fs'
import path from 'node:path'
import type { MaterialInfo } from '../types.js'
import type { MaterialProvider, SearchOptions } from './material-types.js'

interface PexelsVideo {
  id: number
  duration: number
  video_files: Array<{ width: number, height: number, link: string }>
}

export class PexelsMaterialProvider implements MaterialProvider {
  readonly name = 'pexels'
  constructor(private readonly apiKey: string) {}

  async search(terms: string[], opts: SearchOptions): Promise<MaterialInfo[]> {
    const q = encodeURIComponent(terms.join(' '))
    const orientation = opts.aspect === '9:16' ? 'portrait' : 'landscape'
    const url = `https://api.pexels.com/videos/search?per_page=${opts.limit || 10}&query=${q}&orientation=${orientation}`
    const res = await fetch(url, { headers: { Authorization: this.apiKey } })
    if (!res.ok) throw new Error(`pexels 检索失败: ${res.status}`)
    const data = await res.json() as { videos?: PexelsVideo[] }
    const out: MaterialInfo[] = []
    for (const v of data.videos || []) {
      const f = v.video_files.find(x => x.width > 0) || v.video_files[0]
      if (!f) continue
      out.push({ provider: 'pexels', url: f.link, duration: v.duration, width: f.width, height: f.height })
    }
    return out
  }

  async download(material: MaterialInfo, destPath: string): Promise<string> {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const res = await fetch(material.url)
    if (!res.ok) throw new Error(`pexels 下载失败: ${res.status}`)
    fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()))
    return destPath
  }
}
