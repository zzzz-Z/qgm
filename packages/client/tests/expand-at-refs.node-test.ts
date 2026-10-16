// [at-ref-expand-v1] 承重判据：@ 引用展开必须真的把正文塞进 prompt，否则规则无法被删。
// [VARIANT] 变异验证：把 expand-at-refs.ts 里 replacements.push 那行短路 → 用例 1 必红。
// [CONSTRAINT] 不触真盘：readFile 用桩注入，模拟「技能存在 / 不存在 / 超大」三态。
import { expect, test } from 'vitest'
import { AT_FILE_MAX_BYTES, AT_SKILL_PREFIX, expandAtRefs } from '../composables/ai/expand-at-refs.js'

/** 造一个按路径返回内容的桩；未命中返回 null */
function makeRead(map: Record<string, string | null>) {
  return async (p: string): Promise<string | null> => (p in map ? map[p] : null)
}

test('C1: @skill/<name> 展开为 <file> 块，正文进 prompt', async () => {
  const r = await expandAtRefs('帮我看下 @skill/pnpm 的用法', {
    readFile: makeRead({ '.ai-runner/skills/pnpm/SKILL.md': 'PNPM-BODY' }),
  })
  expect(r.expanded).toEqual(['.ai-runner/skills/pnpm/SKILL.md'])
  expect(r.text).toContain('<file path=".ai-runner/skills/pnpm/SKILL.md">')
  expect(r.text).toContain('PNPM-BODY')
  expect(r.text).not.toContain('@skill/pnpm')
})

test('C2: 普通 @<path> 同样展开', async () => {
  const r = await expandAtRefs('见 @docs/USAGE.md 结尾', {
    readFile: makeRead({ 'docs/USAGE.md': 'USAGE-BODY' }),
  })
  expect(r.expanded).toEqual(['docs/USAGE.md'])
  expect(r.text).toContain('USAGE-BODY')
  expect(r.text).not.toContain('@docs/USAGE.md')
})

test('C3: 文件不存在保留原文，不静默丢弃用户意图', async () => {
  const r = await expandAtRefs('引用 @skill/ghost 这里', {
    readFile: makeRead({}),
  })
  expect(r.expanded).toEqual([])
  expect(r.skipped).toEqual([{ ref: 'skill/ghost', reason: 'not-found' }])
  expect(r.text).toContain('@skill/ghost')
})

test('C4: 单文件超上限跳过，不截断内容', async () => {
  const huge = 'x'.repeat(AT_FILE_MAX_BYTES + 1)
  const r = await expandAtRefs('看 @skill/huge', {
    readFile: makeRead({ '.ai-runner/skills/huge/SKILL.md': huge }),
  })
  expect(r.expanded).toEqual([])
  expect(r.skipped).toEqual([{ ref: 'skill/huge', reason: 'over-budget' }])
  expect(r.text).not.toContain(huge.slice(0, 100))
})

test('C5: 幂等——已在 <file> 块内的 @ 不再展开', async () => {
  const src = '<file path="a.md">\n@skill/pnpm 在块内\n</file>\n外面 @skill/pnpm'
  const r = await expandAtRefs(src, {
    readFile: makeRead({ '.ai-runner/skills/pnpm/SKILL.md': 'BODY' }),
  })
  // 块内不动（原文保留），块外的 @skill/pnpm 被展开一次
  const matches = r.text.match(/BODY/g) || []
  expect(matches.length).toBe(1)
  expect(r.text).toContain('@skill/pnpm 在块内')
})

test('C6: 无 @ 引用时原样返回，不产生副作用', async () => {
  const src = '普通提问 没有引用'
  const r = await expandAtRefs(src, { readFile: makeRead({}) })
  expect(r.text).toBe(src)
  expect(r.expanded).toEqual([])
  expect(r.skipped).toEqual([])
})

test('C7: 邮件地址里的 @ 不误伤', async () => {
  const r = await expandAtRefs('联系 user@example.com 或看 @docs/x.md', {
    readFile: makeRead({ 'docs/x.md': 'X-BODY' }),
  })
  expect(r.text).toContain('user@example.com')
  expect(r.text).toContain('X-BODY')
  expect(r.expanded).toEqual(['docs/x.md'])
})

test('C8: SKILL_PICK_PREFIX 常量值稳定（避免与 file-picker 漂移）', () => {
  expect(AT_SKILL_PREFIX).toBe('skill/')
})
