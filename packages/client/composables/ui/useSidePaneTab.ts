// [side-pane-tab-v1] 跨组件共享「右侧栏当前 tab」+ 开合意图。
// [WHY] 工具栏的「知识库」按钮（App.vue）与右侧栏（ScriptPanel→SidePane）不是父子关系；
//   需模块级单例 ref 让前者能「切到 kb tab 并展开侧栏」。
// [CONSTRAINT] 模块级 ref 单例（全应用共享），与 useAiWindowTable 的 sid 命名空间同思路。
import { ref } from 'vue'

export type SidePaneTab = 'tree' | 'changes' | 'worklog' | 'kb'

/** 当前侧栏 tab（单例） */
export const sidePaneTab = ref<SidePaneTab>('tree')
/** 递增的「请求展开」计数：每次调用 +1，SidePane watch 到变化即展开 */
export const sidePaneRevealTick = ref(0)

/** 切到指定 tab 并请求展开侧栏（供外部按钮调用） */
export function revealSideTab(tab: SidePaneTab): void {
  sidePaneTab.value = tab
  sidePaneRevealTick.value += 1
}
