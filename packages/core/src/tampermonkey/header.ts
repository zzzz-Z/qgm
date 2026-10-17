// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。

/* eslint-disable ts/no-unused-vars, unused-imports/no-unused-vars -- 兼容 fs API 签名 / catch 兼容 */
// ==UserScript==
// @name         AI Runner · 会话 ID + 用量估算 + 回复回传 + fill 接收
// @namespace    ai-runner
// @version      __TM_VERSION__
// @description  回传会话 ID/用量/AI 回复到工作台；[fragment-guard-v1]；接收 fill/stop；[reply-mark-v1] 回复标记统一为「首行标记行 + 第二行起载荷」：SCRIPT / ASK / DONE / HANDOFF（@ask、# 任务 保留为过渡别名）
// @match        https://chat.deepseek.com/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @match        https://kimi.moonshot.cn/*
// @match        https://gemini.google.com/*
// @match        *://*.qianwen.com/*
// @match        *://*.qianwen.ai/*
// @match        *://*.aliyun.com/*
// @match        *://*.tongyi.cn/*
// @match        *://*.qianwen.cn/*
// @match        https://chatglm.cn/*
// @run-at       document-idle
// @grant        none
// @updateURL    http://127.0.0.1:5178/tampermonkey-session-id.user.js
// @downloadURL  http://127.0.0.1:5178/tampermonkey-session-id.user.js
// ==/UserScript==

/**
 * 用户脚本元数据头 + IIFE 开括号 —— 必须是拼接顺序的第一段。
 *
 * [CONSTRAINT] Tampermonkey 只认文件头部的 ==UserScript== 块，前面出现任何非注释内容
 *   都会让脚本不被识别为可用脚本。故本段所有代码都写在元数据**之后**。
 * [CONSTRAINT] @version 的真实值不在本文件：这里是版本占位符，
 *   由 scripts/tampermonkey-version.json 提供、buildUserscript 注入（[userscript-version-inject-v1]）。
 *   理由：版本号是发布元数据而非脚本逻辑；放在构建输入里，构建才能在内容变化时自动递增。
 * [CONSTRAINT] @version 只在此处声明一次：Tampermonkey 靠它判断更新，
 *   内容改了版本号不变会让更新链路静默失效（无任何报错）。
 * [CONSTRAINT] @grant none 是刻意的：脚本只用 postMessage 与 DOM，
 *   不需要任何 GM_ 特权 API，也就不受 Tampermonkey 沙箱 API 变更影响。
 * [CONSTRAINT] IIFE 开括号必须在本段：所有片段拼回后要落在同一个函数作用域内，
 *   跨片段的 const/let 才互相可见。
 */
