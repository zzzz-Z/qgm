import 'virtual:uno.css'
import App from './App.vue'
import './style.css'
import { vOverflowTip, vTooltip } from './directive'
// [terminal-store-v1] vue-web-terminal 的 TerminalStore 必须在插件 install() 里 initStore()，
// 否则组件读命令历史时抛「The store must be initialized before reading」。
// createTerminal() 唯一职责就是返回带 install 的插件对象，故必须在 app 级注册。
import { createTerminal } from 'vue-web-terminal'
// [ask-static-import-v1] useAsk 已被 App.vue 等静态引入、本就在主 chunk；
// 此处再用动态 import 会触发 INEFFECTIVE_DYNAMIC_IMPORT 警告且零拆包收益，故静态引入

/** app（相关状态/数据） */
const app = createApp(App)
app.use(createTerminal())
app.directive('tooltip', vTooltip)
// [overflow-tip-v1] 溢出才提示：单行省略号文本（ScriptCard 的 desc / why）被裁断时补全文提示
app.directive('overflow-tip', vOverflowTip)
app.mount('#app')

// [ask-dev-entry-v1] 本地开发入口：把 useAsk.askUser 挂到 window.__aiAsk，便于在浏览器 console
// 手动触发 ASK 弹窗做端到端自测；条件限定 hostname 为 localhost/127.0.0.1，生产构建不挂载
// [CHANGE-IMPACT] 仅影响调试体验；去掉此块不影响 ASK 主链路（reply-handlers 仍走 askUser）
const _isLocalDev = typeof window !== 'undefined'
  && /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(window.location.hostname)
if (_isLocalDev) {
  ;(window as Window & { __aiAsk?: typeof askUser }).__aiAsk = askUser
}
