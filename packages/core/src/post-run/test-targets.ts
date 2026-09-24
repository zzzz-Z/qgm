// AIRUNNER-BATCH11-3-SPLIT-TEST: 从 test.ts 抽出的纯函数（buildTestArgs）；无外部依赖，strip-types 可加载

/** 测试命令参数结构 */
export interface TestArgs {
  ran: boolean
  args: string[]
}

/** 从字符串中剥离特定片段的正则 */
const STRIP_RE = /\.(?:ts|mts|cts)$/

/**
 * 根据测试文件列表构造 node:test 运行参数。
 * - 空列表 → ran=false，不构造参数
 * - 含 .ts/.mts/.cts → 追加 --experimental-strip-types
 * - 否则 → 仅 --test + 文件
 */

/**
 * 构建 Test Args
 * @param testFiles - test Files
 */
export function buildTestArgs(testFiles: string[]): TestArgs {
  if (!testFiles.length) return { ran: false, args: [] }
  const needsStrip = testFiles.some(f => STRIP_RE.test(f))
  const args = needsStrip ? ['--test', '--experimental-strip-types', ...testFiles] : ['--test', ...testFiles]
  return { ran: true, args }
}
