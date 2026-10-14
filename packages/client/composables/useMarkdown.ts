// @desc 用 markdown-it 渲染 Markdown（GFM 表格 / 删除线 / 链接 / 代码块全套）
// @why 自研极简渲染器只覆盖围栏+内联，表格/链接/删除线缺失；markdown-it 是标准实现，依赖已装
// @change-impact 输出 HTML 由 v-html 消费；TerminalPane（含 AI 提问卡）与 useFileContentHtml 依赖此模块；签名保持 renderMarkdown(src) 不变

import MarkdownIt from 'markdown-it'
// [restore-import-v1] computed 早前被按 auto-import 名单清理时误删：app 侧 unplugin-auto-import 兜底，
// 但 tsc --noEmit 与 vitest 无该插件 → 类型检查报 Cannot find name 'computed'
import { computed } from 'vue'
import type { Ref } from 'vue'

/**
 * markdown-it 单例
 * [WHY] html:false 关闭内联 HTML 透传 —— 防止 AI 回复中的 <script> 等注入；linkify 自动识别裸 URL
 * [CONSTRAINT] breaks:true 让 \n 视作 <br>（AI 常以单换行分隔条目）；不在构造期做 sanitize，靠 html:false 兜底
 * [CHANGE-IMPACT] 修改 options 会同时影响 TerminalPane 与文件内容预览两处的渲染结果
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
})

// [md-class-compat-v1] 为 fenced code / inline code 补回自定义类名
// [WHY] markdown-it 默认输出 <pre><code class="language-x"> / 裸 <code>，与既有 CSS 的 .md-pre / .md-inline 不匹配
// [CONSTRAINT] 用 default renderer 保证转义与属性拼接逻辑不变；只追加 class
// [CHANGE-IMPACT] 消费方（TerminalPane 与文件内容预览）依赖 .md-pre / .md-inline 样式生效
const _defaultFence = md.renderer.rules.fence!
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const html = _defaultFence(tokens, idx, options, env, self)
  return html.replace('<pre>', '<pre class="md-pre">')
}
const _defaultCodeInline = md.renderer.rules.code_inline!
md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
  const html = _defaultCodeInline(tokens, idx, options, env, self)
  return html.replace('<code>', '<code class="md-inline">')
}

// [md-table-wrap-v1] 给每个 <table> 套一层 .md-table-wrap 横向滚动壳。
// [WHY] 此前表格直接裸放在卡片里，配 `width:100% + table-layout:auto` ⇒ 列被压进容器宽度，
//   AI 复盘表里「轮次」竖排成两字一行、「r104」断成 r10/4（用户截图：没有显示全）。
//   壳提供 overflow-x:auto，表格得以按内容自然宽度排布，超宽时滚动而非压缩。
// [markdown-it-table-rule-v1] markdown-it 15 的 rules 里**没有** table_open/table_close 默认实现
//   （走 renderer.renderToken 内建路径），直接 `md.renderer.rules.table_open!` 拿到 undefined、
//   调用即抛 TypeError。必须回退到 self.renderToken。
// [CONSTRAINT] 用 renderToken 保留转义与属性拼接；只在开标签前插壳、闭标签后补壳。
// [CHANGE-IMPACT] 三处消费方（对话流卡片 / FileTree 预览 / 变更overlay）都需为 .md-table-wrap 补样式，
//   统一由 styles/md-table.scss 的 md-table mixin 提供。
md.renderer.rules.table_open = (tokens, idx, options, env, self) => {
  return `<div class="md-table-wrap">${self.renderToken(tokens, idx, options)}`
}
md.renderer.rules.table_close = (tokens, idx, options, env, self) => {
  return `${self.renderToken(tokens, idx, options)}</div>`
}

/**
 * 表格行判据：去掉转义占位后至少 2 列（单列不成表）
 * [table-cellcount-escape-v1] 报告 §3 P2：split('|') 会把转义 \| 也计为列分隔符 ⇒ 先占位再计数
 */
function tableCellCount(line: string): number {
  return line.replace(/\\\|/g, '\u0001').split('|').length - 2
}

/**
 * 分隔行判据（宽松）：整行只有 `|`/`-`/`:`/空白，且至少各含一个 `|` 与 `-`。
 * [WHY] 必须容忍首尾缺 `|`——AI 常写 `--- | --- | ---`；markdown-it 认它作分隔行，
 *   而原严格正则不认 ⇒ 会额外补一行分隔行，补偿出来的那行反而变成表体脏数据行（用户截图里那几行 ---）。
 * [CONSTRAINT] 要求行内含 `|`，否则裸 `---`（水平线）会被误当分隔行、吃掉表格状态。
 */
function isTableSeparator(line: string): boolean {
  return /\|/.test(line) && /-/.test(line) && /^[-\s:|]+$/.test(line)
}

/**
 * 补全缺失的 GFM 表格分隔行
 * [WHY] AI 生成总结时常省略分隔行；markdown-it 严格按 GFM 规范不识别 ⇒ 表格退化为纯文本（管道符原样显示）
 * [normalize-tables-guard-v1] 每个表格块只补一次，且补在块首行之后：
 *   原实现对「连续以 | 开头的每一行」都补分隔行 ⇒ 除表头那行外，每个数据行后都被塞一行
 *   `| --- | --- | --- |`，markdown-it 只把表头后第一行当分隔行，其余全部降级成表体数据行，
 *   于是复盘表里出现三行「--- | --- | ---」脏数据（用户截图）。改判据为「块内是否已补过」。
 * [CONSTRAINT] 跳过 fenced code 区块；表块以「非表格行」断开；AI 已正确输出分隔行时为 no-op。
 * @param src 原始 markdown
 */
