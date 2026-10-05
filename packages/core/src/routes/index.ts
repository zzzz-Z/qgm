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
import { skillsHono } from './skills.js'
import { lessonsHono } from './lessons.js'
// [userscript-update-v1] 油猴脚本安装/更新入口（工作台 header 按钮消费）
import { userscriptHono } from './userscript.js'
import { sessionHono } from './session.js'
import { selfcheckHono } from './selfcheck.js'

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
  skillsHono,
  lessonsHono,
  userscriptHono,
  sessionHono,
  selfcheckHono,
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
  '/skills',
  '/lessons',
  // [userscript-update-v1] 与工作区无关，故在 handle.ts 的 WORKSPACE_EXEMPT_PREFIXES 中豁免
  '/userscript',
  '/session',
  '/selfcheck',
]
