// @vitest-environment happy-dom
// [no-fold-full-text-v1] 承重守卫：卡片默认全量展示，不允许再有任何折叠入口。
// [WHY] 用户 2026-10-21：「删除展开全部 默认就全部展示」。改动前 text / done 卡超阈值（12 行 / 800 字符）
//   只渲染 card.preview，末尾挂一个「展开全部 · 还有 N 行」按钮。这次连按钮带机制一并删除，
//   若有人把 collapsed ? preview : text 的分支加回来、或重新引入 FoldToggle，本用例必红。
// [判据设计] 不写「源码里没有 X」这种可被注释污染的字面量判据（那类判据见 component-binding-guard T4），
//   这里做**行为级**断言：把一张确定会被 clampTextPreview 截断的长卡片挂上去，
//   断言渲染出的可见文本长度 > preview 的字符上限、且包含原文最后一行 —— 只有真正渲染了全文才可能通过。
//   前置断言（fixture 确实 truncated 且 preview ≤ 800）保证本用例不是恒真：夹具若被改成短文本，
//   前置断言先红，不会静默退化成「什么都没验」。
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import RoundCard from '../components/script/RoundCard.vue'
import { clampTextPreview } from '../utils/timeline-preview'

vi.mock('../composables/ui/useEventStream', () => ({
  emit: () => {},
}))

type RoundCardProps = InstanceType<typeof RoundCard>['$props']

/** 造一段必然超阈值的文本：60 行 × 40 字 ≈ 2400 字符，末行带哨兵标记 */
const TAIL_MARKER = 'TAIL-MARKER-ONLY-IN-FULL-TEXT'
function longText(): string {
  const lines = Array.from({ length: 60 }, (_, i) => `第 ${String(i + 1).padStart(2, '0')} 行：${'内容填充'.repeat(10)}`)
  lines.push(TAIL_MARKER)
  return lines.join('\n')
}

const FULL = longText()

function cardOf(type: 'text' | 'done' | 'ask' | 'question') {
  const pv = clampTextPreview(FULL, 12, 800)
  const base = {
    key: `k-${type}`,
    type,
    timeLabel: '00:00:00',
    text: FULL,
    preview: pv.preview,
    truncated: pv.truncated,
    hiddenLines: pv.hiddenLines,
    totalLines: pv.totalLines,
  }
  if (type === 'question') {
    return {
      ...base,
      askId: 'q1',
      options: [{ id: 'a', label: '甲' }],
      answered: false,
      answer: '',
    } as unknown as RoundCardProps['card']
  }
  return base as unknown as RoundCardProps['card']
}

describe('卡片默认全量展示（no-fold-full-text-v1）', () => {
  it('前置：夹具确实被 clampTextPreview 截断，且 preview 不超过 800 字符', () => {
    const pv = clampTextPreview(FULL, 12, 800)
    expect(pv.truncated, '夹具必须是「会被截断的长文本」，否则下面的断言退化为恒真').toBe(true)
    expect(pv.preview.length).toBeLessThanOrEqual(800)
    expect(pv.preview.includes(TAIL_MARKER), 'preview 不该包含末行哨兵').toBe(false)
  })

  for (const type of ['text', 'done', 'ask', 'question'] as const) {
    it(`${type} 卡：渲染全文（含末行哨兵），且不存在折叠入口`, () => {
      const w = mount(RoundCard, { props: { card: cardOf(type) } })
      const rendered = w.text()

      expect(w.find('.fold-toggle').exists(), '「展开全部 · 还有 N 行」入口必须已删除').toBe(false)
      expect(w.html().includes('展开全部')).toBe(false)
      expect(rendered.includes(TAIL_MARKER), '末行哨兵必须在场 —— 缺席即说明还在渲染 preview').toBe(true)
      expect(rendered.length, '渲染长度必须超过 preview 上限 800，否则仍是截断态').toBeGreaterThan(800)
      w.unmount()
    })
  }
})
