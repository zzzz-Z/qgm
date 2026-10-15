// [chatglm-adapter-v1] 智普清言站点适配器
// 侦察来源：.ai-runner/tmp/chatglm-quick.json（2026-10-15）、chatglm-full-scan.json
// 注意：智普清言有滑动验证码 + WAF 拦截——headless 通道可能不可用，优先支持 tampermonkey 通道

import type { SiteAdapter } from './types.js'
import { DEFAULT_INPUT_SELECTOR } from './types.js'

// 侦察发现的初始线索（需登录态 DOM 快照进一步确认后补全）
export const chatglmAdapter: SiteAdapter = {
  name: 'chatglm',
  defaultUrl: 'https://chatglm.cn/main/alltoolsdetail',

  selectors: {
    // 侦察到 textarea 存在但 class 为空（可能多个 textarea 含辅助文本）
    inputBox: DEFAULT_INPUT_SELECTOR,
    // 侦察到 .conversation-container / .conversation-inner 但未找到消息气泡选择器
    userMessage: '[class*="message"], [class*="bubble"]',
    // 待登录态 DOM 快照确认（暂用通用对话容器）
    assistantMessage: '[class*="message"], [class*="bubble"], .conversation-inner',
    // 待侦察补充
    stopButton: '[role="button"]',
    newChatButton: 'button, a, [role="button"], .enter.is-main-chat',
  },

  login: {
    // 侦察到 localStorage 无明确 token key（认证机制可能是 cookie）
    // 留空表示不用 localStorage 检测，登录态检测退回"输入框可见 + 非拦截路径"判定
    loggedOutPathRegex: 'login|sign_in',
  },

  completionApi: {
    // 侦察到的 API pattern：chatglm.cn/chatglm/mainchat-api/*、operation-api/*
    hostname: 'chatglm.cn',
    // completion 路径待侦察补充
    pathname: '/chatglm/mainchat-api/',
  },

  textPatterns: {
    // 智普清言文案正则待 DOM 快照+API 错误响应确认后补全
    // 先用通用中文探针作 placeholder，后续侦察到真实文案后替换
    stopped: '已停止|停止生成|已停止回答',
    rateLimited: '过于频繁|请稍后重试|rate\\s*limit|too\\s*many\\s*requests',
    contextLimit: '对话(?:长度)?(?:已达上限|达到上限|超限|过长)|上下文(?:长度)?(?:已达上限|达到上限|超限|过长)|context length|maximum context length',
    serverBusy: '服务器繁忙|服务繁忙|server busy|请求过于频繁',
  },
}
