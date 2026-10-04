// [file-tree-icons-v1] FileTree 的图标表与选择/渲染纯函数。
// [WHY] FileTree.vue 超 §4 组件 500 行红线；三个符号（ICONS/getFileIcon/iconSvg）自成体系。
// [CHANGE-IMPACT] FileTree.vue 通过 import 消费；返回结构不变。

/** 文件树图标映射（按扩展名） */
export const ICONS: Record<string, string> = {
  vue: '<path fill="#42b883" d="M2 2h4l6 10 6-10h4L12 22 2 2z"/><path fill="#35495e" d="M4.5 2h3L12 10l4.5-8h3L12 18 4.5 2z"/>',
  ts: '<path fill="#3178c6" d="M2 2h20v20H2V2zm10 14h-2v-4H8v-2h6v2h-2v4zm4-6h-2v6h-2v-6h-2V8h6v2z"/>',
  js: '<path fill="#f7df1e" d="M2 2h20v20H2V2zm14.5 15c0-1.5-1-2.2-2.5-2.8l-.8-.4c-.7-.3-1-.6-1-1.1 0-.5.4-.9 1.1-.9.7 0 1.2.4 1.3 1h1.8c-.1-1.4-1.2-2.3-3-2.3-1.7 0-2.9 1-2.9 2.5 0 1.4 1 2.1 2.4 2.7l.9.4c.7.3 1 .7 1 1.2 0 .6-.5 1-1.3 1-.9 0-1.4-.5-1.5-1.2h-1.9c.1 1.6 1.3 2.6 3.3 2.6 1.8 0 3.1-1 3.1-2.7zM9 17H7v-7H5V8h4v2H9v7z"/>',
  style: '<path fill="#563d7c" d="M12 2L2 6l2 12 8 4 8-4 2-12-10-4zm0 2.3l7.5 3-1.5 9L12 19l-6-2.7-1.5-9L12 4.3z"/>',
  json: '<path fill="#cbcb41" d="M4 4h16v16H4V4zm3 10c0-1.5 1-2.5 2.5-2.5S12 12.5 12 14s-1 2.5-2.5 2.5S7 15.5 7 14zm5 0c0-1.5 1-2.5 2.5-2.5s2.5 1 2.5 2.5-1 2.5-2.5 2.5-2.5-1-2.5-2.5z"/>',
  md: '<path fill="#519aba" d="M4 4h16v16H4V4zm3 12V8l3 4 3-4v8h-2v-5l-1 1.5L9 11v5H7zm8 0h-2v-4h2v4z"/>',
  html: '<path fill="#e34c26" d="M4 2l1.8 18L12 22l6.2-2L20 2H4zm12.5 15.5L12 19l-4.5-1.5L6.8 5h10.4l-.7 12.5z"/>',
  image: '<path fill="#a074c4" d="M4 4h16v16H4V4zm3 12l3-4 2 2.5 3-4 3 5.5H7z"/>',
  config: '<path fill="#858585" d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 3a2 2 0 110 4 2 2 0 010-4zm0 10a5 5 0 01-4-2h8a5 5 0 01-4 2z"/>',
  pkg: '<path fill="#cb3837" d="M4 4h16v16H4V4zm3 3v10h10V7H7zm2 2h6v6H9V9z"/>',
  file: '<path fill="#9ca3af" d="M6 2h8l6 6v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2zm7 1v5h5"/>',
  folder: '<path fill="#dcb67a" d="M2 6a2 2 0 012-2h5l2 2h7a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>',
  folderOpen: '<path fill="#dcb67a" d="M2 6a2 2 0 012-2h5l2 2h7a2 2 0 012 2v1H8l-2 3H2V6zm0 7h6l2-3h10v7a2 2 0 01-2 2H4a2 2 0 01-2-2v-7z"/>',
  chevronRight: '<path fill="currentColor" d="M9 6l6 6-6 6V6z"/>',
}

/**
 * 按文件名后缀映射图标 key
 * [CONSTRAINT] 匹配顺序敏感：先具体后缀（.vue/.tsx）再通配；package.json 优先于 .json 分支
 * [CHANGE-IMPACT] 返回 key 必须存在于 ICONS，否则 iconSvg 会回落到 file
 */
export function getFileIcon(name: string): string {
  const n = name.toLowerCase()
  // [icon-order-v1] 正则里 `.` 未转义会误命中 myhtml/xcss；特判前置到通用后缀之前
  if (n === 'package.json' || n === 'pnpm-lock.yaml') return 'pkg'
  if (n.endsWith('.vue')) return 'vue'
  if (n.endsWith('.ts') || n.endsWith('.tsx')) return 'ts'
  if (n.endsWith('.js') || n.endsWith('.jsx') || n.endsWith('.mjs') || n.endsWith('.cjs')) return 'js'
  if (/\.(?:css|scss|sass|less)$/.test(n)) return 'style'
  if (n.endsWith('.json')) return 'json'
  if (n.endsWith('.md')) return 'md'
  if (/\.html?$/.test(n)) return 'html'
  if (/\.(?:png|jpg|jpeg|gif|svg|webp|ico)$/.test(n)) return 'image'
  if (/\.(?:yaml|yml)$/.test(n)) return 'config'
  if (n.startsWith('.') || n === 'tsconfig.json' || n === 'vite.config.ts' || n === 'eslint.config.ts') return 'config'
  return 'file'
}

/**
 * 生成图标 svg 字符串
 * [WHY] 走字符串拼接而非 v-for 组件，避免为 12 个图标各建一个 Vue 组件
 * [CONSTRAINT] name 未命中 ICONS 时回落 file；cls 会附加到 svg 的 class 属性
 */
export function iconSvg(name: string, cls = ''): string {
  const d = ICONS[name] || ICONS.file
  return `<svg class="ft-icon ${cls}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${d}</svg>`
}
