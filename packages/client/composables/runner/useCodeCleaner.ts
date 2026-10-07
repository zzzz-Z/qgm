import { useStorage } from '@vueuse/core'
/** localStorage 键：去注释开关的持久化（'1'=开 / '0'=关） */
const KEY_COMMENTS = '__ai_clean_strip_comments'
/** localStorage 键：去空行开关的持久化（同格式） */
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
/** 去空行偏好；默认开；[CONSTRAINT] 与 stripComments 共享 BOOL_SERIALIZER 兼容 '1'/'0' 存储 */
const stripBlankLines = useStorage(KEY_BLANKS, true, undefined, { serializer: BOOL_SERIALIZER })

/**
 * 设置去注释开关并自动持久化
 * [CONSTRAINT] 不做取反；调用方传入目标状态（`!stripComments.value` 由调用方算）
 * [CHANGE-IMPACT] 会写 localStorage；其他标签页通过 useStorage 自动同步
 * @param on 目标状态；true=去注释，false=保留
 */
function toggleStripComments(on: boolean) {
  stripComments.value = on
}

/**
 * 设置去空行开关并自动持久化
 * [CONSTRAINT] 不做取反；与 toggleStripComments 保持一致的入参语义
 * @param on 目标状态；true=去空行，false=保留
 */
function toggleStripBlankLines(on: boolean) {
  stripBlankLines.value = on
}

/**
 * 组合式函数 Code Cleaner
 */
export function useCodeCleaner() {
  return { stripComments, stripBlankLines, toggleStripComments, toggleStripBlankLines }
}
