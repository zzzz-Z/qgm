import 'virtual:uno.css'
import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { vTooltip } from './directive'

const app = createApp(App)
app.directive('tooltip', vTooltip)
app.mount('#app')
