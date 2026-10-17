/* eslint-disable ts/no-unused-vars, unused-imports/no-unused-vars -- 兼容 fs API 签名 / catch 兼容 */
// ==UserScript==
// @name         AI Runner · 会话 ID + 用量估算 + 回复回传 + fill 接收
// @namespace    ai-runner
// @version      1.9.5
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
(function () {
  'use strict'
