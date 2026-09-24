// AI Runner: Vue SFC 与 Vite 环境类型声明
// 解决 tsc --noEmit -p tsconfig.client.json 时对 *.vue 无类型导致的 TS2307
/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
