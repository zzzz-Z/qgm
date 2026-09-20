// [P3-4] 失败指纹 → 源文件函数定位（typescript AST，零新增依赖）
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process' // [fix-import-process-v1]
import ts from 'typescript'
// [fix-inline-root-v1] 内联 ROOT 去掉相对导入：--experimental-strip-types 不重写 .js → .ts 路径
// 与 config.ts 的初始值一致（setRoot 未调用时）
// [fix-root-env] 从 env 读 ROOT，避免 strip-types 下 import config 失败
function getRoot(): string {
  return process.env.AI_RUNNER_ROOT || process.cwd()
}

export interface Fingerprint {
  file: string
  line: number
  symbol: string
  kind: 'function' | 'class' | 'method' | 'arrow' | 'variable' | 'top'
}

/** 定位某文件某行所属的最内层符号 */
function locateSymbol(src: string, fileName: string, targetLine: number): Fingerprint | null {
  let sf: ts.SourceFile
  try {
    sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true)
  } catch { return null }

  let best: Fingerprint | null = null
  let bestSpan = Number.POSITIVE_INFINITY

  function visit(node: ts.Node): void {
    const kind = classify(node)
    if (kind) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1
      if (targetLine >= start && targetLine <= end) {
        const span = end - start
        if (span < bestSpan) {
          bestSpan = span
          best = { file: fileName, line: targetLine, symbol: nameOf(node, sf), kind }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  if (!best) {
    return { file: fileName, line: targetLine, symbol: '<top>', kind: 'top' }
  }
  return best
}

function classify(node: ts.Node): Fingerprint['kind'] | null {
  if (ts.isFunctionDeclaration(node)) return 'function'
  if (ts.isMethodDeclaration(node)) return 'method'
  if (ts.isClassDeclaration(node)) return 'class'
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return 'arrow'
  if (ts.isVariableDeclaration(node)) return 'variable'
  return null
}

function nameOf(node: ts.Node, sf: ts.SourceFile): string {
  const n = node as { name?: ts.Node }
  if (n.name && ts.isIdentifier(n.name)) return n.name.text
  if (n.name && ts.isStringLiteral(n.name)) return n.name.text
  const parent = node.parent
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  return `<anonymous@${line}>`
}

/**
 * 从错误文本提取指纹列表。
 * 兼容 V8 / tsc 格式：file.ts:12:34 / at fn (/abs/file.ts:12:34)
 */
// [fix-regex-capture-v1] 修正捕获组编号：m[1]=路径 m[2]=扩展名 m[3]=行号
export function fingerprintErrors(text: string, max = 8): Fingerprint[] {
  const hits: Fingerprint[] = []
  const seen = new Set<string>()
  // 用 RegExp 构造避免源文件里的转义陷阱
  const reSrc = String.raw`(?:^\s*|\()((?:[A-Za-z]:)?[\\/][\w./@-]+|[\w./@-]+)\.(ts|tsx|vue|js|jsx|mjs|cjs):(\d+)(?::\d+)?`
  const re = new RegExp(reSrc, 'gm')
  let m: RegExpExecArray | null
  for (;;) {
    m = re.exec(text)
    if (m === null) break
    if (hits.length >= max) break
    let p = (`${m[1]}.${m[2]}`).replace(/\\/g, '/')
    if (p.includes('node_modules')) continue
    if (p.startsWith('node:')) continue
    if (path.isAbsolute(p)) {
      const rel = path.relative(getRoot(), p).replace(/\\/g, '/')
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      p = rel
    }
    const line = Number(m[3])
    const key = `${p}:${line}`
    if (seen.has(key)) continue
    seen.add(key)

    const abs = path.join(getRoot(), p)
    if (!fs.existsSync(abs)) continue
    let src = ''
    try {
      src = fs.readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const fp = locateSymbol(src, p, line)
    if (fp) {
      hits.push(fp)
    }
  }
  return hits
}
