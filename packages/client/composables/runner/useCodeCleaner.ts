import { ref } from 'vue'

/** 键 */
const KEY_COMMENTS = '__ai_clean_strip_comments'
/** 键 */
const KEY_BLANKS = '__ai_clean_strip_blanks'

/**
 * 代码清洗偏好，全局单例。
 * 默认开启：去注释 + 去空行。
 */
const stripComments = ref(load(KEY_COMMENTS, true))
/** 行集合 */
const stripBlankLines = ref(load(KEY_BLANKS, true))

/**
 * 加载
 * @param key - key
 * @param fallback - fallback
 */
function load(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

/**
 * 切换 Strip Comments
 * @param v - v
 */
function toggleStripComments(v: boolean) {
  stripComments.value = v
  try { localStorage.setItem(KEY_COMMENTS, v ? '1' : '0') } catch { /* quota */ }
}

/**
 * 切换 Strip Blank Lines
 * @param v - v
 */
function toggleStripBlankLines(v: boolean) {
  stripBlankLines.value = v
  try { localStorage.setItem(KEY_BLANKS, v ? '1' : '0') } catch { /* quota */ }
}

/**
 * 组合式函数 Code Cleaner
 */
export function useCodeCleaner() {
  return { stripComments, stripBlankLines, toggleStripComments, toggleStripBlankLines }
}
