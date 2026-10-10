// [terminal-panel-v1] 右侧栏终端面板：vue-web-terminal 承载输入/展示，/__ai/exec 承载执行。
// [WHY] 复用现有 NDJSON 流式协议（stdout/stderr/exit 帧），不引入新后端与依赖。
// [CONSTRAINT] 终端组件自带主题样式随包 import 注入；本组件用 CSS 变量 + 全局覆盖贴合深色终端观感。
<script setup lang="ts">
// [explicit-import-v1] vue-web-terminal 不在 auto-import 扫描范围，必须显式引入
import { Terminal, TerminalApi } from 'vue-web-terminal'
import type { FailedFunc, SuccessFunc } from 'vue-web-terminal'
import { readNdjson } from '../../utils/stream'

defineOptions({ name: 'TerminalPanel' })

/** 与模板 <Terminal name> 保持一致的实例名，TerminalApi 按此定位实例 */
const TERMINAL_NAME = 'ai-runner-shell'

/**
 * 把一段输出追加到终端。
 * [WHY] appendMessage 只接受字符串并原样追加，流式帧逐块到达时用它（pushMessage 会重新解析消息对象，过重）。
 * @param text - 原始输出片段（保留换行）
 */
function appendLine(text: string): void {
  if (!text) return
  TerminalApi.appendMessage(TERMINAL_NAME, text)
}
/**
 * 执行用户输入的命令，流式回填 stdout/stderr，结束时调 success/failed 收尾。
 * [WHY] vue-web-terminal 只负责展示；执行与收尾回调必须由宿主调用，否则输入行会一直挂起。
 * @param command - 用户输入的完整命令行（不含起始标记）
 * @param success - 命令成功结束回调
 * @param failed - 命令失败回调（携带错误文本）
 */
async function runCommand(command: string, success: SuccessFunc, failed: FailedFunc): Promise<void> {
  const cmd = command.trim()
  if (!cmd) { success(); return }
  let exitCode = -1
  try {
    const res = await fetch('/__ai/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // [allow-dirty-v1] 终端是「随手跑命令」的交互场景，不接受「工作区脏」前置门禁；
      //   不传 allowDirty 时 /__ai/exec 会 400 拒绝，用户会看到命令「无任何反应」。
      body: JSON.stringify({ cmd, allowDirty: true }),
    })
    if (!res.ok || !res.body) {
      let detail = ''
      try { detail = await res.text() } catch { /* 响应体读取失败不阻断主错误抛出 */ }
      failed(`HTTP ${res.status} ${res.statusText}${detail ? `\n${detail}` : ''}`)
      return
    }
    await readNdjson<{ stream?: string, data?: string, code?: number }>(res.body, (j) => {
      if (j.stream === 'stdout' || j.stream === 'stderr') appendLine(String(j.data || ''))
      else if (j.stream === 'exit') exitCode = j.code ?? -1
    })
    if (exitCode === 0) success()
    else failed(`退出码 ${exitCode}`)
  } catch (e) {
    failed(`请求异常：${String(e)}`)
  }
}
/** exec-cmd 事件入口；key 是终端解析出的命令关键字，此处不使用（不分命令分发） */
function onExecCmd(_key: string, command: string, success: SuccessFunc, failed: FailedFunc): void {
  void runCommand(command, success, failed)
}
</script>

<template>
  <Terminal
    :name="TERMINAL_NAME"
    :show-header="false"
    :enable-help-box="false"
    context="~/web-ai-qgm"
    context-suffix="$"
    @exec-cmd="onExecCmd"
  />
</template>

<style scoped>
/* [terminal-theme-v3] 按用户反馈二次调色：纯黑底、小字、prompt 紫。
   组件内部字号有硬编码（如 .t-code 15px inline style），必须用 !important 强覆盖。 */
:deep(.t-window) {
  --t-main-background-color: #0c0c0c;
  --t-main-font-color: #cccccc;
  --t-window-box-shadow: none;
  --t-header-background-color: #0c0c0c;
  --t-header-font-color: #808080;
  --t-cmd-key-color: #61afef;
  --t-cmd-arg-color: #cccccc;
  --t-cmd-splitter-color: #6a6a6a;
  --t-cursor-color: #ffffff;
  --t-link-color: #61afef;
  --t-link-hover-color: #8bc4ff;
  --t-selection-font-color: #0c0c0c;
  --t-selection-background-color: #cccccc;
  --t-code-inline-font-color: #98c379;
  --t-log-box-hover-script-background-color: #161616;
  --t-log-box-folded-background-color: #161616;
  --t-log-box-folded-hover-background-color: #1e1e1e;
  --t-log-fold-icon-color: #61afef;
  --t-log-fold-icon-background-color: #0c0c0c;
  --t-log-fold-icon-border-color: #61afef;
  --t-log-fold-icon-active-color: #0c0c0c;
  --t-log-fold-icon-active-background-color: #61afef;
  --t-log-fold-line-color: #2a2a2a;
  --t-cmd-tips-background-color: #1a1a1a;
  --t-cmd-tips-font-color: #cccccc;
  --t-cmd-tips-active-background-color: #2a2a2a;
  --t-cmd-tips-content-font-color: #cccccc;
  --t-cmd-tips-des-font-color: #808080;
  --t-cmd-tips-footer-font-color: #808080;
  --t-cmd-tips-footer-background-color: #141414;
}

/* 终端盒模型：贴满侧栏、去掉圆角与阴影 */
:deep(.t-window) {
  margin: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  padding: 0 !important;
}

/* [terminal-font-v3] 全量强覆盖字号/字体：组件内部多处硬编码（含 inline style 15px），
   不使用 !important 无法压过。11px + 1.35 行高对齐参考图的紧凑观感。 */
:deep(.t-window),
:deep(.t-window *),
:deep(.t-window input),
:deep(.t-window textarea) {
  font-family: 'SF Mono', Menlo, Monaco, 'Courier New', monospace !important;
  font-size: 13px !important;
  line-height: 1.35 !important;
}

/* 组件 header 在截图里不存在（show-header=false），但保险起见彻底隐藏 */
:deep(.t-shell-dots),
:deep(.t-header-pin),
:deep(.t-header) {
  display: none !important;
}

/* 输出区贴边留白，对齐参考图的紧凑排版 */
:deep(.t-content) {
  padding: 4px 8px !important;
  background: #0c0c0c !important;
  scrollbar-width: thin;
  scrollbar-color: #2a2a2a transparent;
}

:deep(.t-content::-webkit-scrollbar) {
  width: 6px;
}

:deep(.t-content::-webkit-scrollbar-thumb) {
  background: #2a2a2a;
  border-radius: 3px;
}

/* [terminal-prompt-v3] prompt 着色：context 段用紫（对齐参考图 git 分支色），
   $ 分隔符灰，光标白块 */
:deep(.t-window .t-context),
:deep(.t-window .t-cmd-input-line .t-context) {
  color: #c678dd !important;
}

:deep(.t-window .t-cmd-splitter) {
  color: #6a6a6a !important;
}

/* 输入区背景与终端底一致，去掉组件默认的分隔感 */
:deep(.t-window .t-cmd-input-line),
:deep(.t-window .t-input-line) {
  background: #0c0c0c !important;
  border: none !important;
}
</style>
