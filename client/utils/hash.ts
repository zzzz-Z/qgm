export function fnv1a8(input: unknown): string {
  const text = String(input ?? '')
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x1000193) >>> 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
