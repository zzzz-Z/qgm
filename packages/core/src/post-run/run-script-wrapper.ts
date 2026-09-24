// AIRUNNER-BATCH11-4-WRAPPER: 从 run-script.ts 抽出的纯函数（buildWrapperCode）；无外部依赖

/**
 * 构造 -e 执行的 wrapper 代码：捕获 uncaughtException / unhandledRejection，
 * 并 try/catch 加载脚本入口；失败将 process.exitCode 置 1。
 */

/**
 * 构建 Wrapper Code
 * @param scriptPath - script Path
 */
export function buildWrapperCode(scriptPath: string): string {
  const lines = [
    'process.on(\'uncaughtException\', (e) => {',
    '  console.error(\'[uncaughtException]\', e?.stack || e);',
    '  process.exitCode = 1;',
    '});',
    'process.on(\'unhandledRejection\', (e) => {',
    '  console.error(\'[unhandledRejection]\', e?.stack || e);',
    '  process.exitCode = 1;',
    '});',
    `try { require(${JSON.stringify(scriptPath)}); }`,
    'catch(e) { console.error(\'[script error]\', e?.stack || e); process.exitCode = 1; }',
  ]
  return `\n    ${lines.join('\n    ')}\n  `
}
