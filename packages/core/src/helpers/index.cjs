'use strict'

/** [api-ssot-v1] 本文件是本族 API 签名的唯一 SSOT；SYSTEM.md §3.2 与 ai-guard 注入只列「名字 + 常用项」，完整签名/返回/异常以本文件 JSDoc 为准。 */
/**
 * [helpers-index-v1] __AI__ 门面装配入口：唯一 API 面，实现在 helpers/ 各子文件按职责分族。
 *
 * [WHY] 沙箱脚本只认 __AI__；把「装配」与「实现」分开，单文件职责单一，便于按族演进。
 *
 * [CONSTRAINT] require 单向：index.cjs → 各子文件（子文件禁止反向 require）；
 * 需 __AI__ 自引用的族走工厂注入（self 传函数），避免装配期 __AI__ 未就绪。
 */
const path = require('node:path')

/** 子族 require（按职责分组）。 */
/** [helpers-io-v1] 单文件读写 + 审计漏斗（changelog / hostOwned）。 */
const _io = require('./io.cjs')

/** [helpers-util-v1] glob 转换 / bin 定位 / 同步执行 / toolLog / 转义。 */
const _util = require('./util.cjs')

/** [helpers-shell-v1] 执行族（shell / exec / 后台任务）。 */
const { createShellApi } = require('./shell.cjs')
const probeApi = require('./probe.cjs')

/** [helpers-search-v1] 检索与读缓存（walk / grep / template / cache）。 */
const { createSearchApi } = require('./search.cjs')

/** [helpers-state-v1] state.json 读写 + 环境字段自愈。 */
const { createStateApi } = require('./state.cjs')

/** [helpers-output-v1] 语义输出 / 退出协议 / 断言。 */
const { createOutputApi } = require('./output.cjs')

/** [helpers-patch-v1] backup（首次备份）+ patchFile（锚点替换）。 */
const { createPatchApi } = require('./patch.cjs')

/** [helpers-fs-v1] 目录遍历 / 变更集 / 项目根 / 原子写。 */
const { createFsApi } = require('./fs.cjs')

/** [helpers-lint-v1] eslint / vue-tsc（DONE 前自检）。 */
const { createLintApi } = require('./lint.cjs')

/** [helpers-misc-v1] dump / cwdMust / syntaxCheck / flush / assertCtx。 */
const { createMiscApi } = require('./misc.cjs')

/** [helpers-skill-v1] loadSkill（幂等追加 loaded-skill.md）。 */
const { createSkillApi } = require('./skill.cjs')

/** [helpers-lessons-v1] lessons 检索（HTTP，失败返回 {ok:false,error}）。 */
const lessonsApi = require('./lessons.cjs')

/** [helpers-tasks-v1] 任务看板（HTTP，sid 由服务端按会话分桶）。 */
const tasksApi = require('./tasks.cjs')

/** [helpers-session-v1] 隔离会话族（HTTP，服务端 session-manager 托管）。 */
const sessionApi = require('./session.cjs')

/** [helpers-subagent-v1] 子智能体编排族（HTTP，服务端单例编排器托管）。 */
const subagentApi = require('./subagent.cjs')

/** [helpers-browser-v1] 无头浏览器（cssom / screenshot 走 CLI 子进程）。 */
const browserApi = require('./browser.cjs')

const { _openToolLog, _logExec, globToRe, _binPath, _execBin, _anchorReport, esc: _esc } = _util
const { _changelog, safeReaddir } = _io

/** 工厂装配出的族实例（装配段在 __AI__ 定义之后填充）。 */
let shellApi = null
let searchApi = null
let stateApi = null
let outputApi = null
let patchApi = null
let fsApi = null
let lintApi = null
let miscApi = null
let skillApi = null

/** [tool-log-exec-v1] 初始化 toolLog 句柄（写入函数在 util.cjs，供自检命令对账治造假）。 */
_openToolLog()

/** [chalk] 语义输出统一走 chalk；协议帧（__AI_*__ / __AI_MODE_DIFF__）保持裸 console 供 runner 解析。 */
let _chalk = null
try { _chalk = require('chalk') } catch { _chalk = null }
const _useColor = (Boolean(process.stdout && process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR)) && !process.env.NO_COLOR
const _c = (_chalk && _useColor)
  ? _chalk
  : { green: s => s, yellow: s => s, red: s => s, cyan: s => s, gray: s => s, dim: s => s }
