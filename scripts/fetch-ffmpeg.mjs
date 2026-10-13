// [fetch-ffmpeg-v1] 下载 macOS Intel 版 ffmpeg/ffprobe 静态二进制到 bin/。
// [WHY] bin/ffmpeg 与 bin/ffprobe 共约 190MB，不进 git；新环境需一条命令拉齐。
// [CONSTRAINT] 仅 macOS 有效；源为 Martin Riedl 构建服务器（已签名，可绕开 provenance SIGKILL）。
//   该服务器已宣布 2026-01 停止 Intel snapshot、2027-01 停止 release 构建 —— 届时需换源。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 构建服务器重定向入口（自动解析最新 release 版本） */
const BASE = 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release'

/** 仓库根目录（本脚本位于 scripts/ 下） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 下载并解压单个二进制；已存在则跳过（除非 --force） */
function fetchOne(name, force) {
  const out = path.join(ROOT, 'bin', name)
  if (fs.existsSync(out) && !force) {
    console.log(`[fetch-ffmpeg] 已存在，跳过: ${out}`)
    return
  }
  const zip = path.join('/tmp', `${name}.zip`)
  console.log(`[fetch-ffmpeg] 下载 ${name} ...`)
  const dl = spawnSync('curl', ['-sSL', '-o', zip, `${BASE}/${name}.zip`], { stdio: 'inherit' })
  if (dl.status !== 0) throw new Error(`下载失败: ${name}`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const un = spawnSync('unzip', ['-o', zip, '-d', path.join(ROOT, 'bin')], { stdio: 'inherit' })
  if (un.status !== 0) throw new Error(`解压失败: ${name}`)
  fs.chmodSync(out, 0o755)
  const ver = spawnSync(out, ['-version'], { encoding: 'utf8' })
  if (ver.status !== 0) throw new Error(`二进制无法执行: ${name}`)
  console.log(`[fetch-ffmpeg] 就绪: ${out} — ${String(ver.stdout || '').split('\n')[0]}`)
}

/** 入口：下载 ffmpeg 与 ffprobe */
function main() {
  const force = process.argv.includes('--force')
  if (process.platform !== 'darwin') {
    console.warn('[fetch-ffmpeg] 本脚本仅支持 macOS；其他平台请自备 ffmpeg。')
    return
  }
  fetchOne('ffmpeg', force)
  fetchOne('ffprobe', force)
}

main()
