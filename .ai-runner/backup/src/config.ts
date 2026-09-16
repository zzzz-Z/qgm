import path from 'node:path'

// pkg-structure
export let ROOT = process.cwd()
export function setRoot(r: string): void {
  ROOT = path.resolve(r)
}
export function getRoot(): string {
  return ROOT
}
export const RUNS_DIR = path.join(ROOT, '.ai/runs')
export const SCRIPTS_DIR = path.join(ROOT, '.ai/scripts')
export const LOGS_DIR = path.join(ROOT, '.ai/logs')
export const BACKUP_DIR = path.join(ROOT, '.ai/backup')
export const PREFIX = '/__ai'

export const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.vite', '.turbo', '.cache'])
export const EXCLUDE_PREFIX = ['.ai']
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
  script: string
  exit: number
  durationMs: number
  changeCount: number
  changes: Change[]
  errorFiles: string[]
}
