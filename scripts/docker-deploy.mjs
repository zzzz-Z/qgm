#! /usr/bin/env node
// @desc: 一键把工作台部署到 Docker：构建（可选）→ 启动 → 等健康 → 打印入口
// @why: 手工 `up -d` + `ps` + `curl` 三步易漏、首次构建耗时长难判断进度；脚本统一流程并在失败时给出可执行提示
// @plan: docker-deploy
//
// 用法：
//   pnpm docker:deploy            # 缺镜像则自动构建，然后启动并等健康
//   pnpm docker:deploy --build    # 强制重建镜像（改了 Dockerfile / 依赖 / 源码）
//   pnpm docker:deploy --no-build # 只启动（快，镜像必须已存在）
//   pnpm docker:deploy --down     # 停止并删除容器（保留数据卷）
//   pnpm docker:deploy --logs     # 跟随日志
//   pnpm docker:deploy --prune    # 清理悬空镜像与未使用的构建缓存（反复重建后回收数 GB）
//
// [CONSTRAINT] 依赖 compose.yaml 中服务名 ai-runner；改服务名须同步本脚本 SERVICE
'use strict'

import { spawnSync } from 'node:child_process'

const ROOT = process.cwd()
const SERVICE = 'ai-runner'
const IMAGE = 'qgm/ai-runner:local'
const WORKBENCH_URL = 'http://localhost:5175/__ai/'
const NOVNC_URL = 'http://localhost:6080/vnc.html?autoconnect=1&resize=scale'
const DEFAULT_TIMEOUT_SEC = 300

const NL = String.fromCharCode(10)

// 打印一行带前缀的状态；统一输出格式便于人眼扫读
function say(tag, msg) {
  console.log(`${tag} ${msg}`)
}

// 同步休眠：用 Atomics 而非 spawn sleep，避免多起进程且不依赖外部命令
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// 执行外部命令；capture=true 时捕获输出，否则继承 stdio 让构建/启动进度直接可见
function run(cmd, args, capture = false) {
  const child = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
  if (child.error) return { code: 127, out: '', err: String(child.error.message) }
  return { code: child.status ?? 1, out: (child.stdout || '').trim(), err: (child.stderr || '').trim() }
}

// 解析 CLI 参数：支持 --build / --no-build / --down / --logs / --timeout=N / --help
function parseArgs(argv) {
  const flags = { build: false, noBuild: false, down: false, logs: false, prune: false, help: false, timeout: DEFAULT_TIMEOUT_SEC }
  for (const a of argv) {
    if (a === '--build') flags.build = true
    else if (a === '--no-build') flags.noBuild = true
    else if (a === '--down') flags.down = true
    else if (a === '--logs') flags.logs = true
    else if (a === '--prune') flags.prune = true
    else if (a === '--help' || a === '-h') flags.help = true
    else if (a.startsWith('--timeout=')) flags.timeout = Number(a.split('=')[1]) || DEFAULT_TIMEOUT_SEC
    else say('[!!]', `未知参数被忽略：${a}`)
  }
  return flags
}

// 环境自检：docker CLI / compose 插件 / 守护进程任一不可用即退出，避免后续报错难懂
function preflight() {
  for (const [label, args] of [['docker CLI', ['--version']], ['docker compose', ['compose', 'version']]]) {
    const versionResult = run('docker', args, true)
    if (versionResult.code !== 0) {
      say('[XX]', `未检测到 ${label}。请先安装并启动 Docker Desktop / dockerd。`)
      process.exit(1)
    }
    say('[ok]', `${label}: ${versionResult.out.split(NL)[0]}`)
  }
  if (run('docker', ['info'], true).code !== 0) {
    say('[XX]', 'Docker 守护进程未运行（docker info 失败）。启动 Docker Desktop 后重试。')
    process.exit(1)
  }
}

// 镜像是否已存在；用于决定缺镜像时是否自动构建
function imageExists() {
  return run('docker', ['image', 'inspect', IMAGE], true).code === 0
}

// 构建镜像；[CONSTRAINT] 首次构建含 pnpm install + playwright 下载，可超 8 分钟，故继承 stdio 展示进度
function buildImage() {
  say('[..]', `构建镜像 ${IMAGE}（首次较慢，含 pnpm install / playwright chromium 下载）...`)
  if (run('docker', ['compose', 'build']).code !== 0) {
    say('[XX]', '镜像构建失败。常见原因：网络不可达 / 依赖安装报错，详见上方输出。')
    process.exit(1)
  }
  say('[ok]', '镜像构建完成')
}

// 启动服务（detached）；与 compose.yaml 的 restart: unless-stopped 叠加，重启宿主会自动拉起
function composeUp() {
  if (run('docker', ['compose', 'up', '-d']).code !== 0) {
    say('[XX]', '启动失败。若为端口占用，请先释放 5175 / 6080，或用 pnpm docker:down 清理旧容器。')
    process.exit(1)
  }
}

