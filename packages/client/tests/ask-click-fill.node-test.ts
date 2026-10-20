// @vitest-environment happy-dom
// [ask-click-fill-v1] 承重：点击 ASK 选项必须发出带卡片 askId 的 ai:question 更新事件。
//   [WHY] 用户实测「点了没反应」：askUser 的 id 是 a1/a2，卡片 updateKey 是 askq-<blockId>，
//   两者不同则更新永不命中卡片。此用例在 id 被改回 a1 式序号时会变红。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import RoundCard from '../components/script/RoundCard.vue'

type RoundCardProps = InstanceType<typeof RoundCard>['$props']

const emitted: Array<{ kind: string, updateKey?: string, payload?: Record<string, unknown> }> = []

vi.mock('../composables/ui/useEventStream', () => ({
  emit: (kind: string, _summary: string, opts?: { updateKey?: string, payload?: Record<string, unknown> }) => {
    emitted.push({ kind, updateKey: opts?.updateKey, payload: opts?.payload })
  },
}))

function askCard() {
  return {
    key: 'blk-1-q1',
    type: 'question',
    askId: 'q1',
    timeLabel: '00:00:00',
    text: '选一个',
    preview: '选一个',
    truncated: false,
    hiddenLines: 0,
    options: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }],
    answered: false,
    answer: '',
  } as unknown as RoundCardProps['card']
}

describe('ASK 点击回填（ask-click-fill-v1）', () => {
  beforeEach(() => { emitted.length = 0 })

  it('点击选项必须 emit updateKey=askq-<卡片askId> 且 answered=true', async () => {
    const w = mount(RoundCard, { props: { card: askCard() } })
    const opt = w.find('.question-opt')
    expect(opt.exists()).toBe(true)
    expect(opt.attributes('disabled')).toBeUndefined()
    await opt.trigger('click')
    const hit = emitted.find(e => e.kind === 'ai:question')
    expect(hit, '点击后必须发出 ai:question 更新事件').toBeTruthy()
    expect(hit!.updateKey).toBe('askq-q1')
    expect(hit!.payload?.answered).toBe(true)
    expect(hit!.payload?.answer).toBe('甲')
  })
})
