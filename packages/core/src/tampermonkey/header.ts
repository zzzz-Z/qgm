// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 用户脚本元数据头 + IIFE 开括号。
 *
 * [CONSTRAINT] 本文件必须是拼接顺序的第一段：Tampermonkey 只认文件头部的
 *   ==UserScript== 块，前面出现任何非注释内容都会让脚本不被识别为可用脚本。
 * [CONSTRAINT] @version 只在此处声明一次：Tampermonkey 靠它判断更新，
 *   内容改了版本号不变会让更新链路静默失效（无任何报错）。
 * [CONSTRAINT] @grant none 是刻意的：脚本只用 postMessage 与 DOM，
 *   不需要任何 GM_ 特权 API，也就不受 Tampermonkey 的沙箱 API 变更影响。
 */
