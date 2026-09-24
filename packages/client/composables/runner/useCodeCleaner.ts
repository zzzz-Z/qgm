import { useStorage } from '@vueuse/core'

/** 键 */
const KEY_COMMENTS = '__ai_clean_strip_comments'
/** 键 */
const KEY_BLANKS = '__ai_clean_strip_blanks'

// [use-storage-v1] 布尔持久化改用 @vueuse useStorage；
// 自定义 serializer 兼容历史 '1'/'0' 存储格式（避免布尔 JSON 序列化引发迁移）
/** 布尔 serializer：'1' <-> true，其余 <-> false */
const BOOL_SERIALIZER = {
  read: (v: string) => v === '1',
  write: (v: boolean) => (v ? '1' : '0'),
}

/**
 * 代码清洗偏好，全局单例。
 * 默认开启：去注释 + 去空行。
 */
const stripComments = useStorage(KEY_COMMENTS, true, undefined, { serializer: BOOL_SERIALIZER })
/** 行集合 */
const stripBlankLines = useStorage(KEY_BLANKS, true, undefined, { serializer: BOOL_SERIALIZER })

/**
 * 切换 Strip Comments
 * @param v - v
 */
function toggleStripComments(v: boolean) {
  stripComments.value = v
}

/**
 * 切换 Strip Blank Lines
 * @param v - v
 */
function toggleStripBlankLines(v: boolean) {
  stripBlankLines.value = v
}

/**
 * 组合式函数 Code Cleaner
 */
export function useCodeCleaner() {
  return { stripComments, stripBlankLines, toggleStripComments, toggleStripBlankLines }
}
