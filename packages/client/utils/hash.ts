/**
 * FNV-1a 32 位哈希（8 位 hex）
 * [WHY] 用于脚本去重指纹；与油猴侧同名实现保持一致，跨端产出相同 hash 才能正确去重
 * [CONSTRAINT] 非加密哈希，存在碰撞可能；输出定长 8 字符；不处理 Unicode 编码差异
 * [CHANGE-IMPACT] 改算法会让历史去重指纹全部失配，油猴与前端必须同步升级
 * @param input 任意值；null / undefined 按空串处理，其他经 String() 强转
 */
export function fnv1a8(input: unknown): string {
  const text = String(input ?? '')
  let h = 0x811C9DC5
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x1000193) >>> 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
