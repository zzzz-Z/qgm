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
    'let __returned;',
    'let __hadOutput = false;',
    'let __wrapped = false;',
    'const __origLog = console.log; const __origErr = console.error;',
    'console.log = (...a) => { __hadOutput = true; __origLog(...a); };',
    'console.error = (...a) => { __hadOutput = true; __origErr(...a); };',
    'try {',
    '  const __vm = require("node:vm");',
    '  const __fs = require("node:fs");',
    `  const __src = __fs.readFileSync(${JSON.stringify(scriptPath)}, "utf8");`,
    `  __returned = __vm.runInThisContext("(function(){" + __src + "\\n})()", { filename: ${JSON.stringify(scriptPath)} });`,
    '  __wrapped = true;',
    '} catch (__e) {',
    `  if (!__wrapped) { try { require(${JSON.stringify(scriptPath)}); } catch (e2) { console.error("[script error]", e2 && e2.stack || e2); process.exitCode = 1; } }`,
    '  else { console.error("[script error]", __e && __e.stack || __e); process.exitCode = 1; }',
    '}',
    'console.log = __origLog; console.error = __origErr;',
    'if (!__hadOutput && typeof __returned === "string" && __returned.trim()) { __origLog(__returned); }',
  ]
  return `\n    ${lines.join('\n    ')}\n  `
}
