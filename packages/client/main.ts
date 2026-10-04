import 'virtual:uno.css'
import App from './App.vue'
import './style.css'
import { vTooltip } from './directive'
// [ask-static-import-v1] useAsk 已被 App.vue 等静态引入、本就在主 chunk；
// 此处再用动态 import 会触发 INEFFECTIVE_DYNAMIC_IMPORT 警告且零拆包收益，故静态引入

/** app（相关状态/数据） */
const app = createApp(App)
app.directive('tooltip', vTooltip)
app.mount('#app')

// [ask-dev-entry-v1] 本地开发入口：把 useAsk.askUser 挂到 window.__aiAsk，便于在浏览器 console
// 手动触发 @ask 弹窗做端到端自测；条件限定 hostname 为 localhost/127.0.0.1，生产构建不挂载
// [CHANGE-IMPACT] 仅影响调试体验；去掉此块不影响 @ask 主链路（reply-handlers 仍走 askUser）
const _isLocalDev = typeof window !== 'undefined'
  && /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(window.location.hostname)
if (_isLocalDev) {
  ;(window as Window & { __aiAsk?: typeof askUser }).__aiAsk = askUser
}
