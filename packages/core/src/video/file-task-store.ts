// [video-task-store-v1] 视频任务状态存储：内存 + 文件双写。
// [WHY] 任务跨阶段（脚本→素材→合成）耗时数分钟，进程重启后必须可恢复；
//   写文件是唯一事实来源，内存只做读取缓存。
// [CONSTRAINT] 状态文件落 `.ai-runner/video/tasks/{id}/state.json`，与任务产物同目录；
//   目录权限 0700，写入原子（先写 .tmp 再 rename）。
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../config.js'
import type { TaskState, VideoTaskParams } from './types.js'

/** 任务根目录（相对工作区根） */
const VIDEO_DIR = '.ai-runner/video'

/** 派生任务目录绝对路径；root 缺失时回退当前工作目录 */
function tasksRoot(): string {
  const root = getRoot() || '.'
  return path.join(root, VIDEO_DIR, 'tasks')
}

/** 任务目录绝对路径 */
export function taskDir(taskId: string): string {
  return path.join(tasksRoot(), taskId)
}

/** 创建任务目录（幂等） */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/** 生成任务 ID：时间戳 + 随机后缀，避免同毫秒碰撞 */
export function newTaskId(): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${Date.now().toString(36)}-${rand}`
}

/** 构造初始任务状态 */
export function createInitialState(taskId: string, params: VideoTaskParams): TaskState {
  const now = Date.now()
  return {
    taskId,
    status: 'pending',
    progress: 0,
    stage: '',
    params,
    createdAt: now,
    updatedAt: now,
  }
}

/** 原子写入 JSON：先写临时文件再 rename，避免读到半截内容 */
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

/** 读取任务状态；文件缺失或损坏返回 null */
export function readState(taskId: string): TaskState | null {
  const file = path.join(taskDir(taskId), 'state.json')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as TaskState
  } catch {
    return null
  }
}

/** 写入任务状态（自动刷新 updatedAt） */
export function writeState(state: TaskState): void {
  const dir = taskDir(state.taskId)
  ensureDir(dir)
  state.updatedAt = Date.now()
  writeJsonAtomic(path.join(dir, 'state.json'), state)
}

/** 更新任务状态的部分字段（读-改-写；任务不存在时返回 null） */
export function patchState(taskId: string, patch: Partial<TaskState>): TaskState | null {
  const cur = readState(taskId)
  if (!cur) return null
  const next = { ...cur, ...patch }
  writeState(next)
  return next
}

/** 列出所有任务状态，按创建时间倒序 */
export function listStates(): TaskState[] {
  const dir = tasksRoot()
  if (!fs.existsSync(dir)) return []
  const out: TaskState[] = []
  for (const name of fs.readdirSync(dir)) {
    const st = readState(name)
    if (st) out.push(st)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

/** 删除任务目录及其全部产物 */
export function removeTask(taskId: string): boolean {
  const dir = taskDir(taskId)
  if (!fs.existsSync(dir)) return false
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}
