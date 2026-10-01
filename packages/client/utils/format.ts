// 通用格式化与文本读取工具。

/**
 * 把字节数格式化为人类可读的尺寸字符串
 * [CONSTRAINT] 三级切换：< 1KB 输出整数 B；< 1MB 输出 1 位小数的 KB；否则输出 2 位小数的 MB
 * [WHY] 不引入更小单位（GB 及以上极少出现）；不做千分位分隔（UI 空间有限）
 * @param n 字节数；负数按 B 处理（< 1024 分支）
 */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`
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
    r.onerror = rej
    r.readAsText(file)
  })
}
