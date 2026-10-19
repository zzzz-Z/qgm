import { test } from 'vitest'
import { parseTurn } from '../src/reply/turn-schema.js'

test('parseTurn 三类输入', () => {
  const obj = { v: 1, turn: 1, content: [{ type: 'say', id: 's1', text: 'hi' }] }
  const cases: [string, string][] = [
    ['纯 JSON', JSON.stringify(obj)],
    ['围栏包裹', `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``],
    ['围栏同行', `\`\`\`json${JSON.stringify(obj)}\`\`\``],
  ]
  for (const [name, md] of cases) {
    const r = parseTurn(md)
    console.log(`${name} => blocks=${r.blocks ? r.blocks.length : 0} errors=${JSON.stringify((r.errors || []).map((e: any) => e.code))}`)
  }
})
