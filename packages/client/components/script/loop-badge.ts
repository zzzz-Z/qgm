// [status-unify-v1] 循环阶段徽章映射表从 TaskProgressPanel.vue 抽出：
//   ① SFC <script setup> 不允许 ES 导出，测试无法直接断言；
//   ② 顶部阶段条与任务面板都需要同一份映射，抽成单一 SSOT。
export const LOOP_BADGE: Record<string, { text: string, cls: string }> = {
  'running': { text: '运行中', cls: 'loop-running' },
  'preparing': { text: '准备中', cls: 'loop-running' },
  'parsing': { text: '解析脚本', cls: 'loop-running' },
  'executing': { text: '执行中', cls: 'loop-running' },
  'feedback': { text: '回传中', cls: 'loop-running' },
  'waiting': { text: '等待回复', cls: 'loop-running' },
  'waiting-input': { text: '等你回答', cls: 'loop-running' },
  'handoff': { text: '会话轮转中', cls: 'loop-running' },
  'paused': { text: '已暂停', cls: 'loop-paused' },
  'budget-limited': { text: '预算受限', cls: 'loop-paused' },
  'stopped': { text: '已停止', cls: 'loop-stopped' },
  'interrupted': { text: '已中断', cls: 'loop-stopped' },
  'idle': { text: '未运行', cls: 'loop-stopped' },
}
