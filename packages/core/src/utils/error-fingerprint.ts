// [P3-4] 失败指纹 → 源文件函数定位（typescript AST，零新增依赖）
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process' // [fix-import-process-v1]
import ts from 'typescript'
// 内联 ROOT 去掉相对导入：--experimental-strip-types 不重写 .js → .ts 路径
// 与 config.ts 的初始值一致（setRoot 未调用时）
// 从 env 读 ROOT，避免 strip-types 下 import config 失败

/**
 * 读取项目根目录（优先 env.AI_RUNNER_ROOT，回落 cwd）
 * [WHY] 内联而非 import config.ts：--experimental-strip-types 不重写 .js → .ts 路径，import 会失败
 * [CONSTRAINT] config.setRoot 调用后 env 会变，此处每次读 env 以保证与主进程一致
 */
function getRoot(): string {
  return process.env.AI_RUNNER_ROOT || process.cwd()
}

/** 失败指纹：错误位置与所属符号的规范化表示 */
export interface Fingerprint {
  file: string
  line: number
  symbol: string
  /** 符号类别；'top' 表示未能归入任何具名作用域（顶层语句） */
  kind: 'function' | 'class' | 'method' | 'arrow' | 'variable' | 'top'
}

/**
 * 用 TS AST 定位某行所属的最内层具名符号
 * [WHY] 遍历所有节点，取包含目标行且跨度最小的符号 —— 保证拿到最内层嵌套函数而非外层类
 * [CONSTRAINT] 无匹配时返回 kind='top' 的占位指纹，不返回 null（调用方据此判"已识别但无符号"）
 * [CHANGE-IMPACT] 被 fingerprintErrors 消费；修改判定逻辑会影响前端展示的失败定位
 */
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

/**
 * 判定 TS AST 节点类型是否可归入指纹的 kind 枚举
 * [CONSTRAINT] 只识别 function / method / class / arrow(含函数表达式) / variable 五类；
 * 其他节点（如 interface / type alias）返回 null，不参与指纹
 * [CHANGE-IMPACT] 修改匹配顺序会影响同类节点的分类（如箭头函数赋给变量时命中 arrow 而非 variable）
 * @param node TS AST 节点
 */
function classify(node: ts.Node): Fingerprint['kind'] | null {
  if (ts.isFunctionDeclaration(node)) return 'function'
  if (ts.isMethodDeclaration(node)) return 'method'
  if (ts.isClassDeclaration(node)) return 'class'
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return 'arrow'
  if (ts.isVariableDeclaration(node)) return 'variable'
  return null
}

/**
 * 提取节点的可读符号名
 * [CONSTRAINT] 三级兜底：直接 name（Identifier / StringLiteral）→ 父级变量声明名 → `<anonymous@line>`
 * [WHY] 匿名箭头函数无 name 字段，只有向上找变量声明才能给出有意义的名字
 * @param node 待取名的 AST 节点
 * @param sf 所属 SourceFile（用于计算匿名回退时的行号）
 */
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
 * 从错误文本提取失败指纹列表
 * [WHY] 兼容 V8 堆栈（at fn (/abs/file.ts:12:34)）与 tsc 诊断（file.ts:12:34）两种格式
 * [CONSTRAINT] 只匹配 .ts/.tsx/.vue/.js/.jsx/.mjs/.cjs；跳过 node_modules 与 node: 前缀
 * [CHANGE-IMPACT] 正则以字符串拼接构造，转义陷阱见下方 reSrc；扩语言须同步更新此表达式
 * @param text 原始错误输出（stderr 或 stdout）
 * @param max 最多返回的指纹数（默认 8，防 UI 爆炸）
 */
// 修正捕获组编号：m[1]=路径 m[2]=扩展名 m[3]=行号
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
