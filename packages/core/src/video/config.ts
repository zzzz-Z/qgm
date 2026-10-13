// [video-config-v1] 视频模块配置：读写 `.ai-runner/video/config.json` + Key 脱敏。
// [WHY] 多种 provider（Pexels/Pixabay/Azure）需要各自的凭据与开关，散落各处不可维护。
// [CONSTRAINT] 磁盘文件权限 0600；对外暴露时 Key 一律脱敏为 ****，写入时保留原值。
//   脱敏与保留必须严格区分：读 API 给前端看要用 maskConfig，写盘要用原配置。
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'

/** 视频模块配置结构 */
export interface VideoConfig {
  material: { pexelsApiKey: string, pixabayApiKey: string, cacheTtlHours: number }
  tts: { provider: 'edge' | 'say', voice: string, rate: number, volume: number }
  azure: { apiKey: string, region: string }
  whisper: { modelSize: string, device: string }
  video: { aspect: string, subtitleFont: string, subtitleFontSize: number, subtitleColor: string, bgmVolume: number }
}

/** 默认配置：全部为空/合理默认，不依赖任何外部凭据 */
const DEFAULTS: VideoConfig = {
  material: { pexelsApiKey: '', pixabayApiKey: '', cacheTtlHours: 24 },
  tts: { provider: 'edge', voice: 'zh-CN-XiaoxiaoNeural', rate: 1, volume: 1 },
  azure: { apiKey: '', region: '' },
  whisper: { modelSize: 'large-v3-turbo', device: 'cpu' },
  video: { aspect: '9:16', subtitleFont: 'PingFang SC', subtitleFontSize: 48, subtitleColor: '#FFFFFF', bgmVolume: 0.3 },
}

/** 配置文件绝对路径 */
export function configPath(): string {
  const root = getRoot() || process.cwd()
  return path.join(root, '.ai-runner/video/config.json')
}

/** 深合并两层配置（用户值覆盖默认值；缺失字段走默认） */
function merge(base: VideoConfig, patch: Partial<VideoConfig>): VideoConfig {
  const out = { ...base } as VideoConfig
  for (const key of Object.keys(patch) as Array<keyof VideoConfig>) {
    const v = patch[key]
    if (v && typeof v === 'object') {
      out[key] = { ...(base[key] as object), ...(v as object) } as never
    }
  }
  return out
}

/** 读取配置；文件缺失或损坏时返回默认值（不抛错，保证调用方可用） */
export function loadConfig(): VideoConfig {
  const file = configPath()
  if (!fs.existsSync(file)) return { ...DEFAULTS }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<VideoConfig>
    return merge(DEFAULTS, raw)
  } catch {
    return { ...DEFAULTS }
  }
}

/** 写配置（保持已有敏感字段值；权限 0600） */
export function saveConfig(cfg: VideoConfig): void {
  const file = configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

/** 把配置中的敏感字段替换为 ****，供前端展示 */
const MASK = '****'
export function maskConfig(cfg: VideoConfig): VideoConfig {
  const out = JSON.parse(JSON.stringify(cfg)) as VideoConfig
  if (out.material.pexelsApiKey) out.material.pexelsApiKey = MASK
  if (out.material.pixabayApiKey) out.material.pixabayApiKey = MASK
  if (out.azure.apiKey) out.azure.apiKey = MASK
  return out
}

/** 判断传入值是否为脱敏占位（写盘时跳过，避免把 **** 覆盖真实 Key） */
export function isMasked(v: string): boolean {
  return v === MASK
}
