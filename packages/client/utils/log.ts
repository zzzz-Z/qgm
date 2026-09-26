// [p1-1-v1] 客户端统一日志：生产抑制 debug/info，warn/error 保留；本文件是全客户端唯一 console 出口
// [p1-1-v1] 宽档豁免：import.meta.env 为 Vite 运行时注入，类型未在 tsconfig 显式 include
const isDev = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)

/** 客户端日志：dev 输出 debug/info，warn/error 恒输出 */
export const log = {
  debug: (...args: unknown[]) => { if (isDev) console.debug(...args) },
  info: (...args: unknown[]) => { if (isDev) console.info(...args) },
  warn: (...args: unknown[]) => { console.warn(...args) },
  error: (...args: unknown[]) => { console.error(...args) },
}
