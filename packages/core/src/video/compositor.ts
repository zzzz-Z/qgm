// [video-compositor-v1] ffmpeg 命令封装：只构造参数与调用进程，不实现编解码。
// [WHY] 视频合成是本模块唯一重活，把命令拼装与流水线推进分开，各管一摊。
// [CONSTRAINT] 依赖外部 ffmpeg/ffprobe 二进制；不可用时立即报错，不做降级实现。
import { spawn } from 'node:child_process'
import type { AspectRatio } from './types.js'

/** 画幅 → 像素尺寸 */
const ASPECT_SIZE: Record<AspectRatio, { w: number, h: number }> = {
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 },
  '1:1': { w: 1080, h: 1080 },
}

/** 目标帧率（统一源片段，避免 concat 音画错位） */
const TARGET_FPS = 30

/** 执行 ffmpeg/ffprobe；非零退出即抛错，stderr 附在错误里便于定位 */
export function runFfmpeg(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e: Error) => reject(new Error(`${bin} 启动失败: ${e.message}`)))
    child.on('close', (code: number | null) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${bin} 退出码 ${code}\n${stderr.slice(-2000)}`))
    })
  })
}

/** 探测 ffmpeg 是否可用 */
export async function hasFfmpeg(bin = 'ffmpeg'): Promise<boolean> {
  try { await runFfmpeg(bin, ['-version']); return true } catch { return false }
}

/** 探测某编码器是否存在 */
export async function hasEncoder(bin: string, name: string): Promise<boolean> {
  try {
    const out = await runFfmpeg(bin, ['-hide_banner', '-encoders'])
    return out.includes(name)
  } catch { return false }
}

/** 选择视频编码器：优先硬件加速，全不可用时回退 libx264 */
export async function pickVideoEncoder(bin = 'ffmpeg'): Promise<string> {
  for (const name of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
    if (await hasEncoder(bin, name)) return name
  }
  return 'libx264'
}

/** 探测媒体时长（秒）；ffprobe 输出不可解析时抛错 */
export async function probeDuration(file: string, bin = 'ffprobe'): Promise<number> {
  const out = await runFfmpeg(bin, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    file,
  ])
  const sec = Number.parseFloat(out.trim())
  if (!Number.isFinite(sec)) throw new Error(`无法解析时长: ${file}`)
  return sec
}

/** 片段标准化参数：裁剪到指定秒数、缩放到目标画幅、统一帧率与像素格式 */
export function normalizeClipArgs(input: string, output: string, seconds: number, aspect: AspectRatio, encoder: string): string[] {
  const { w, h } = ASPECT_SIZE[aspect]
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
  return [
    '-y',
    '-i',
    input,
    '-t',
    String(seconds),
    '-vf',
    vf,
    '-r',
    String(TARGET_FPS),
    '-c:v',
    encoder,
    '-pix_fmt',
    'yuv420p',
    '-an',
    output,
  ]
}

/** 拼接参数：读 concat 列表，直接 copy 流（片段已标准化） */
export function concatArgs(listFile: string, output: string): string[] {
  return ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output]
}

/** 混音 + 字幕烧录参数；bgmPath 缺省时仅混合配音与字幕 */
export function finalizeArgs(opts: {
  video: string
  audio: string
  bgm?: string
  subtitle?: string
  output: string
  bgmVolume: number
  encoder: string
}): string[] {
  const { video, audio, bgm, subtitle, output, bgmVolume, encoder } = opts
  const args = ['-y', '-i', video, '-i', audio]
  if (bgm) args.push('-i', bgm)
  if (subtitle) args.push('-vf', `subtitles=${subtitle}`)
  if (bgm) {
    args.push(
      '-filter_complex',
      `[1:a]volume=1[a1];[2:a]volume=${bgmVolume}[a2];[a1][a2]amix=inputs=2:duration=first[ao]`,
      '-map',
      '0:v',
      '-map',
      '[ao]',
    )
  } else {
    args.push('-map', '0:v', '-map', '1:a')
  }
  args.push('-c:v', encoder, '-c:a', 'aac', '-shortest', output)
  return args
}

/** 探测音频时长（最终合成的时长基准） */
export async function audioDuration(audioPath: string, bin = 'ffprobe'): Promise<number> {
  return probeDuration(audioPath, bin)
}