function normalizeTables(src: string): string {
  const lines = src.split('\n')
  const out: string[] = []
  let inFence = false
  // 当前表格块是否已补过分隔行（表块以非表格行断开后复位）
  let patchedInBlock = false
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]
    // [tilde-fence-v1] 报告 §3 P2：原只识别 ```，~~~ 围栏内容会被当普通行误处理
    if (/^\s*```/.test(cur) || /^\s*~~~/.test(cur)) inFence = !inFence
    if (inFence) {
      out.push(cur)
      continue
    }
    const isTableRow = /^\s*\|/.test(cur) && tableCellCount(cur) >= 2
    // 非表格行 ⇒ 表格块结束，复位补分隔标记
    if (!isTableRow) patchedInBlock = false
    out.push(cur)
    if (inFence || !isTableRow) continue
    // 已是分隔行 ⇒ 无需补偿，并标记本块已有分隔行
    if (isTableSeparator(cur)) {
      patchedInBlock = true
      continue
    }
    if (patchedInBlock) continue
    const next = lines[i + 1]
    // 下一行不是表格行 ⇒ 当前不是表头（孤立单行），不补
    if (!next || !/^\s*\|/.test(next)) continue
    // 下一行已是分隔行 ⇒ markdown-it 能识别，不补
    if (isTableSeparator(next)) {
      patchedInBlock = true
      continue
    }
    out.push(`| ${Array.from({ length: tableCellCount(cur) }).fill('---').join(' | ')} |`)
    patchedInBlock = true
  }
  return out.join('\n')
}

/**
 * 修复 DOM→Markdown 反推时被污染的代码围栏
 * [md-fence-unglue-v1] headless elToMd 对代码块头部容器（语言标签 + 复制/下载按钮）走兜底 inner()
 *   不加换行 ⇒ 按钮文字与开围栏 ``` 粘连成一行（实测形态「ts复制下载```ts」），``` 不在行首，
 *   markdown-it 不认作围栏 ⇒ 整块代码降级成裸段落（DONE 总结卡片截图实证）。
 *   ① 把不在行首的 ``` 顶回行首；② 剥掉断行后残留的按钮文字尾巴（语言标签 + 复制/下载）。
 * [CONSTRAINT] 必须早于 normalizeTables 执行：后者的 inFence 状态机以「行首 ```」为判据，
 *   粘连行不入围栏态，代码行会被误当表格处理。
 * [CONSTRAINT] 断行判据分三层，只放行真实围栏形态、挡住内容误伤：
 *   · ``` 在行尾（其后无内容或仅空白）⇒ 必断（粘连闭围栏）；
 *   · ``` 后跟语言白名单标签（ts/js/vue/bash/...，markdown-it highlight.js 全量语言集的常用子集 + code/text 兜底）⇒ 断（粘连开围栏带信息串）；
 *   · 其余（``` 后跟普通单词字符如 `a```b`，`` ` `` 是内容）⇒ 不断（测试用例④承重）。
 *   反向收益：行首信息串 ```ts 命中语言白名单会因前字符已排除（`[^\n`]`）不再处理，天然幂等。
 * [CONSTRAINT] 残留尾巴只剥「ASCII 语言标签 ≤20 字符 + 复制/下载」缀，正文其余部分保留
 *   （「代码示例：ts复制下载」→「代码示例：」）；中文正文行含「下载」不匹配该形态，不误删。
 */
function unglueFences(src: string): string {
  return src
    .replace(/([^\n`])```(?=\s*$|(?:ts|js|tsx|jsx|vue|svelte|html|css|scss|less|json|ya?ml|toml|ini|md|markdown|py|java|go|rs|c|cpp|csharp|cs|sh|bash|zsh|shell|sql|docker|diff|xml|php|rb|lua|swift|kotlin|dart|r|matlab|perl|scala|clj|haskell|ex|erl|code|text|txt|plaintext)\b)/gim, '$1\n```')
    .replace(/[\w+#.-]{0,20}(?:复制下载|复制|下载)[ \t]*$/gm, '')
}

/**
 * 把 markdown 文本渲染为 HTML 字符串
 * [WHY] html:false 阻断原始 HTML；normalizeTables 兜底 AI 偷懒省略的表格分隔行
 * [CONSTRAINT] 空串返回空串（调用方 v-html 遇空串不渲染任何节点）
 * @param src 原始 markdown；空串返回空串
 */
// [markdown-lru-cache-v1] 报告 §5.1.3：renderMarkdown 无缓存，每次输入/事件变化都全量重渲。
// [WHY] TerminalPane 提问卡的正文、文件内容预览的 HTML 均为 computed，依赖不变时不重复；
//       但 FileTree 弹窗 / WorklogPane 的 diff 渲染路径会因其他状态变化反复调用同文本。
// [CONSTRAINT] 以源文本为键；容量上限 200 条，超出淘汰最早项；空串直接返回避免占位。
const _mdCache = new Map<string, string>()
const MD_CACHE_MAX = 200

export function renderMarkdown(src: string): string {
  if (!src) return ''
  const hit = _mdCache.get(src)
  if (hit !== undefined) return hit
  const html = md.render(normalizeTables(unglueFences(src)))
  if (_mdCache.size >= MD_CACHE_MAX) {
    const first = _mdCache.keys().next().value
    if (first !== undefined) _mdCache.delete(first)
  }
  _mdCache.set(src, html)
  return html
}

/**
 * 把 ref 包裹的 markdown 源转换为渲染后的 computed HTML
 * [CONSTRAINT] 返回 computed，随 source 变化自动重算；source.value 为 undefined/null 时按空串处理
 * @param source 响应式源文本；调用方需自行保证是 string 类型的 ref
 */
export function useMarkdown(source: Ref<string>) {
  return computed(() => renderMarkdown(source.value || ''))
}
