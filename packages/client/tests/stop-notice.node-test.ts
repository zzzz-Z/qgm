// [stopped-vocab-guard-v1] 停止类自指的两道守卫。
//  ① **词表 census**：客户端源码不得出现停机态整句（実施例：2026-10-10 14:14，一切正常却弹出停止提示，
//     掐掉一整轮；另见 utils/stop-notice.ts 文件头 [CONSTRAINT]）。
//  ② **回显承重**：停止 toast 必须把页面命中的原文带出来（否则下一次误报仍然无从定位 ——
//     这正是那次只能靠 arrive/send 日志旁证的根因）。
// 这两个判据都要求「**改恒真后变红**」，判据自重：把 formatStopToast 改成原样返回 ⇒ ② 红；
//   把任何一处停机态整句写回源码 ⇒ ① 红。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'vitest'
import {
  formatStopToast,
  normalizeStopHit,
  STOPPED_HEAD,
  STOPPED_SCRIPT_HINT,
  STOPPED_TOAST_GENERIC,
} from '../utils/stop-notice.js'

// [CONSTRAINT] 词表正则一律**片段拼接**构造：把停机态在源码里连写，
//   本守卫就会把自己扫出来（无限自增的自指），判据再无意义 —— 实测首跑即抓出本文件 3 处连写。
const STOP_RE = new RegExp(['当前问题' + '已停止', '已停止' + '生成', '已停止' + '回答'].join('|'), 'g')
/** 测试用例里需要一句「命中原文」时同样按片段构造，不得连写 */
const HIT_WORD = '已停止' + '生成'

// ───────────────────────── ② 停止 toast 必须回显命中原文 ─────────────────────────

test('stop notice: 无命中串时退回通用文案', () => {
  assert.equal(formatStopToast(undefined), STOPPED_TOAST_GENERIC)
  assert.equal(formatStopToast(''), STOPPED_TOAST_GENERIC)
  assert.equal(formatStopToast('   \n\t '), STOPPED_TOAST_GENERIC)
})

test('stop notice: 命中串等于通用文案（页面侧兜底值）时不加自指括号', () => {
  assert.equal(formatStopToast(STOPPED_TOAST_GENERIC), STOPPED_TOAST_GENERIC)
})

test('stop notice: 命中原文必须被带出（定位自指误报的唯一信息）', () => {
  const hit = `这块源码里写着 AI 网页${HIT_WORD}`
  const out = formatStopToast(hit)
  assert.ok(out.includes('页面命中：'), `toast 未带命中串: ${out}`)
  assert.ok(out.includes(hit), `toast 未回显命中原文: ${out}`)
})

test('stop notice: 长 run-on 文本折叠空白并截断，避免撑爆 toast', () => {
  const junk = `${'甲乙丙丁'.repeat(40)}  ${HIT_WORD}\n当前问题${'已停止'}`
  const out = formatStopToast(junk)
  const shown = out.replace(`${STOPPED_TOAST_GENERIC}（页面命中：`, '').replace(/）$/, '')
  assert.equal(shown.length, 41, `截断后长度应为 40 + 省略号，实际 ${shown.length}`)
  assert.ok(shown.endsWith('…'), '截断应带省略号')
  assert.ok(!/\s{2,}|\n/.test(shown), '空白未折叠')
})

test('stop notice: normalizeStopHit 折叠空白且容忍非字符串', () => {
  assert.equal(normalizeStopHit(' a\n\n b '), 'a b')
  assert.equal(normalizeStopHit(null), '')
  assert.equal(normalizeStopHit(123), '123')
})

test('stop notice: 分段拼接后**运行时呈现逐字不变**（这是本轮改动的红线）', () => {
  // [CONSTRAINT] 分段只改**源码文本**，不改用户看到的话：抬头运行时必须仍能命中词表，
  //   否则就等于偷偷改了 UI 文案 —— 本用例把这条锁死（改拼装方式就红）。
  STOP_RE.lastIndex = 0
  assert.ok(STOP_RE.test(STOPPED_HEAD), `抬头运行时须仍含停机态：${STOPPED_HEAD}`)
  STOP_RE.lastIndex = 0
  assert.ok(STOP_RE.test(STOPPED_SCRIPT_HINT), '脚本提示运行时须仍含停机态')
  STOP_RE.lastIndex = 0
  assert.ok(STOP_RE.test(STOPPED_TOAST_GENERIC), '通用停止文案运行时须仍含停机态')
})

// ───────────────────────── ① 客户端源码不得含停机态词表 ─────────────────────────

const CLIENT_ROOT = path.resolve(__dirname, '..')
const SKIP_DIRS = new Set(['node_modules', 'dist', 'playwright-report', 'test-results', 'e2e'])

/** 递归收集客户端源码文件（跳过产物与依赖） */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), out)
      continue
    }
    if (e.name.endsWith('.ts') || e.name.endsWith('.vue')) out.push(path.join(dir, e.name))
  }
  return out
}

test('stopped vocab: 客户端源码不得含停机态词表（自指通道 census）', () => {
  const files = walk(CLIENT_ROOT)
  assert.ok(files.length > 50, `至少要扫到足量客户端源码，实际 ${files.length} —— 否则本用例是空的`)
  const offenders: Array<{ rel: string, line: number, text: string }> = []
  for (const abs of files) {
    const lines = fs.readFileSync(abs, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      STOP_RE.lastIndex = 0
      if (STOP_RE.test(lines[i])) {
        offenders.push({ rel: path.relative(CLIENT_ROOT, abs), line: i + 1, text: lines[i].trim().slice(0, 90) })
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `客户端源码含 ${offenders.length} 处停机态词表：${JSON.stringify(offenders.slice(0, 6))}\n`
    + '· WHY：这三个停机态就写在页面停止探针的正则里，自己的 UI 文案与之同形 ⇒ 源码被 dump 进会话时，'
    + '它作为页面**普通文本**被自身探针当成站点「停止」横幅 ⇒ 误报并掐掉一整轮（2026-10-10 14:14 实测）。\n'
    + '· 修法：一律分段拼接（见 utils/stop-notice.ts），对外呈现逐字不变。',
  )
})
