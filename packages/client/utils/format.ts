// 通用格式化与文本读取工具。

/**
 * 把字节数格式化为人类可读的尺寸字符串
 * [CONSTRAINT] 三级切换：< 1KB 输出整数 B；< 1MB 输出 1 位小数的 KB；否则输出 2 位小数的 MB
 * [WHY] 不引入更小单位（GB 及以上极少出现）；不做千分位分隔（UI 空间有限）
 * @param bytes 字节数；负数按 B 处理（< 1024 分支）
 */
export function fmtSize(bytes: number): string {
  // [fmt-size-nan-guard-v1] 报告 P2：NaN/undefined 会输出 "NaNMB" 或 "undefinedB"
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`
}

/**
 * 由文件名推导 Trae 风格的类型角标文案（如 types.ts → TS）
 * [WHY] 附件芯片与 @引用芯片都需要一个短类型标签，替代原先的 📄 emoji 图标
 * [CONSTRAINT] 只取最后一段扩展名并大写；无扩展名回退 TXT；最长 5 字符防超长扩展名撑破角标
 * @param name 文件名（可含路径，取末段）
 */
export function fileBadge(name: string): string {
  const seg = name.split('/').pop() || name
  const m = /\.([A-Z0-9]{1,5})$/i.exec(seg)
  return m ? m[1].toUpperCase() : 'TXT'
}

/** 角标配色表：低饱和，贴合深色工作台风格（蓝=代码 紫=样式 琥珀=数据 绿=文档 粉=媒体） */
const TONE_COLORS: Record<string, { color: string, background: string }> = {
  code: { color: '#79b8ff', background: 'rgb(88 166 255 / 16%)' },
  style: { color: '#c297ff', background: 'rgb(188 140 255 / 16%)' },
  data: { color: '#e3b341', background: 'rgb(227 179 65 / 16%)' },
  doc: { color: '#56d364', background: 'rgb(86 211 100 / 16%)' },
  media: { color: '#f778ba', background: 'rgb(247 120 186 / 16%)' },
  other: { color: 'var(--text-3, #8b949e)', background: 'rgb(127 127 127 / 16%)' },
}

/** 扩展名 → 色调分组 */
const TONE_GROUPS: Record<string, string[]> = {
  code: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'go', 'rs', 'py', 'java', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cs', 'kt', 'swift', 'sh'],
  style: ['css', 'scss', 'sass', 'less', 'styl'],
  data: ['json', 'yaml', 'yml', 'toml', 'ini', 'env', 'xml', 'csv', 'sql'],
  doc: ['md', 'markdown', 'txt', 'rst', 'adoc'],
  media: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'],
}

/**
 * 按文件类型给出角标前景/背景色
 * [WHY] 单一蓝色无法区分文件族；按类型分色让角标有信息量，且与编辑器代码高亮的气质一致
 * [CONSTRAINT] 只返回两色，背景为 16% 透明叠在芯片中性底色上，不改变芯片整体基调；未知类型回退灰色
 * @param name 文件名（可含路径，取末段扩展名）
 */
export function fileToneStyle(name: string): { color: string, background: string } {
  const ext = fileBadge(name).toLowerCase()
  for (const tone of Object.keys(TONE_GROUPS)) {
    if (TONE_GROUPS[tone].includes(ext)) return TONE_COLORS[tone]
  }
  return TONE_COLORS.other
}

/**
 * 以文本读取本地文件内容（Promise 包装 FileReader）
 * [WHY] 拖拽/选择的文件是 File 对象；FileReader 事件回调不适合直接 await，此处包成 Promise
 * [CONSTRAINT] 读取失败时 reject 原始事件对象；编码按浏览器默认（通常 UTF-8），不做 BOM 处理
 * @param file 浏览器 File 对象
 */
export function readAsText(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result || ''))
    // [reader-reject-error-v1] 报告 P2：原 reject 原始 ProgressEvent 而非 Error，
    // 调用方的 catch 拿到的不是 Error，判断类型会误判。包成 Error 更可控。
    r.onerror = () => rej(new Error(`FileReader 读取失败：${file && file.name ? file.name : '(unknown)'}`))
    r.readAsText(file)
  })
}
