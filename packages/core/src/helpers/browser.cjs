'use strict'

/** [api-ssot-v1] 本文件是本族 API 签名的唯一 SSOT；SYSTEM.md §3.2 与 ai-guard 注入只列「名字 + 常用项」，完整签名/返回/异常以本文件 JSDoc 为准。 */

/**
 * [helpers-browser-v1] 无头浏览器族：通过独立 CLI 子进程执行 cssom / screenshot。
 *
 * [WHY] 与 shell.cjs 的 shell/exec 不同：本族走 headless-cli.cjs 专用入口，
 * 不经过命令黑名单（参数是 URL/选择器，不是用户命令），故单独成族。
 *
 * [CONSTRAINT] require 单向：index.cjs -> browser.cjs；本文件无 __AI__ 自引用，直接导出。
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/**
 * [browser-cli-path-fix] 定位 headless-cli.cjs 的多候选探测。
 *
 * [WHY] 原写法「从 __dirname 上溯 ../bin」依赖相对位置；standalone 宿主下 __dirname 为
 * apps/standalone/dist，推导出 apps/standalone/bin/... （不存在，MODULE_NOT_FOUND）。
 *
 * [CONSTRAINT] 探测顺序：env 显式指定 → 从 __dirname 逐级上溯 6 层 → cwd/bin → 保底原逻辑。
 * @returns {string} headless-cli.cjs 绝对路径
 */
function resolveHeadlessCli() {
  if (process.env.AI_RUNNER_HEADLESS_CLI && fs.existsSync(process.env.AI_RUNNER_HEADLESS_CLI)) {
    return process.env.AI_RUNNER_HEADLESS_CLI
  }
  let d = __dirname
  for (let i = 0; i < 6; i++) {
    const p = path.join(d, 'bin', 'headless-cli.cjs')
    if (fs.existsSync(p)) return p
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  const c = path.resolve(process.cwd(), 'bin', 'headless-cli.cjs')
  if (fs.existsSync(c)) return c
  return path.join(__dirname, '..', 'bin', 'headless-cli.cjs')
}

/**
 * [browser-run-guard-v1] 同步执行 headless-cli 子命令并解析 JSON 输出。
 *
 * [WHY] CLI 出错时仍会先写 JSON 到 stdout 再 exit(1)；原实现未捕获 execFileSync 抛错，
 * 非零退出会冒泡成脚本级 Error 中断。改为捕获后回读 e.stdout 尝试解析；
 * 无 stdout 则回退到 stderr 片段。
 *
 * @param {string} cmd 子命令（cssom / screenshot）
 * @param {string[]} args 参数
 * @returns {object} CLI 输出的 JSON 对象；解析失败返回 {ok:false, error}
 */
function runCmd(cmd, args) {
  const bin = resolveHeadlessCli()
  let raw = ''
  try {
    raw = execFileSync(process.execPath, [bin, cmd].concat(args), {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    raw = String((e && e.stdout) || '')
    if (!raw) {
      return { ok: false, error: `headless-cli exit ${(e && e.status) || '?'}: ${String((e && e.stderr) || e).slice(0, 300)}` }
    }
  }
  try { return JSON.parse(raw) } catch { return { ok: false, error: `parse fail: ${raw.slice(0, 200)}` } }
}

/**
 * [browser-api-v1] 取页面指定选择器的 computed style 与盒模型。
 * @param {string} url
 * @param {string} selector
 * @returns {object} 同 runCmd 返回结构
 */
function cssom(url, selector) { return runCmd('cssom', [url, selector]) }

/**
 * [browser-api-v1] 截图指定元素并保存到 outPath；mask 为要遮罩的选择器数组。
 * @param {string} url
 * @param {string} selector
 * @param {string} outPath
 * @param {string[]} [mask]
 * @returns {object} 同 runCmd 返回结构
 */
function screenshot(url, selector, outPath, mask) {
  const args = [url, selector, outPath]
  if (Array.isArray(mask) && mask.length) args.push(mask.join(','))
  return runCmd('screenshot', args)
}

module.exports = { cssom, screenshot }
