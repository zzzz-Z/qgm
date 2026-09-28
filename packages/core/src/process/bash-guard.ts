/**
 * bash 命令静态安全门禁 + 环境变量白名单（v6 §8.4 / §8.8）。
 *
 * 设计原则：黑名单不完备是已知残余风险，唯一兜底是 git 保护（§8.3）。
 * 命中黑名单即拒绝执行，不重试、不弹窗（v6 §6.9 第 5 条）。
 */

/** 命中即拒的破坏性命令模式（10 条，来自 v6 §8.4）。大小写不敏感。 */

/** bash 命令黑名单：命中直接拒绝执行 */
export const BASH_BLACKLIST: ReadonlyArray<{ pattern: RegExp, label: string }> = [
  { pattern: /\brm\s+-rf\b/i, label: 'rm -rf' },
  { pattern: /\bsudo\b/i, label: 'sudo' },
  { pattern: /curl\s+[^\s|]+\s*\|\s*(sh|bash)/i, label: 'curl|sh' },
  { pattern: /wget\s+[^\s|]+\s*\|\s*(sh|bash)/i, label: 'wget|sh' },
  { pattern: /\bdd\s+if=/i, label: 'dd if=' },
  { pattern: /\bmkfs\b/i, label: 'mkfs' },
  { pattern: />\s*\/dev\/sd[a-z]/i, label: '> /dev/sd*' },
  { pattern: /git\s+push\s+(-f|--force)/i, label: 'git push -f' },
  { pattern: /git\s+reset\s+--hard/i, label: 'git reset --hard' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, label: 'fork bomb' },
]

/**
 * 检查命令是否命中黑名单。返回命中的 label（用于错误消息），未命中返回 null。
 */

/**
 * 检查命令是否命中 bash 黑名单（破坏性命令）
 * [WHY] 服务端在执行前统一拦截 rm -rf / sudo / curl|sh 等危险模式
 * [CONSTRAINT] 命中任意一条即返回该规则的 label（供前端展示）；全部未命中返回 null
 * [CHANGE-IMPACT] 返回 label 会作为 err 提示的一部分返回给用户；改 label 文案需同步 i18n 期望
 * @param cmd 待检查的原始命令文本
 */
export function checkBashBlacklist(cmd: string): string | null {
  for (const rule of BASH_BLACKLIST) {
    if (rule.pattern.test(cmd)) return rule.label
  }
  return null
}

/**
 * 允许透传给子进程的环境变量白名单。
 * 项目密钥（DEEPSEEK_API_KEY 等）不在白名单内，自动剥离。
 */
export const ENV_WHITELIST: ReadonlyArray<string> = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'TZ',
  'PWD',
  'USER',
]

/**
 * 基于白名单构造 env 对象。未列出的环境变量全部剥离。
 * 注意：PWD 显式设为项目 ROOT（覆盖当前进程 PWD，避免子进程继承错工作目录）。
 */
export function buildEnvWhitelist(rootDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ENV_WHITELIST) {
    const v = process.env[key]
    if (v !== undefined) env[key] = v
  }
  env.PWD = rootDir
  return env
}

// [bash-whitelist-v1] PLAN 7.D3 bash 命令白名单（纯逻辑，供后续接线；不改现有黑名单行为）

/** bash 命令白名单：只有列出的命令允许执行 */
export const BASH_WHITELIST_CMDS: ReadonlyArray<string> = [
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'find',
  'sed',
  'awk',
  'sort',
  'uniq',
  'cut',
  'tr',
  'echo',
  'printf',
  'pwd',
  'cd',
  'mkdir',
  'cp',
  'mv',
  'touch',
  'node',
  'npx',
  'pnpm',
  'npm',
  'git',
  'curl',
  'sleep',
  'date',
]

/** 白名单判定结果：允许 / 拒绝 / 需人工确认 */
export type WhitelistVerdict = 'allow' | 'unknown' | 'blocked'

/** 白名单检查结果：判定 + 命中规则 */
export interface WhitelistResult {
  verdict: WhitelistVerdict
  cmd: string
  reason?: string
}

/**
 * 提取一条 shell 命令的首个 token（命令名），忽略前导空白与 VAR=val 前缀。
 * 简单按空白与 ; && || | 切分；不做 shell 解析（避免引入复杂度）。
 */
function firstCmd(line: string): string {
  const cleaned = String(line).trim().replace(/^([A-Z_]\w*=\S+\s+)+/i, '')
  const m = cleaned.match(/^([a-z_][\w.-]*)/i)
  return m ? m[1] : ''
}

/**
 * 按行 / 分号 / && / || 切分脚本为独立命令
 * [WHY] 白名单校验需逐条判定；不解析子 shell、管道、重定向，只做粗切分
 * [CONSTRAINT] 不做引号转义处理 —— 引号内的分隔符也会被切开（罕见，可接受）
 * [CHANGE-IMPACT] 结果被 checkBashWhitelist 消费；若误切会导致合法命令被误报为 unknown
 * @param script 待切分的 bash 脚本全文
 */
export function splitCommands(script: string): string[] {
  return String(script)
    .split(/\n|;|&&|\|\|/g)
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * 静态白名单判定：
 *  - blocked: 命中现有黑名单
 *  - allow:   所有命令都在白名单
 *  - unknown: 存在未在白名单且未黑名单的命令（需人工确认）
 */
export function checkBashWhitelist(script: string): WhitelistResult {
  const lines = splitCommands(script)
  for (const l of lines) {
    const hit = checkBashBlacklist(l)
    if (hit) return { verdict: 'blocked', cmd: l, reason: hit }
  }
  const unknowns: string[] = []
  for (const l of lines) {
    const c = firstCmd(l)
    if (!c) continue
    if (!BASH_WHITELIST_CMDS.includes(c)) unknowns.push(c)
  }
  if (unknowns.length) {
    return { verdict: 'unknown', cmd: unknowns[0], reason: `未在白名单: ${unknowns.join(',')}` }
  }
  return { verdict: 'allow', cmd: firstCmd(lines[0] || '') }
}
/** bash 默认超时 120s（v6 §8.2） */
export const BASH_TIMEOUT_MS = 120_000
