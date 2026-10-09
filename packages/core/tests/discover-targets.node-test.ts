// [discover-targets-v1] 验证「自动发现业务 app 目标」的核心逻辑与「DONE 漏验 app 降级」判据。
// 动机：原冒烟只验宿主 5175/__ai/，业务 app（如 8091）从不被验；
//   且 agent 可用「沙箱无法驱动 dev server」这类未经验证的断言跳过验证（违反 §0 假设先行）。
// 本测试覆盖：env 端口解析、配置端口解析、端口探测、自动发现产出、合规闸门漏验判定。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  discoverTargets,
  parseEnvPorts,
  parsePackagePort,
  probePort,
} from '../src/headless/discover-targets.js'
import { computeSmokeReportCompliance } from '../src/post-run/run-compliance.js'

test('parseEnvPorts: 解析 VITE_APP_PORT / PORT', () => {
  assert.deepEqual(parseEnvPorts('VITE_APP_PORT=8091\nPORT=3000\nFOO=1'), [8091, 3000])
  assert.deepEqual(parseEnvPorts('no port here'), [])
})

test('parsePackagePort: 解析 dev 脚本 --port / -p', () => {
  assert.equal(parsePackagePort('vite --port 8091'), 8091)
  assert.equal(parsePackagePort('vite -p 5174'), 5174)
  assert.equal(parsePackagePort('vite'), null)
})

test('probePort: 对真实监听端口返回 true，关闭端口返回 false', async () => {
  const server = net.createServer()
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  assert.equal(await probePort(port), true)
  await new Promise<void>(r => server.close(() => r()))
  assert.equal(await probePort(port), false)
})

test('discoverTargets: host + env 覆盖（skipPortScan，隔离 root）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-'))
  const prev = process.env.APP_DEV_URL
  process.env.APP_DEV_URL = 'http://localhost:8099,http://localhost:8100'
  try {
    const targets = await discoverTargets({ hostUrl: 'http://localhost:5175', root: tmp, skipPortScan: true })
    const tags = targets.map(t => t.tag)
    const sources = targets.map(t => t.source)
    assert.ok(tags.includes('host'), '应包含宿主目标')
    assert.ok(sources.includes('env'), '应包含 env 覆盖目标')
    assert.ok(targets.some(t => t.source === 'env' && t.url === 'http://localhost:8099'), 'env 目标 URL 应精确')
    assert.ok(targets.some(t => t.source === 'env' && t.url === 'http://localhost:8100'), 'env 支持多个')
  } finally {
    if (prev === undefined) delete process.env.APP_DEV_URL
    else process.env.APP_DEV_URL = prev
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('discoverTargets: 排除宿主端口区间 5175-5185', async () => {
  // COMMON_DEV_PORTS 含 5175，但若作为 host 传入走 host 分支；端口探测必须跳过 5175-5185
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-'))
  try {
    const targets = await discoverTargets({ root: tmp, skipPortScan: true })
    const ports = targets.map(t => t.url).filter(u => u.includes('5175') || u.includes('5176'))
    assert.equal(ports.length, 0, '无 hostUrl 时不应出现 5175-5185 区间目标')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('computeSmokeReportCompliance: DONE 未引用 app 目标 → 判为漏验(missing)', () => {
  const targets = [
    { tag: 'host', url: 'http://localhost:5175', source: 'host' as const },
    { tag: 'app:proj-a', url: 'http://127.0.0.1:8091', source: 'config' as const, project: 'proj-a' },
  ]
  const r1 = computeSmokeReportCompliance('页面冒烟 ✓ /__ai/', targets)
  assert.ok(r1, '存在 app 目标时应返回结果')
  assert.equal(r1!.missing.length, 1, '应识别出一个漏验的 app 目标')
  assert.equal(r1!.missing[0].tag, 'app:proj-a')

  const r2 = computeSmokeReportCompliance('页面冒烟 ✓ [app:proj-a] http://127.0.0.1:8091/', targets)
  assert.ok(r2)
  assert.equal(r2!.missing.length, 0, 'DONE 引用了 app 目标则不再判漏验')
})

test('computeSmokeReportCompliance: 无 app 目标 → 返回 null（不误伤）', () => {
  const targets = [{ tag: 'host', url: 'http://localhost:5175', source: 'host' as const }]
  assert.equal(computeSmokeReportCompliance('页面冒烟 ✓ /__ai/', targets), null)
})
