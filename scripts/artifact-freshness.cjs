// [artifact-freshness-v1] 产物新鲜度判定：产物不得落后于源码。
// [pair-from-dep-graph-v1] pair 清单由依赖闭包推导：守 A 时 A 的行为可能由 B 决定
//   （lesson-extract.js import lesson-title-similarity.js）；硬编码一对会漏掉依赖闭包。
'use strict'
const fs = require('node:fs')
const path = require('node:path')

function checkPair(srcPath, distPath) {
  if (!fs.existsSync(srcPath)) return { ok: false, reason: `source missing: ${srcPath}` }
  if (!fs.existsSync(distPath)) return { ok: false, reason: `artifact missing: ${distPath}` }
  const srcMtime = fs.statSync(srcPath).mtimeMs
  const distMtime = fs.statSync(distPath).mtimeMs
  if (distMtime < srcMtime) {
    return { ok: false, reason: `artifact stale: ${distPath} older than ${srcPath}`, srcMtime, distMtime }
  }
  return { ok: true, srcMtime, distMtime }
}

function checkPairs(pairs) {
  for (const [src, dist] of pairs) {
    const r = checkPair(src, dist)
    if (!r.ok) return { ok: false, reason: r.reason, src, dist }
  }
  return { ok: true }
}

// 从一行代码里抽相对 import specifier（无正则，避免上游截断）。
function specifiersInLine(line) {
  const out = []
  for (const kw of ['from', 'import']) {
    const at = line.indexOf(kw)
    if (at < 0) continue
    const q1 = line.indexOf(String.fromCharCode(34), at)
    const q2 = line.indexOf(String.fromCharCode(39), at)
    let q = -1
    if (q1 >= 0 && (q2 < 0 || q1 < q2)) q = q1
    else if (q2 >= 0) q = q2
    if (q < 0) continue
    const closeCh = line.charAt(q)
    const end = line.indexOf(closeCh, q + 1)
    if (end < 0) continue
    const spec = line.slice(q + 1, end)
    if (spec.startsWith('./')) out.push(spec)
  }
  return out
}

function relativeImportSpecifiers(code) {
  const out = []
  for (const line of String(code).split(String.fromCharCode(10))) {
    for (const s of specifiersInLine(line)) out.push(s)
  }
  return out
}

function derivePairs(entryDist, toSource) {
  const seen = new Set()
  const pairs = []
  const queue = [entryDist]
  while (queue.length) {
    const js = queue.shift()
    if (!js || seen.has(js)) continue
    seen.add(js)
    if (!fs.existsSync(js)) continue
    const src = toSource(js)
    if (src && fs.existsSync(src)) pairs.push([src, js])
    const code = fs.readFileSync(js, 'utf8')
    for (const spec of relativeImportSpecifiers(code)) {
      queue.push(path.resolve(path.dirname(js), spec))
    }
  }
  return pairs
}

module.exports = { checkPair, checkPairs, relativeImportSpecifiers, derivePairs }
