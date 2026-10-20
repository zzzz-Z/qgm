// @desc 用户脚本片段清单与组装逻辑 —— assemble 脚本与一致性守卫的唯一来源
// @why 守卫若自己拼 .ts 原文去比对转译产物，口径必然不等；两边共用同一份实现才可比

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * 拼接顺序即 IIFE 内的声明顺序。
 * [CONSTRAINT] 函数声明会提升，但 const/let 不会——顺序错会让首发上报读到未初始化的变量。
 */
export const SEGMENTS = [
  'header',
  'types',
  'hash',
  // [turn-emit-v1] 信封解析器必须在 turn-emit 之前：parseTurn 是函数声明（会提升），
  // 但 TURN_BLOCK_TYPES / TURN_SCRIPT_LANGS 是 const，同一 IIFE 内未初始化即引用会抛 TDZ。
  'turn-schema',
  'language',
  'markdown',
  // [legacy-marks-removed-v1] `marks`（首行 SCRIPT/ASK/DONE/HANDOFF/TEXT 扫描）已删：
  //   契约 §1 只允许 ```json 围栏包住的 turn 信封，回复不再有「首行标记」这回事。
  'roots',
  'session',
  'limits',
  'state',
  'stop',
  'detect',
  // [legacy-marks-removed-v1] `emit`（旧 script / plain 两条回传通道）已删：
  //   脚本只经 turn 信封下发（turn-emit），裸文本按契约整轮丢弃，不再回传。
  'turn-emit',
  'dispatch',
  'observer',
  'fill',
  'actions',
  'listener',
  'channel',
  'bootstrap',
]

/**
 * 版本号文件（入库，唯一事实来源）。
 * [WHY] 版本号是发布元数据而非脚本逻辑：放进片段里，构建就只能靠人手动递增；
 *   独立成构建输入后，构建能在「内容有变」时自动递增（[userscript-version-inject-v1]）。
 * [CONSTRAINT] 只由 assemble-userscript.mjs 写；守卫读它来渲染期望产物。
 */
const VERSION_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'tampermonkey-version.json')

/** 产物里版本的占位符；header.ts 声明它，buildUserscript 替换成真实值 */
export const VERSION_PLACEHOLDER = '__TM_VERSION__'

/** 读当前版本号 */
export function readVersion() {
  return JSON.parse(readFileSync(VERSION_FILE, 'utf8')).version
}

/** 写版本号（仅 assemble 使用） */
export function writeVersion(v) {
  writeFileSync(VERSION_FILE, `${JSON.stringify({ version: v }, null, 2)}\n`)
}

/** 片段头部的固定说明块：转译时必须剥掉，否则产物里会重复 21 段同样的注释 */
const SEGMENT_HEADER = /^\/\/ @ts-nocheck\n(?:\/\/[^\n]*\n){0,6}/

/**
 * 单文件转译：module: None 保证不产出 import/export（片段不是模块）。
 * [CONSTRAINT] removeComments 必须为 false：片段里的 WHY/CONSTRAINT 注释是产物的一部分，
 *   线上排障时只能读产物。
 */
export function transpileSegment(srcDir, name) {
  const src = readFileSync(join(srcDir, `${name}.ts`), 'utf8').replace(SEGMENT_HEADER, '')
  const out = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed,
    },
    fileName: `${name}.ts`,
  }).outputText
  return out.replace(/\s+$/, '')
}

/**
 * 组装完整产物：header 段（仅元数据注释）在最前，其余片段包进 IIFE。
 * [WHY] IIFE 外壳必须在这里注入而不是写进片段：片段要语法平衡，
 *   否则单文件增量检查解析失败（tsconfig exclude 只影响全量检查）。
 */
export function buildUserscript(srcDir, version = readVersion()) {
  const [headName, typesName, ...bodyNames] = SEGMENTS
  const head = transpileSegment(srcDir, headName)
  // types 段是纯 interface/type 声明，转译后为空——但它前面的注释块不能落在元数据之前
  const types = transpileSegment(srcDir, typesName)
  const body = bodyNames.map(n => transpileSegment(srcDir, n)).join('\n\n')
  // 顺序：==UserScript== 元数据 → IIFE 开括号 → types 注释块 → 其余片段 → IIFE 收口
  // [userscript-version-inject-v1] 版本占位符在此替换：片段里保持占位符，产物里是真实版本
  return `${head}\n(function () {\n  'use strict'\n\n${types}\n\n${body}\n})()\n`.split(VERSION_PLACEHOLDER).join(version)
}
