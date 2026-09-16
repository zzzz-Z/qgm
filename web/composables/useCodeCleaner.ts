import { ref } from 'vue'

const KEY_COMMENTS = '__ai_clean_strip_comments'
const KEY_BLANKS = '__ai_clean_strip_blanks'

function load(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

/**
 * 代码清洗偏好，全局单例。
 * 默认开启：去注释 + 去空行。
 */
const stripComments = ref(load(KEY_COMMENTS, true))
const stripBlankLines = ref(load(KEY_BLANKS, true))

function toggleStripComments(v: boolean) {
  stripComments.value = v
  try { localStorage.setItem(KEY_COMMENTS, v ? '1' : '0') } catch { /* quota */ }
}
function toggleStripBlankLines(v: boolean) {
  stripBlankLines.value = v
  try { localStorage.setItem(KEY_BLANKS, v ? '1' : '0') } catch { /* quota */ }
}

export function useCodeCleaner() {
  return { stripComments, stripBlankLines, toggleStripComments, toggleStripBlankLines }
}