// 查当前服务容器 id；空串表示容器未创建
function containerId() {
  return run('docker', ['compose', 'ps', '-q', SERVICE], true).out.split(NL)[0] || ''
}

// 读容器健康状态：healthy / starting / unhealthy；无 healthcheck 时返回空串
function healthOf(containerId) {
  const inspectResult = run('docker', ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{end}}', containerId], true)
  return inspectResult.code === 0 ? inspectResult.out.trim() : ''
}

// 工作台 HTTP 探活：健康检查之外的二次确认，能响应 200 才算真的可用
function httpOk(url) {
  const probeScript = `fetch(${JSON.stringify(url)}).then(res=>process.exit(res.ok?0:1)).catch(()=>process.exit(1))`
  return run('node', ['-e', probeScript], true).code === 0
}

// 轮询等待健康；[WHY] compose healthcheck 有 90s start_period，首次启动 Xvfb + 服务就绪通常 30~90s
function waitHealthy(cid, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000
  let last = ''
  while (Date.now() < deadline) {
    const health = healthOf(cid) || 'no-healthcheck'
    if (health !== last) { say('[..]', `健康状态：${health}`); last = health }
    if (health === 'healthy') return true
    if (health === 'unhealthy') return false
    if (health === 'no-healthcheck' && httpOk(WORKBENCH_URL)) return true
    sleepSync(3000)
  }
  return false
}

// 失败时打印日志尾部，让人不必再手动敲 logs
function dumpLogs() {
  say('[!!]', '最近 30 行日志：')
  run('docker', ['compose', 'logs', '--tail', '30'])
}

// 打印入口与后续常用命令
function summary() {
  console.log(`${NL}部署完成${NL}`)
  say('    工作台', WORKBENCH_URL)
  say('    noVNC ', `${NOVNC_URL}   ← 有头登录窗口在这里操作`)
  say('    日志  ', 'pnpm docker:logs')
  say('    停止  ', 'pnpm docker:down')
  say('    重建  ', 'pnpm docker:deploy --build')
  say('    清理  ', 'pnpm docker:prune（回收悬空镜像与失效缓存，通常数 GB）')
  console.log(`${NL}提示：./ 已挂载为容器工作区 /workspace，改工作区里的脚本无需重建镜像。${NL}`)
}

const flags = parseArgs(process.argv.slice(2))

if (flags.help) {
  console.log('用法: pnpm docker:deploy [--build|--no-build|--down|--logs|--prune|--timeout=秒]')
  process.exit(0)
}

preflight()

if (flags.down) {
  say('[..]', '停止并删除容器（数据卷保留）...')
  const code = run('docker', ['compose', 'down']).code
  say(code === 0 ? '[ok]' : '[XX]', code === 0 ? '已停止' : '停止失败，详见上方输出')
  process.exit(code === 0 ? 0 : 1)
}

if (flags.logs) {
  run('docker', ['compose', 'logs', '-f', '--tail', '100'])
  process.exit(0)
}

// [prune-v1] 反复重建会累积「无 tag 的旧镜像 + 失效构建缓存」，实测可到 15GB。
// overlay2 层越多，后续构建的层查找与磁盘 I/O 越慢，所以定期清理本身也是一种提速。
// [CONSTRAINT] 只删 dangling 镜像（无 tag、无容器引用）与「未使用」的构建缓存，
// 不碰 qgm/ai-runner:local 及任何在用镜像；正在构建时执行会中断构建，请避开。
if (flags.prune) {
  say('[..]', '当前磁盘占用：')
  console.log(run('docker', ['system', 'df'], true).out)
  say('[..]', '清理悬空镜像与未使用的构建缓存...')
  run('docker', ['image', 'prune', '-f'])
  run('docker', ['builder', 'prune', '-f'])
  say('[ok]', '清理完成，当前占用：')
  console.log(run('docker', ['system', 'df'], true).out)
  process.exit(0)
}

if (flags.build || (!flags.noBuild && !imageExists())) buildImage()
else say('[ok]', `镜像已存在，跳过构建（强制重建用 --build）：${IMAGE}`)

composeUp()
const cid = containerId()
if (!cid) {
  say('[XX]', '容器未创建成功，请检查 compose.yaml 与上方输出。')
  process.exit(1)
}

say('[..]', `等待服务健康（上限 ${flags.timeout}s）...`)
if (!waitHealthy(cid, flags.timeout)) {
  say('[XX]', '等待健康超时，服务可能未就绪。')
  dumpLogs()
  say('[!!]', '排查建议：先 pnpm docker:logs 看启动日志；僵尸/残留锁问题用 docker compose restart 复位。')
  process.exit(1)
}

say('[ok]', '服务健康')
summary()
