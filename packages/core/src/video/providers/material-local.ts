// [video-material-local-v1] 本地素材提供商：读取指定目录，不做网络检索。
// [WHY] 无 API Key 或离线场景下唯一可用的素材源，也是「用户自备素材」路径。
// [CONSTRAINT] 只读目录，不修改源文件；下载即拷贝到任务目录。
import fs from 'node:fs'
import path from 'node:path'
import type { MaterialInfo } from '../types.js'
import type { MaterialProvider, SearchOptions } from './material-types.js'

/** 支持的素材扩展名 */
const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.mkv', '.avi']

/** 本地素材目录 provider */
export class LocalMaterialProvider implements MaterialProvider {
  readonly name = 'local'

  /** 素材目录绝对路径 */
  constructor(private readonly dir: string) {}

  async search(_terms: string[], opts: SearchOptions): Promise<MaterialInfo[]> {
    if (!fs.existsSync(this.dir)) return []
    const files = fs.readdirSync(this.dir)
      .filter(f => VIDEO_EXT.includes(path.extname(f).toLowerCase()))
      .map(f => path.join(this.dir, f))
    const limit = opts.limit || files.length
    return files.slice(0, limit).map(f => ({
      provider: 'local' as const,
      url: '',
      duration: 0,
      width: 0,
      height: 0,
      localPath: f,
    }))
  }

  async download(material: MaterialInfo, destPath: string): Promise<string> {
    if (!material.localPath) throw new Error('本地素材缺少 localPath')
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.copyFileSync(material.localPath, destPath)
    return destPath
  }
}
