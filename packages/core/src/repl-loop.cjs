'use strict'
const vm = require('node:vm')
const util = require('node:util')
// [vm-require-v1] vm.runInThisContext 执行的代码没有 CJS require 注入；
//   框架约定：沙箱脚本可用 require 加载 node 内置模块（与 -e 模式一致）。
globalThis.require = require

// [frame-channel-purity-v1] stdout 是协议通道，必须严格「一帧进、一帧出」。
// [WHY] 用户代码的 console.log 若直写 stdout，其文本（如 "1"）会被父进程 JSON.parse 成合法值
//   并当成帧投递 ⇒ 请求与响应从此永久错位（实测第 2 帧起全部串位）。
// [CONSTRAINT] 用户可见输出一律收进本帧 logs 数组随结果帧回传；协议行只由 OUT 写。
const realWrite = process.stdout.write.bind(process.stdout)

/** 协议行写出：必须绕过下面的 stdout 覆写，否则帧本身会被当日志吞掉。 */
function OUT(o) {
  realWrite(JSON.stringify(o) + String.fromCharCode(10))
}

/** 本帧累计的用户输出 */
let logs = []

function pushLog(s) {
  logs.push(s)
}

process.stdout.write = (chunk) => { pushLog(String(chunk)); return true }
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
  // eslint-disable-next-line no-console -- 覆写 console 方法本体，把用户输出改道进 logs
  console[k] = (...a) => { pushLog(util.format(...a)) }
}

/**
 * 收尾一帧：logs 为空时不带该字段（保持无输出帧的既有形状）。
 * [flush-before-emit-v1] 先 flush overlay 再回帧 —— 保证「消费方看到帧时 overlay 必已落盘」；
 * 反过来（先回帧后 flush）会让消费方读 overlay 命中竞态。
 */
function emit(base) {
  const frame = logs.length ? Object.assign({}, base, { logs }) : base
  logs = []
  if (typeof globalThis.__AI_FLUSH_OVERLAY === 'function') { try { globalThis.__AI_FLUSH_OVERLAY() } catch { /* flush 失败不阻断帧 */ } }
  OUT(frame)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let i = buf.indexOf(String.fromCharCode(10))
  while (i >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (line.trim()) {
      let id
      try {
        const f = JSON.parse(line)
        id = f && f.id
        vm.runInThisContext(String(f.code || ''))
        emit({ id, ok: true })
      } catch (e) {
        emit({ id, ok: false, error: String(e && e.message ? e.message : e) })
      }
    }
    i = buf.indexOf(String.fromCharCode(10))
  }
})
