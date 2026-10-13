// [video-types-v1] 视频生成模块共享类型。
// [WHY] orchestrator / providers / routes 三层共用一份契约，避免各自定义导致漂移。

/** 素材来源模式 */
export type MaterialSource = 'pexels' | 'pixabay' | 'local' | 'ai'

/** 字幕引擎 */
export type SubtitleEngine = 'edge' | 'whisper'

/** 画幅比例 */
export type AspectRatio = '9:16' | '16:9' | '1:1'

/** 任务状态 */
export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed'

/** 流水线阶段（stopAt 检查点用） */
export type PipelineStage = 'script' | 'terms' | 'audio' | 'materials' | 'compose'

/** 创建任务的入参 */
export interface VideoTaskParams {
  videoSubject: string
  videoScript?: string
  videoTerms?: string[]
  videoSource: MaterialSource
  videoMaterials?: string[]
  stopAt?: PipelineStage
  aspect?: AspectRatio
  voiceName?: string
  voiceRate?: number
  voiceVolume?: number
  subtitleEnabled?: boolean
  subtitleEngine?: SubtitleEngine
  bgmPath?: string
  bgmVolume?: number
}

/** 任务持久化状态 */
export interface TaskState {
  taskId: string
  status: TaskStatus
  progress: number
  stage: PipelineStage | ''
  params: VideoTaskParams
  scriptPath?: string
  termsPath?: string
  audioPath?: string
  subtitlePath?: string
  materialPaths?: string[]
  combinedPath?: string
  outputPath?: string
  error?: string
  createdAt: number
  updatedAt: number
}

/** 素材元信息 */
export interface MaterialInfo {
  provider: MaterialSource
  url: string
  duration: number
  width: number
  height: number
  localPath?: string
}

/** TTS 词边界时间戳（用于字幕） */
export interface WordBoundary {
  word: string
  start: number
  end: number
}

/** TTS 合成结果 */
export interface TTSResult {
  audioPath: string
  duration: number
  wordBoundaries?: WordBoundary[]
}

/** 字幕条目 */
export interface SubtitleEntry {
  index: number
  start: number
  end: number
  text: string
}

/** 流水线单阶段结果 */
export interface StageResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}
