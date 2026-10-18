// turn-schema 生成器共用库的声明（实现见同目录 turn-schema-io.mjs）
//
// [WHY] 守卫要 import 这套算法做双向对拍。若无声明，tsconfig.test.json（strict）报 TS7016，
//   只能靠 `@ts-expect-error` 逐处抑制 —— 而抑制会同时盖掉「导出名拼错」这类真错误。
//   声明一通，守卫里的 `extractBody` 返回值也自动带上 `string | null`，少了人工断言。

export interface TurnSchemaTarget {
  /** 产物路径（仓库根相对） */
  rel: string
  /** file=整文件由生成器拥有；inline=只替换 BEGIN…END 区段 */
  kind: 'file' | 'inline'
  /** module=保留 export；fragment=去掉顶层 export（IIFE / 函数体内） */
  mode: 'module' | 'fragment'
  /** 生成头（仅 kind=file） */
  header?: string[]
}

export const TARGETS: TurnSchemaTarget[]
export const SOURCE_REL: string
export const BEGIN: string
export const END: string

export function normalize(src: string): string
export function canonicalBody(src: string): string
export function sharedBody(src: string, mode: string): string
export function fingerprint(body: string): string
export function render(target: TurnSchemaTarget, body: string, hash: string): string
export function renderInline(text: string, body: string, hash: string): null | string
export function extractBody(text: string): null | string
export function readFingerprint(text: string): string
