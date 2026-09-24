// [generate-panel-utils-v1] PLAN 4.7 阈值整改：从 GeneratePanel.vue 抽出

interface TreeNode {
  name: string
  type: 'file' | 'directory'
}

interface PkgLike {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

/** 关注的核心依赖清单（用于提取项目结构） */
const WANTED_DEPS = [
  'vue',
  'vue-router',
  'pinia',
  'element-plus',
  'unocss',
  'vite',
  'typescript',
  'axios',
  'echarts',
  'maplibre-gl',
  'vitest',
  '@playwright/test',
]

/** 目录用途提示映射 */
const DIR_HINTS: Record<string, string> = {
  src: '主应用源码（Vue 3 + Element Plus）',
  plugins: 'AI Runner（Vite 插件 + 前端 SPA）',
  public: '静态资源',
  types: '全局类型声明',
  dist: '构建产物',
  e2e: 'e2e 测试',
}

/** 关键文件清单（README / package.json 等） */
const KEY_FILES = ['package.json', 'vite.config.ts', 'tsconfig.json', 'README.md', 'AGENTS.md']

/** 汇总仓库结构为可读提示（供 AI prompt 使用） */

/**
 * 格式化 Repo Summary
 * @param tree - tree
 * @param pkg - pkg
 */
export function formatRepoSummary(tree: TreeNode[], pkg: PkgLike | null): string {
  const lines: string[] = []
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    const stack: string[] = []
    for (const name of WANTED_DEPS) {
      if (!deps[name]) continue
      const raw = String(deps[name])
      const clean = raw.replace(/^[~^]/, '')
      stack.push(`${name}@${clean}`)
    }
    if (stack.length) lines.push(`技术栈：${stack.join(' / ')}`)
    if (pkg.scripts) {
      const names = Object.keys(pkg.scripts).filter(k => k === 'dev' || k === 'build' || k.startsWith('test'))
      if (names.length) lines.push(`脚本：${names.join(' / ')}`)
    }
  }
  const dirs = tree.filter(n => n.type === 'directory').map(n => n.name)
  if (dirs.length) {
    lines.push('顶层目录：')
    for (const d of dirs) {
      const hint = DIR_HINTS[d] || ''
      lines.push(`  ${d}/${hint ? `  ${hint}` : ''}`)
    }
  }
  const present = tree.filter(n => n.type === 'file' && KEY_FILES.includes(n.name)).map(n => n.name)
  if (present.length) lines.push(`关键文件：${present.join(' / ')}`)
  return lines.join('\n')
}
