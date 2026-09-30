// [arch-hono/barrel-v1] Hono 路由聚合 barrel（HCLC 豁免：index.ts）
import { workspaceHono } from './workspace.js'
import { scriptHono } from './script.js'
import { rollbackHono } from './rollback.js'
import { execHono } from './exec.js'
import { tasksHono } from './tasks.js'
import { filesHono } from './files.js'
import { filesReadHono } from './files-read.js'
import { presetHono } from './preset.js'
import { logsHono } from './logs.js'
import { searchHono } from './search.js'
import { runHono } from './run.js'
import { gitHono } from './git.js'
import { hooksHono } from './hooks.js'

/** 所有子路由 Hono 应用实例列表 */
export const HONO_SUB_APPS = [
  workspaceHono,
  scriptHono,
  rollbackHono,
  execHono,
  tasksHono,
  filesHono,
  filesReadHono,
  presetHono,
  logsHono,
  searchHono,
  runHono,
  gitHono,
  hooksHono,
]

// 已迁移到 Hono 的路径前缀——dispatchHono 只对这些前缀做 bridge
/** 已迁移到 Hono 的路径前缀列表 */
export const HONO_PREFIXES = [
  '/workspace',
  '/script',
  '/rollback',
  '/rollback-all',
  '/save',
  '/git',
  '/hooks',
  '/exec',
  '/tasks',
  '/files',
  '/logs',
  '/search',
  '/diff-from-baseline',
  '/run',
  '/preset',
]
