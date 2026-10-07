// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/process-proc-detect.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/process-proc-detect.node-test.ts 迁至 test/process-proc-detect.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/process/proc-detect.node-test.ts 迁至 client/test/process-proc-detect.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { detectPackageManager } from '../../../packages/core/src/process/proc.js'

// AIRUNNER-BATCH13-1-DETECT-PM

// [test-tmpdir-v1] 夹具不再落 .ai-runner（会累积成灾；本测试不依赖 getRoot）
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'test-pm-'))
}

function withEnv(key: string, val: string | undefined, fn: () => void): void {
  const saved = process.env[key]
  if (val === undefined) delete process.env[key]
  else process.env[key] = val
  try { fn() } finally {
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
}

test('npm_execpath 含 pnpm → pnpm（即使目录内有 yarn.lock）', () => {
  const d = tmpDir()
  try {
    fs.writeFileSync(path.join(d, 'yarn.lock'), '')
    withEnv('npm_execpath', '/usr/local/bin/pnpm.cjs', () => {
      assert.equal(detectPackageManager(d), 'pnpm')
    })
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('npm_execpath 含 yarn → yarn（即使目录内有 pnpm-lock.yaml）', () => {
  const d = tmpDir()
  try {
    fs.writeFileSync(path.join(d, 'pnpm-lock.yaml'), '')
    withEnv('npm_execpath', '/usr/bin/yarn.js', () => {
      assert.equal(detectPackageManager(d), 'yarn')
    })
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('npm_execpath 不含已知包管理器 → 回退到锁文件 pnpm-lock.yaml', () => {
  const d = tmpDir()
  try {
    fs.writeFileSync(path.join(d, 'pnpm-lock.yaml'), '')
    withEnv('npm_execpath', '/usr/local/bin/npm-cli.js', () => {
      assert.equal(detectPackageManager(d), 'pnpm')
    })
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('无 pnpm 但有 yarn.lock → yarn', () => {
  const d = tmpDir()
  try {
    fs.writeFileSync(path.join(d, 'yarn.lock'), '')
    withEnv('npm_execpath', '', () => {
      assert.equal(detectPackageManager(d), 'yarn')
    })
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('两锁文件均有（无 execPath）→ pnpm 优先', () => {
  const d = tmpDir()
  try {
    fs.writeFileSync(path.join(d, 'pnpm-lock.yaml'), '')
    fs.writeFileSync(path.join(d, 'yarn.lock'), '')
    withEnv('npm_execpath', '', () => {
      assert.equal(detectPackageManager(d), 'pnpm')
    })
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('无 execPath + 无锁文件 → npm（默认）', () => {
  const d = tmpDir()
  try {
    withEnv('npm_execpath', undefined, () => {
      assert.equal(detectPackageManager(d), 'npm')
    })
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('目录不存在 + 无 execPath → npm（默认）', () => {
  withEnv('npm_execpath', undefined, () => {
    assert.equal(detectPackageManager(`/tmp/no-such-root-${Date.now()}`), 'npm')
  })
})

test('execPath 大小写敏感：PNPM 大写不匹配（实现用 /pnpm/）', () => {
  const d = tmpDir()
  try {
    withEnv('npm_execpath', '/USR/LOCAL/BIN/PNPM', () => {
      assert.equal(detectPackageManager(d), 'npm')
    })
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})
