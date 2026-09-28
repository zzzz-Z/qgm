import 'virtual:uno.css'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'
import { vTooltip } from './directive'

/** app（相关状态/数据） */
const app = createApp(App)
app.use(createPinia())
app.directive('tooltip', vTooltip)
app.mount('#app')
