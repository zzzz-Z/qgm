import path from 'node:path'

// pkg-structure
export let ROOT = process.cwd()
export function setRoot(r: string): void {
  ROOT = path.resolve(r)
  // ESM live bindings：import 方在 setRoot 后读到的是新值
  RUNS_DIR = path.join(ROOT, '.ai-runner/runs')
  SCRIPTS_DIR = path.join(ROOT, '.ai-runner/scripts')
  LOGS_DIR = path.join(ROOT, '.ai-runner/logs')
  BACKUP_DIR = path.join(ROOT, '.ai-runner/backup')
}
export function getRoot(): string {
  return ROOT
}
export let RUNS_DIR = path.join(ROOT, '.ai-runner/runs')
export let SCRIPTS_DIR = path.join(ROOT, '.ai-runner/scripts')
export let LOGS_DIR = path.join(ROOT, '.ai-runner/logs')
export let BACKUP_DIR = path.join(ROOT, '.ai-runner/backup')
export const PREFIX = '/__ai'

export const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.vite', '.turbo', '.cache'])
export const EXCLUDE_PREFIX = ['.ai-runner']
export const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.webm',
  '.zip',
  '.gz',
  '.tar',
  '.pdf',
  '.xls',
  '.xlsx',
  '.doc',
  '.docx',
])

export type ChangeType = 'added' | 'modified' | 'deleted'

export interface Change {
  path: string
  type: ChangeType
  afterLines?: number
}

export interface Manifest {
  changes: Change[]
  createdAt: number
}

export interface RunLogEntry {
  ts: number
  runId: string
  desc?: string
  why?: string
  script: string
  exit: number
  durationMs: number
  changeCount: number
  changes: Change[]
  errorFiles: string[]
  fingerprints?: Array<{ file: string, line: number, symbol: string, kind: string }>
}
