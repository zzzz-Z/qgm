import { defineConfig, presetIcons, presetWind4, transformerDirectives } from 'unocss'

export default defineConfig({
  presets: [
    presetWind4(),
    presetIcons(),
  ],
  // [apply-v1] transformerDirectives 启用 CSS @apply：让 <style scoped> 内引用 shortcuts
  transformers: [transformerDirectives()],
  shortcuts: {
    'flex-center': 'flex justify-center items-center',
    'flex-col': 'flex flex-col',
    'panel': 'flex flex-col min-h-0',
    'pane': 'flex flex-row h-full overflow-hidden',
    'pane-main': 'flex flex-col flex-1 min-w-0 overflow-hidden',
    'pane-side': 'flex flex-col shrink-0 overflow-hidden bg-[var(--surface)] border-l border-[var(--border)]',
    'card-surface': 'bg-[var(--surface)] border border-[var(--border)] rounded-10 overflow-hidden',
    'card-elevated': 'card-surface shadow-sm',
    'btn-base': 'px-2 py-1 rounded cursor-pointer select-none transition-colors',
    'btn-ghost': 'btn-base bg-transparent border border-[var(--border)] op75 hover:op100 hover:bg-[var(--surface-2)]',
    'btn-primary': 'btn-base bg-[var(--primary-bg)] text-[var(--primary)] border border-[var(--primary)] hover:bg-(--primary-hover) hover:text-white',
    'text-muted': 'text-[var(--text-3)]',
    'text-mono': 'font-mono tabular-nums',
    'scrollbar-none': '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
    // [shortcuts-v2] 全仓高频复用模式（来源：components/*.vue style 段统计）
    'card-head': 'flex items-center gap-1.5 mb-0.5 text-[10.5px] text-[var(--text-3)] tracking-wide',
    'chip-badge': 'px-1.5 py-px rounded bg-[var(--surface-3)] text-[var(--text-3)] font-mono tracking-wide',
    'flex-fill': 'flex-1 min-w-0 min-h-0',
    'code-inline': 'px-1 py-px rounded bg-[var(--surface-3)] font-mono text-[0.92em]',
    'code-block': 'my-2.5 px-3 py-2.5 bg-[var(--surface-2)] border border-[var(--border)] rounded-md overflow-x-auto whitespace-pre font-mono text-xs leading-relaxed',
    'scroll-thin': '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:bg-[rgb(127_127_127/22%)] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb:hover]:bg-[rgb(127_127_127/38%)] [&::-webkit-scrollbar-track]:bg-transparent',
  },
})
