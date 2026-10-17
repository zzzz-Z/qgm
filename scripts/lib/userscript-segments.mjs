// @desc 用户脚本片段清单与组装逻辑 —— assemble 脚本与一致性守卫的唯一来源
// @why 守卫若自己拼 .ts 原文去比对转译产物，口径必然不等；两边共用同一份实现才可比

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * 拼接顺序即 IIFE 内的声明顺序。
 * [CONSTRAINT] 函数声明会提升，但 const/let 不会——顺序错会让首发上报读到未初始化的变量。
 */
export const SEGMENTS = [
  'header',
  'types',
  'hash',
  'language',
  'markdown',
  'marks',
  'roots',
  'session',
  'limits',
  'state',
  'stop',
  'script-extract',
  'detect',
  'fence',
  'emit',
  'dispatch',
  'observer',
  'fill',
  'actions',
  'listener',
  'channel',
  'bootstrap',
]

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
export function buildUserscript(srcDir) {
  const [headName, typesName, ...bodyNames] = SEGMENTS
  const head = transpileSegment(srcDir, headName)
  // types 段是纯 interface/type 声明，转译后为空——但它前面的注释块不能落在元数据之前
  const types = transpileSegment(srcDir, typesName)
  const body = bodyNames.map(n => transpileSegment(srcDir, n)).join('\n\n')
  // 顺序：==UserScript== 元数据 → IIFE 开括号 → types 注释块 → 其余片段 → IIFE 收口
  return `${head}\n(function () {\n  'use strict'\n\n${types}\n\n${body}\n})()\n`
}
