// [video-tts-say-v1] macOS say 适配器：离线兜底 TTS，无词边界时间戳。
// [WHY] 无网络或无 API Key 时唯一可用路径；词边界缺失由字幕层降级到 Whisper 转写。
// [CONSTRAINT] 仅 macOS 可用；非 darwin 平台调用即抛错，不做静默降级。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { TTSResult } from '../types.js'
import type { TTSAdapter, TTSOptions } from './tts-types.js'

/** 执行命令；非零退出抛错 */
function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args)
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e: Error) => reject(new Error(`${bin} 启动失败: ${e.message}`)))
    child.on('close', (code: number | null) => {
      if (code === 0) resolve(stderr)
      else reject(new Error(`${bin} 退出码 ${code}\n${stderr.slice(-1000)}`))
    })
  })
}

/** say 合成结果时长（秒）；用 afinfo 读回，避免依赖外部探测库 */
async function probeDuration(file: string): Promise<number> {
  const out = await run('afinfo', [file])
  const m = out.match(/estimated duration:\s*([\d.]+)/)
  return m ? Number.parseFloat(m[1]) : 0
}

/** macOS say 适配器 */
export class SayTTSAdapter implements TTSAdapter {
  readonly name = 'say'

  async synthesize(text: string, opts: TTSOptions): Promise<TTSResult> {
    if (process.platform !== 'darwin') throw new Error('say 仅在 macOS 可用')
    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true })
    const aiff = `${opts.outputPath.replace(/\.\w+$/, '')}.aiff`
    const rate = opts.rate && opts.rate !== 1 ? ['-r', String(Math.round(180 * opts.rate))] : []
    await run('say', ['-v', opts.voice, ...rate, '-o', aiff, text])
    await run('afconvert', ['-f', 'm4af', '-d', 'aac@44100', '-b', '128000', aiff, opts.outputPath])
    const duration = await probeDuration(aiff)
    try { fs.unlinkSync(aiff) } catch { /* 中间文件清理失败不影响主流程 */ }
    return { audioPath: opts.outputPath, duration }
  }
}
