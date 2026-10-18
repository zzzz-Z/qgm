// @desc turn 信封契约的产物生成/校验共用的纯逻辑（无副作用、可被守卫直接 import）
// @why 入口脚本一旦被 import 就会执行写盘；守卫需要的是「同一套规范化与指纹算法」，
//   不是构建动作本身。与 scripts/lib/userscript-segments.mjs 同一范式：库 + 薄入口。
import { createHash } from 'node:crypto'

/**
 * 生成产物清单。
 * kind='file'   整文件由生成器拥有（前端副本 / 油猴片段）
 * kind='inline' 只替换文件里 BEGIN…END 之间的区段，区外内容原样保留（无头内联段）
 * [CONSTRAINT] 新增运行端只需加一条；守卫按本清单遍历，不写死数量。
 */
export const TARGETS = [
  {
    rel: 'packages/client/utils/turn-schema.ts',
    kind: 'file',
    mode: 'module',
    // 前端是 TS 包，纯 JS 源要靠 @ts-nocheck 才过类型检查；同时要豁免 ban-ts-comment
    header: [
      '/* eslint-disable ts/ban-ts-comment -- 纯 JS 源，由 scripts/sync-turn-schema.mjs 生成 */',
      '// @ts-nocheck',
    ],
  },
  {
    rel: 'packages/core/src/tampermonkey/turn-schema.ts',
    kind: 'file',
    mode: 'fragment',
    header: ['// @ts-nocheck'],
  },
  {
    // 无头侧必须内联：page.evaluate 的整段函数被序列化送进浏览器，模块级引用会 ReferenceError
    rel: 'packages/core/src/headless/headless-inject.ts',
    kind: 'inline',
    mode: 'fragment',
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
 * 渲染 inline 产物：只替换 `BEGIN…END` 之间，区外（含缩进）逐字保留。
 * [WHY] 无头段的宿主是 `detectReplyInPage` 的函数体，里面有 700 行既有逻辑与大量注释；
 *   整文件重写会让任何一次生成都变成「宿主文件的完整覆盖」，一次缩进或注释差异就是全文件 diff。
 * [CONSTRAINT] 缩进取 BEGIN 行的行首空格数，区内每一行按同一缩进前置：
 *   生成器不做自动重排（原样搬），否则 extractBody 的「剥最小公共缩进」会与源对不上。
 * @param text 现有全文
 * @param body 要写入的代码体（已做 mode 适配）
 * @param hash 源指纹
 * @returns 新全文；找不到标记返回 null（避免把整文件当区段覆盖）
 */
export function renderInline(text, body, hash) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const s = lines.findIndex(l => l.includes(BEGIN))
  const e = lines.findIndex(l => l.includes(END))
  if (s < 0 || e < 0 || e <= s) return null
  const indent = lines[s].match(/^ */)[0]
  // 幂等：先吃掉上一次写在这行上方的指纹注释，否则每跑一次就多一行
  let head = s
  while (head > 0 && lines[head - 1].includes('@turn-schema:')) head -= 1
  const block = [`${indent}/* @turn-schema:${hash} */`, lines[s]]
  for (const l of body.replace(/\n$/, '').split('\n')) block.push(l.length > 0 ? `${indent}${l}` : '')
  block.push(lines[e])
  return [...lines.slice(0, head), ...block, ...lines.slice(e + 1)].join('\n')
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
