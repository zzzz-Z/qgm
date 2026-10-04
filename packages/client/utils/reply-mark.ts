// @desc 统一回复标记识别：`SCRIPT` / `ASK` / `DONE` / `HANDOFF` / `TEXT` 五类标记共用同一套「首行标记行」判据
// @why 原先四类回复的分流方式各写各的，形态与位置语义都不一致：
//   · SCRIPT 完全没有标记行，靠 DOM 结构 + 语言标签三级回退猜（`<pre>` 的 language-* 类名）
//   · ASK 写 `@ask`（带 @ 前缀），浏览器侧只看「首个非空行前缀」，前端 ASK_HEAD_RE 却带 m 标志
//   · DONE 是「独占一行精确匹配」
//   · HANDOFF 写 `# 任务`——`#` 与 Markdown 一级标题语法同形
//   后果：① 两侧对同一条回复分流不同（先说理再提问在此处被判非标记 → plain 门槛丢整轮）；
//   ② `DONE` 总结里只要带一个 js 代码块，就会被 script 分支抢走并重新执行。
//   现统一为「**首个非空行 = 独占一行的标记行**，第二行起才是载荷」，标记行优先于 DOM 结构判定。
// [marker-naming-v1] 标记一律取**纯大写英文单词**（无 `@` / `#` 前缀）：
//   带前缀的标记会与站点渲染链路耦合——`#` 与 Markdown 标题同形（DOM→Markdown 反推把任何
//   `<h1>` 还原成 `# xxx`），`@` 在部分渲染器里会被当成 mention；纯大写单词无此问题，
//   也让五类标记的判据收敛成同一条「整行等于标记」。
// [text-mark-v1] 新增 `TEXT`：显式「纯文本回执」——渲染为事件流里的文本卡（kind 仍为 plain），
//   既不提问（不像 ASK 会挂一张输入卡、等用户回答），也不终止任务（不像 DONE 会停循环）。
//   [WHY] 无标记的纯文本在采集侧被 hasJsFence / ASK / HANDOFF 门槛拦掉（过滤问候语的原意），
//   于是 AI 想主动播报一段说明/诊断时只剩 ASK（逼用户回话）或 DONE（结束任务）两条歪路。
//   过渡别名：`@ask`（旧 SYSTEM.md 注入的会话仍在用）与 `# 任务`（旧 SUMMARY_INSTRUCTION）
//   仍被接受，见 scanReplyMarks；待旧会话退场后可删（守卫测试会盯住别名与首选名并存）。
// @change-impact 浏览器侧 headless-inject.ts 的 detectReplyInPage 内联同构实现
//   （page.evaluate 序列化执行，不能共享模块）；三处一致性由 reply-mark-parity 守卫测试
//   「抠出各文件花括号内部、同批样例真跑对拍」锁死。改这里必须同步改另外两处。

/** 单条回复命中的标记（1-based 行号）；未命中为 -1。至多命中一个——只认首个非空行 */
export interface ReplyMarkScan {
  /** 首个非空行为 `SCRIPT`（独占一行） */
  script: number
  /** 首个非空行为 `ASK`（独占一行）；过渡别名 `@ask`，同行写法 `ASK 问题` 不算 */
  ask: number
  /** 首个非空行为 `DONE`（独占一行） */
  done: number
  /** 首个非空行为 `HANDOFF`（独占一行）；过渡别名 `# 任务` */
  handoff: number
  /** 首个非空行为 `TEXT`（独占一行）：纯文本回执，渲染为文本卡，不提问也不结束任务 */
  text: number
}

/**
 * 扫描回复正文的首行标记
 * [reply-mark-v1] 五类标记统一为「首个非空行 + 独占一行 + 精确匹配」，与 SYSTEM.md §1 的输出契约同构：
 *   · 统一形态的收益：判据只剩一条规则（首个非空行 trim 后整行等于标记），
 *     不会再出现「ASK 认同行前缀、DONE 只认独占」这种两侧对不上的窗口；
 *   · 标记行优先的收益：带标记的回复不会再被 DOM 结构判定抢走
 *     （此前 `DONE` 总结里含一个 js 代码块 → 被误判为 script 并重新执行）；
 *   · 只认首行的收益：正文里引用一行 `DONE`、贴一段含 `ASK` 的示例都不会误触发，
 *     因而也不再需要围栏排除逻辑。
 * [CONSTRAINT] 标记必须独占一行且落在首个非空行：载荷（脚本 / 正文 / 总结）写在**第二行起**
 * [CONSTRAINT] 内部不得出现 TS 类型注解：守卫测试要把花括号内部抠出来直接编译执行；
 *   与 headless-inject.ts、tampermonkey-session-id.user.js 的同名实现逐句同构
 * @param md 回复正文（Markdown）
 */
export function scanReplyMarks(md: string): ReplyMarkScan {
  const out = { script: -1, ask: -1, done: -1, handoff: -1, text: -1 }
  const lines = String(md || '').split(/\r?\n/)
  let head = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) { head = i; break }
  }
  if (head < 0) return out
  const line = lines[head].trim()
  if (/^SCRIPT$/.test(line)) out.script = head + 1
  else if (/^(?:ASK|@ask)$/i.test(line)) out.ask = head + 1
  else if (/^DONE$/.test(line)) out.done = head + 1
  else if (/^(?:HANDOFF|#\s*任务)$/.test(line)) out.handoff = head + 1
  else if (/^TEXT$/.test(line)) out.text = head + 1
  return out
}
