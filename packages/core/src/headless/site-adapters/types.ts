// SiteAdapter —— 站点适配器接口
// 所有字段必须是纯数据（字符串、正则字面量），因为会被 page.evaluate 序列化进浏览器执行
// 不能是闭包引用、不能是 new RegExp() 实例（序列化后变成 {}）

/** 输入框选择器（通用匹配 textarea 和 contenteditable） */
export const DEFAULT_INPUT_SELECTOR = 'textarea:not([readonly]):not([disabled]), [contenteditable="true"]'

/** 站点适配器接口 */
export interface SiteAdapter {
  /** 站点唯一标识 */
  name: string
  /** 默认入口 URL */
  defaultUrl: string

  /** DOM 选择器集合（全部是字符串，用于 document.querySelectorAll） */
  selectors: {
    /** 输入框（textarea / contenteditable） */
    inputBox: string
    /** 消息容器（含 user + assistant，用于 verifyFillSent 增量检测） */
    userMessage: string
    /** 仅 AI 回复容器（detectReplyInPage 主力选择器） */
    assistantMessage: string
    /** 停止生成按钮（结构化兜底用） */
    stopButton: string
    /**
     * 站点专属「生成中」信号选择器（如智谱 .enter.is-main-chat.searching）。
     * 未声明的站点保持既有通用逻辑（标签通道 + DeepSeek 圆钮图签名），行为零变化。
     */
    generatingSelector?: string
    /** 新建会话按钮（clickNewSessionInPage 用） */
    newChatButton: string
  }

  /** 登录态检测 */
  login: {
    /** localStorage 中的认证 token key（留空表示不用 localStorage 检测） */
    tokenStorageKey?: string
    /** 被登出时的 URL path 正则（用于 loginAutoClose 判断） */
    loggedOutPathRegex?: string
  }

  /** completion API 错误捕获 */
  completionApi?: {
    /** API hostname（response URL 匹配用） */
    hostname: string
    /** API pathname（精确匹配） */
    pathname: string
  }

  /** 文案探针正则（全部是字符串，序列化后在浏览器里 new RegExp 构造） */
  textPatterns: {
    /** 停止生成 / 已停止回答 提示 */
    stopped: string
    /** 频控提示 */
    rateLimited: string
    /** 会话触顶 / 长度上限 */
    contextLimit: string
    /** 服务繁忙 */
    serverBusy: string
  }
}
