/**
 * bash 命令静态安全门禁 + 环境变量白名单（v6 §8.4 / §8.8）。
 *
 * 设计原则：黑名单不完备是已知残余风险，唯一兜底是 git 保护（§8.3）。
 * 命中黑名单即拒绝执行，不重试、不弹窗（v6 §6.9 第 5 条）。
 */

/** 命中即拒的破坏性命令模式（10 条，来自 v6 §8.4）。大小写不敏感。 */
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

/** bash 默认超时 120s（v6 §8.2） */
export const BASH_TIMEOUT_MS = 120_000
