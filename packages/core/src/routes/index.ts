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
// [vcs-svn-log-v1] VCS 无关的只读入口（当前：SVN 提交历史）——非 git 仓库下 /git/* 整体不可用
import { vcsHono } from './vcs.js'
import { hooksHono } from './hooks.js'
import { skillsHono } from './skills.js'
import { lessonsHono } from './lessons.js'
// [userscript-update-v1] 油猴脚本安装/更新入口（工作台 header 按钮消费）
import { userscriptHono } from './userscript.js'
import { sessionHono } from './session.js'
import { selfcheckHono } from './selfcheck.js'
import { restartHono } from './restart.js'
// [send-trace-v1] 出站 fill 留痕入口（页面通道每次投递上报一条 ⇒ logs/send.jsonl）
import { sendLogHono } from './send-log.js'
// [wiki-proxy-v1] LLM Wiki 知识库代理（工作台「知识库」面板消费）
import { wikiHono } from './wiki.js'
// [bg-stream-v1] 后台长任务日志增量读取（前端流式显示）
import { shellLogHono } from './shell-log.js'
// [arrive-log-v1] 脚本到达前端的留痕入口（页面通道每推一条上报一次 ⇒ logs/arrive.jsonl）
import { arriveLogHono } from './arrive-log.js'
import { videoHono } from './video.js'
// [subagent-route-v1] 子智能体编排入口（任务提交/查询/取消）
import { subagentHono } from './subagent.js'

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
  vcsHono,
  hooksHono,
  skillsHono,
  lessonsHono,
  userscriptHono,
  sessionHono,
  selfcheckHono,
  restartHono,
  sendLogHono,
  wikiHono,
  shellLogHono,
  arriveLogHono,
  videoHono,
  subagentHono,
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
  // [vcs-svn-log-v1] 与 /git 并列：只读历史读取，SVN 工作副本下由它接管（git 下返回 vcs='git' 让前端走原链路）
  '/vcs',
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
  '/restart',
  '/send-log',
  // [wiki-proxy-v1] 与工作区无关，故在 server/handle.ts 的 WORKSPACE_EXEMPT_PREFIXES 中豁免
  '/wiki',
  // [bg-stream-v1] 后台任务日志轮询。**刻意不进** WORKSPACE_EXEMPT_PREFIXES：
  //   日志文件就在工作区的 .ai-runner/tmp 下，无工作区时本就无任务可查（豁免反而会让 getRoot() 落到旧 cwd）
  '/shell-log',
  // [arrive-log-v1] 到达留痕。**同 shell-log 刻意不进**豁免：日志落在工作区的 .ai-runner/logs 下，
  //   无工作区时本就无会话可记（豁免反而会让 getRoot() 落到旧 cwd）
  '/arrive-log',
  '/video',
]
