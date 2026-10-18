// @desc turn 信封契约的产物生成/校验共用的纯逻辑（无副作用、可被守卫直接 import）
// @why 入口脚本一旦被 import 就会执行写盘；守卫需要的是「同一套规范化与指纹算法」，
//   不是构建动作本身。与 scripts/lib/userscript-segments.mjs 同一范式：库 + 薄入口。
import { createHash } from 'node:crypto'

/** 生成产物清单。新增运行端只需在这里加一条（P2 会加无头内联段） */
export const TARGETS = [
  {
    rel: 'packages/client/utils/turn-schema.ts',
    mode: 'module',
    // 前端是 TS 包，纯 JS 源要靠 @ts-nocheck 才过类型检查；同时要豁免 ban-ts-comment
    header: [
      '/* eslint-disable ts/ban-ts-comment -- 纯 JS 源，由 scripts/sync-turn-schema.mjs 生成 */',
      '// @ts-nocheck',
    ],
  },
  {
    rel: 'packages/core/src/tampermonkey/turn-schema.ts',
    mode: 'fragment',
    header: ['// @ts-nocheck'],
  },
]

export const SOURCE_REL = 'packages/core/src/reply/turn-schema.ts'
export const BEGIN = '// >>> BEGIN turn-schema'
export const END = '// <<< END turn-schema'

/**
 * 规范化：统一换行、去行尾空白、折叠多余空行。
 * [CONSTRAINT] 指纹必须只取决于**代码内容**，不能受编辑器换行风格影响，否则跨机器必红。
 */
export function normalize(src) {
  const body = String(src).replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n')
  return `${body.replace(/\n{3,}/g, '\n\n').trim()}\n`
}

/**
 * 规范代码体：去掉仅在源文件里成立的头两行（eslint 豁免 / ts-nocheck）。
 * [WHY] 哈希覆盖「代码体」而不是整个文件——三处外壳不同（模块 / IIFE 片段 / 函数内联），
 *   但代码体必须逐字同源，指纹才有意义。
 * [CONSTRAINT] 本函数**与 mode 无关**。若把它按 mode 分支，fragment 去掉 `export` 后
 *   哈希就与 module 不同，于是「三处同一份源码」这个判据退化成「三处各自自洽」——
 *   2026-10-19 实测正是如此（cb5aa898… vs 43fa6678…）。指纹只能由源决定。
 */
export function canonicalBody(src) {
  return `${normalize(src)
    .split('\n')
    .filter(l => !/^\/\* eslint-disable ts\/ban-ts-comment/.test(l))
    .filter(l => !/^\/\/ @ts-nocheck/.test(l))
    .join('\n')
    .trim()}\n`
}

/**
 * 抽出某个运行端实际要嵌入的代码体：在规范体基础上做该端的外壳适配。
 * 目前唯一的差异是 fragment（油猴 IIFE 内）不能有顶层 `export`。
 * [NOTE] 适配发生在**算哈希之后**，所以嵌入体可以与源有差异，而指纹仍然相等。
 */
export function sharedBody(src, mode) {
  const body = canonicalBody(src)
  return mode === 'fragment' ? `${body.replace(/^export /gm, '').trim()}\n` : body
}

/** 源 → 指纹（sha256 前 16 位十六进制） */
export function fingerprint(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16)
}

/** 渲染一个产物：指纹头 + 生成说明 + 标记 + 代码体 + 收尾标记 */
export function render(target, body, hash) {
  const lines = [
    `/* @turn-schema:${hash} */`,
    `// 由 scripts/sync-turn-schema.mjs 从 packages/core/src/reply/turn-schema.ts 生成，请勿手改。`,
    ...target.header,
    '',
    BEGIN,
    body.replace(/\n$/, ''),
    END,
    '',
  ]
  return lines.join('\n')
}

/**
 * 从任意产物（含未来的无头内联段）里抠出代码体，用于守卫双向对拍。
 * [WHY] 守卫不能只比嵌入哈希：手改产物不会改变它自己写的哈希，那样「产物被改」就漏检了。
 *   必须同时比代码体，且对内联段要能剥掉统一缩进。
 * @param text 产物全文
 * @returns 代码体；找不到标记返回 null
 */
export function extractBody(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const s = lines.findIndex(l => l.includes(BEGIN))
  const e = lines.findIndex(l => l.includes(END))
  if (s < 0 || e < 0 || e <= s) return null
  let body = lines.slice(s + 1, e)
  const indents = body.filter(l => l.trim().length > 0).map(l => l.match(/^ */)[0].length)
  const common = indents.length ? Math.min(...indents) : 0
  if (common > 0) body = body.map(l => l.slice(common))
  return `${body.join('\n')}\n`
}

/** 从产物里读出嵌入的指纹；缺失返回空串 */
export function readFingerprint(text) {
  const m = String(text).match(/@turn-schema:([0-9a-f]{16})/)
  return m ? m[1] : ''
}
