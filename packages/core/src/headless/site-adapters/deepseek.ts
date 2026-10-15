// [deepseek-adapter-v1] 从原硬编码点提取的 DeepSeek 站点适配器
// 所有选择器 / token key / API 路径 / 文案正则均来源于既有硬编码点（grep 定位：packages/core/src/headless/ 下 28 处）
// 行为必须与原实现逐字符对齐，确保守卫测试（limit-marker-guard / rate-marker-guard / fill-verify-guard）零回归

import type { SiteAdapter } from './types.js'
import { DEFAULT_INPUT_SELECTOR } from './types.js'

export const deepseekAdapter: SiteAdapter = {
  name: 'deepseek',
  defaultUrl: 'https://chat.deepseek.com/',

  selectors: {
    // 原 DEFAULT_INPUT_SELECTOR + 既有硬编码通用输入框匹配
    inputBox: DEFAULT_INPUT_SELECTOR,
    // 原 headless-inject-simple.ts:18 / :100 的 .ds-message（含 user + assistant 的外层容器）
    userMessage: '.ds-message',
    // 原 headless-inject.ts / headless-inject-simple.ts 中出现 10+ 次的 .ds-assistant-message-main-content
    assistantMessage: '.ds-assistant-message-main-content',
    // 原 headless-inject-simple.ts:168 / :173 的 .ds-button--circle（停止/发送结构化兜底）
    stopButton: '[role="button"].ds-button--circle, button.ds-button--circle',
    // 原 headless-inject-simple.ts:220 的新对话按钮匹配（走 aria-label/textContent 正则，这里给出通用选择器 + 外部正则过滤）
    newChatButton: 'button, a, [role="button"]',
  },

  login: {
    // 原 headless-inject-simple.ts:235 的 localStorage.getItem('userToken')
    tokenStorageKey: 'userToken',
    // 原 ai-headless.ts:242 的 loggedOutPathRegex: /sign_in|login/i（排除登录页）
    loggedOutPathRegex: 'sign_in|login',
  },

  completionApi: {
    // 原 ai-headless.ts:102 的 responseUrl.hostname !== 'chat.deepseek.com'
    hostname: 'chat.deepseek.com',
    // 原 ai-headless.ts:102 的 responseUrl.pathname !== '/api/v0/chat/completion'
    pathname: '/api/v0/chat/completion',
  },

  // 文案正则：全部来自既有 headless-inject.ts / headless-inject-simple.ts 硬编码，flags='gi' 在浏览器侧构造
  textPatterns: {
    // 原 headless-inject.ts / headless-inject-simple.ts 的 /当前问题已停止|已停止生成|已停止回答/g
    stopped: '当前问题已停止|已停止生成|已停止回答',
    // 原 headless-inject.ts:122 / headless-inject-simple.ts:117 / :296 的频控正则（三条同构）
    rateLimited: '(?:消息|发送|操作|请求|访问)过于频繁|过于频繁[，,\\s]*请稍后重试|please\\s+slow\\s+down|too\\s+many\\s+requests|rate\\s+limit',
    // 原 headless-inject.ts:163 / headless-inject-simple.ts:278 的会话触顶正则（三条同构，含英文分支收紧）
    contextLimit: '(?:(?:达到|已达|超出|超过)\\s*(?:对话|会话|上下文)(?:长度)?\\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?\\s*(?:已达|已达到|达到|超出|超过)\\s*(?:上限|最大长度|超限|过长)|(?:对话|会话|上下文)(?:长度)?超限|(?:对话|会话|上下文)(?:长度)?\\s*(?:上限|最大长度|过长))(?:[，,：:]\\s*请?|请)(?:开启|开始|新建|创建)(?:一个)?新(?:对话|会话)|context length (?:limit|exceeded|too long)|maximum context length (?:is|of)\\s*\\d+|maximum context length\\s+\\d+\\s*tokens',
    // 原 headless-inject.ts:108 / headless-inject-simple.ts:272 的服务繁忙正则
    serverBusy: 'server busy, please try again later\\.?|(?:服务器|服务)繁忙[^\\n。！!]*[。！!]?',
  },
}
