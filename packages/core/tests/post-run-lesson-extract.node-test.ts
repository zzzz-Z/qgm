// [lesson-autocapture-v1] DONE 总结 → lessons.md 自动提取的解析与去重测试
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { appendLessons, extractLessons } from '../../../packages/core/src/post-run/lesson-extract.js'

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const NL = String.fromCharCode(10)
const WIDE = String.fromCharCode(0xFF1A)

test('extractLessons: 无踩坑记录段 → 空数组', () => {
  assert.deepEqual(extractLessons(`## 结论${NL}完成`), [])
})

test('extractLessons: 空字符串 → 空数组', () => {
  assert.deepEqual(extractLessons(''), [])
})

test('extractLessons: 识别 ## 踩坑记录 下的 ### 子标题', () => {
  const src = [
    '## 结论',
    '一句话总结',
    '## 踩坑记录',
    '### 第一个坑',
    '坑 A 的描述',
    '### 第二个坑',
    '坑 B 的描述',
    '## 遗留风险',
    '- 无',
  ].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 2)
  assert.equal(items[0].title, '第一个坑')
  assert.equal(items[0].body, '坑 A 的描述')
  assert.equal(items[1].title, '第二个坑')
})

test('extractLessons: 识别 ### 踩坑记录 层级（列表式条目）', () => {
  const src = [
    '## 结论',
    '### 踩坑记录',
    '- **坑一号**：描述一',
  ].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '坑一号')
  assert.equal(items[0].body, '描述一')
})

test('extractLessons: 列表形式 - **标题**：正文', () => {
  const src = [
    '## 踩坑记录',
    '- **正则回溯**：无界量词相邻会触发 lint',
    '- **缓存污染**：eslint 报错行号与实际不符',
  ].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 2)
  assert.equal(items[0].title, '正则回溯')
  assert.equal(items[1].title, '缓存污染')
})

test('extractLessons: 全角冒号分隔', () => {
  const src = [
    '## 踩坑记录',
    `- **全角分隔**${WIDE}正文内容`,
  ].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '全角分隔')
  assert.equal(items[0].body, '正文内容')
})

test('extractLessons: 段落终止于同级或更高级标题', () => {
  const src = [
    '## 踩坑记录',
    '### 唯一坑',
    '坑描述',
    '## 后续章节',
    '### 不该被提取',
  ].join(NL)
  const items = extractLessons(src)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '唯一坑')
})

test('extractLessons: 踩坑记录段为空 → 空数组', () => {
  const src = `## 踩坑记录${NL}## 后续`
  assert.deepEqual(extractLessons(src), [])
})

function withTempRoot(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-test-'))
  try {
    fs.mkdirSync(path.join(root, '.ai-runner'), { recursive: true })
    fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('appendLessons: 文件缺失时不写入', () => {
  withTempRoot((root) => {
    const n = appendLessons([{ title: 'X', body: 'Y' }], root)
    assert.equal(n, 0)
  })
})

test('appendLessons: 追加新条目并保留原有内容', () => {
  withTempRoot((root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    fs.writeFileSync(file, `# Lessons${NL}${NL}## 已有条目${NL}${NL}原内容${NL}`, 'utf8')
    const n = appendLessons([{ title: '新条目', body: '新内容' }], root)
    assert.equal(n, 1)
    const after = fs.readFileSync(file, 'utf8')
    assert.ok(after.includes('## 已有条目'))
    assert.ok(after.includes('原内容'))
    assert.ok(after.includes('## 新条目'))
    assert.ok(after.includes('新内容'))
  })
})

test('appendLessons: 标题重复时跳过', () => {
  withTempRoot((root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    fs.writeFileSync(file, `# Lessons${NL}${NL}## 重复标题${NL}${NL}旧内容${NL}`, 'utf8')
    const n = appendLessons([{ title: '重复标题', body: '新内容' }], root)
    assert.equal(n, 0)
    const after = fs.readFileSync(file, 'utf8')
    assert.ok(after.includes('旧内容'))
    assert.ok(!after.includes('新内容'))
  })
})

test('appendLessons: 混合条目只追加未重复部分', () => {
  withTempRoot((root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    fs.writeFileSync(file, `# Lessons${NL}${NL}## 存在A${NL}`, 'utf8')
    const n = appendLessons([
      { title: '存在A', body: 'x' },
      { title: '新增B', body: 'y' },
    ], root)
    assert.equal(n, 1)
  })
})