/**
 * [host-owned-write-guard-v1] 宿主独占文件（packages/core/SYSTEM.md）的写入门禁。
 *
 * [WHY] SSOT 存在两个写入者（/run 通道 + 宿主侧 Edit），后者不入 changelog ⇒ 并发改写时锚点会指向旧内容。
 *
 * [CONSTRAINT] 观测期只留痕（changelog.hostOwned）+ stderr 告警，不阻断：
 * 硬拦会连带挡掉合法修订，且非零退出会让整轮 overlay 丢弃，把小事故放大成整轮写入丢失。
 *
 * [CHANGE-IMPACT] changelog.jsonl 新增 hostOwned 键，消费方做严格 schema 校验需容忍。
 */

/** __AI__ 是沙箱脚本唯一的 API 面；各方法为对子族的转发，实现见 helpers/ 对应文件。 */
const __AI__ = {
  /** io 族（helpers/io.cjs）：单文件读写 + 审计漏斗。 */
  readJSON(p) { return _io.readJSON(p) },
  readText(p) { return _io.readText(p) },
  writeText(p, s) { return _io._writeText(p, s) },
  writeFile(p, c) { return _io._writeText(p, c) },
  appendText(p, s) { return _io.appendText(p, s) },
  tryReadFile(p) { return _io.tryReadFile(p) },
  readFile(p) { return this.readText(p) },
  fileInfo(p) { return _io.fileInfo(p) },
  /**
   * [api-surface-parity-v1] exists 的转发曾整条缺失：io.cjs 导出并实现了 exists，
   * SYSTEM.md §3.2 与 ai-guard 注入的 JSDoc 都在教 __AI__.exists(p)，
   * 但门面没接 ⇒ 照文档写的脚本恒 TypeError（已实测）。
   */
  exists(p) { return _io.exists(p) },
  deleteFile(p, opts) { return _io.deleteFile(p, opts) },
  replaceInFile(p, opts) { return _io.replaceInFile(p, opts) },
  join() { return path.join.apply(path, arguments) },
  esc: _esc,

  /** fs 族（helpers/fs.cjs）：目录遍历 / 变更集 / 项目根 / 原子写。 */
  readFiles(glob) { return fsApi.readFiles(glob) },
  getChangedFiles() { return fsApi.getChangedFiles() },
  getProjectRoot() { return fsApi.getProjectRoot() },
  atomicWrite(file, content) { return fsApi.atomicWrite(file, content) },
  affectedTests(changedFiles, opts) { return fsApi.affectedTests(changedFiles, opts) },
  reflect(opts) { return fsApi.reflect(opts) },

  /** output 族（helpers/output.cjs）：语义输出 / 退出协议 / 断言。 */
  log(...args) { return outputApi.log(...args) },
  ok(msg) { return outputApi.ok(msg) },
  skip(msg) { return outputApi.skip(msg) },
  warn(msg) { return outputApi.warn(msg) },
  err(msg) { return outputApi.err(msg) },
  exit(code, msg) { return outputApi.exit(code, msg) },
  assert(cond, msg) { return outputApi.assert(cond, msg) },
  assertVueHasName(file) { return outputApi.assertVueHasName(file) },
  assertContains(file, anchor) { return outputApi.assertContains(file, anchor) },
  assertNotContains(file, anchor) { return outputApi.assertNotContains(file, anchor) },
  writeDiffReport(obj) { return outputApi.writeDiffReport(obj) },
  exitNeedInput(q, o, d) { return outputApi.exitNeedInput(q, o, d) },
  exitNeedFiles(paths) { return outputApi.exitNeedFiles(paths) },

  /** lint 族（helpers/lint.cjs）：eslint / vue-tsc 自检。 */
  lint(files) { return lintApi.lint(files) },
  typeCheck() { return lintApi.typeCheck() },

  /** patch 族（helpers/patch.cjs）：backup + 锚点替换。 */
  backup(file) { return patchApi.backup(file) },
  patchFile(file, anchor, replacement, opts) { return patchApi.patchFile(file, anchor, replacement, opts) },

  /** state 族（helpers/state.cjs）：state.json 读写 + 环境字段自愈。 */
  statePath() { return stateApi.statePath() },
  readState() { return stateApi.readState() },
  updateState(fn) { return stateApi.updateState(fn) },
  _ensureEnvFields(st) { return stateApi._ensureEnvFields(st) },

  /** misc 族（helpers/misc.cjs）：行切片 / cwd 断言 / 语法检查 / overlay 落盘。 */
  dump(file, from, to) { return miscApi.dump(file, from, to) },
  cwdMust(expected) { return miscApi.cwdMust(expected) },
  syntaxCheck(code, filename) { return miscApi.syntaxCheck(code, filename) },
  flush() { return miscApi.flush() },
  assertCtx(spec) { return miscApi.assertCtx(spec) },

  /** shell 族（helpers/shell.cjs）：shell / exec / 后台任务管控（均异步，须 await）。 */
  shell(cmd, opts) { return shellApi.shell(cmd, opts) },
  _shellBlacklist(parts, flat) { return shellApi._shellBlacklist(parts, flat) },
  exec(cmd, args, opts) { return shellApi.exec(cmd, args, opts) },
  shellStatus(id) { return shellApi.shellStatus(id) },
  readShell(id, opts) { return shellApi.readShell(id, opts) },
  killShell(id) { return shellApi.killShell(id) },

  /** probe 族（helpers/probe.cjs）：端口探活 / 等后台任务 / 结构化跑测试。 */
  probe(port, opts) { return probeApi.probe(port, opts) },
  shellWait(id, opts) { return probeApi.shellWait(id, opts, shellApi.shellStatus) },
  testRun(files, opts) { return probeApi.testRun(files, opts, (c, o) => shellApi.shell(c, o)) },

  /** search 族（helpers/search.cjs）：检索 / 模板解析 / 读缓存。 */
  walk(dir, opts) { return searchApi.walk(dir, opts) },
  grep(pattern, opts) { return searchApi.grep(pattern, opts) },
  /** [top-freq-v1] 聚合频次统计，等价 grep|sort|uniq -c|sort -rn。@param {string|RegExp} pattern @param {object} [opts] @returns {Array<{count:number,value:string}>} */
  topFreq(pattern, opts) { return searchApi.topFreq(pattern, opts) },
  symbol(name, opts) { return searchApi.symbol(name, opts) },
  findDefinition(name, opts) { return searchApi.findDefinition(name, opts) },
  findReferences(name, opts) { return searchApi.findReferences(name, opts) },
  renameSymbol(name, newName, opts) { return searchApi.renameSymbol(name, newName, opts) },
  dumpCtx(file, line, n) { return searchApi.dumpCtx(file, line, n) },
  template(file) { return searchApi.template(file) },
  usedInTemplate(file, names) { return searchApi.usedInTemplate(file, names) },
  fileSig(file) { return searchApi.fileSig(file) },
  readIfChanged(file) { return searchApi.readIfChanged(file) },
  clearReadCache() { return searchApi.clearReadCache() },
  _readCachePath() { return searchApi._readCachePath() },
  readCacheMap() { return searchApi.readCacheMap() },
  _writeCacheMap(m) { return searchApi._writeCacheMap(m) },

  /** skill 族（helpers/skill.cjs）：幂等追加 loaded-skill.md。 */
  loadSkill(content) { return skillApi.loadSkill(content) },

  /** 无 __AI__ 自引用的族：直接引用导出对象。 */
  lessons: lessonsApi,
  tasks: tasksApi,
  session: sessionApi,
  subagent: subagentApi,
  browser: browserApi,
}
/**
 * 装配段（须在 __AI__ 定义之后：deps 里普遍要传 self / __AI__.err / exec）。
 *
 * [CONSTRAINT] self 一律传函数 `() => __AI__` 而非对象：此刻 __AI__ 已就绪，但工厂内部
 * 持有的是引用型 getter，可在后续被替换（避免工厂闭包捕获旧对象）。
 */
shellApi = createShellApi({
  logExec: (cmd, args) => { _logExec(cmd, args) },
  err: (msg) => { __AI__.err(msg) },
})

searchApi = createSearchApi({ self: () => __AI__, safeReaddir, esc: _esc })

stateApi = createStateApi({ self: () => __AI__ })

outputApi = createOutputApi({ self: () => __AI__, c: _c })

patchApi = createPatchApi({ self: () => __AI__, changelog: _changelog, anchorReport: _anchorReport })

fsApi = createFsApi({ self: () => __AI__, safeReaddir, globToRe, changelog: _changelog })

lintApi = createLintApi({ binPath: _binPath, execBin: _execBin })

miscApi = createMiscApi({ err: (msg) => { __AI__.err(msg) }, exec: (cmd, args, opts) => __AI__.exec(cmd, args, opts) })

skillApi = createSkillApi({ changelog: _changelog })

/**
 * [sandbox-api-v1] 挂到 global：/run 沙箱脚本通过 require(helpers.cjs) 装载后读 global.__AI__。
 *
 * [CONSTRAINT] 这是沙箱侧 API 面的唯一注入点，删除或改名会让所有脚本失效。
 */
global.__AI__ = __AI__
