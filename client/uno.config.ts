import { defineConfig, presetIcons, presetWind4 } from 'unocss'

export default defineConfig({
  presets: [
    presetWind4(),
    presetIcons(),
  ],
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
  },
})
