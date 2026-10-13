// [video-material-types-v1] 素材提供商统一接口。
// [WHY] orchestrator 只依赖此接口，四种素材源（在线/本地/AI）可插拔。
// [CONSTRAINT] search 返回的素材必须带 duration——合成阶段要靠它计算每段裁剪秒数，
//   缺失时由调用方按兜底时长处理。
import type { MaterialInfo } from '../types.js'

/** 素材检索参数 */
export interface SearchOptions {
  /** 目标画幅，用于过滤横竖屏不匹配的素材 */
  aspect?: string
  /** 单次检索最多返回条数 */
  limit?: number
}

/** 素材提供商契约 */
export interface MaterialProvider {
  /** 提供商标识（pexels / pixabay / local / ai） */
  readonly name: string
  /** 按关键词检索素材元信息 */
  search: (terms: string[], opts: SearchOptions) => Promise<MaterialInfo[]>
  /** 下载素材到目标路径；已存在则跳过，返回本地路径 */
  download: (material: MaterialInfo, destPath: string) => Promise<string>
}
