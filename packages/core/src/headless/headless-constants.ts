// [headless-constants-v1] 无头浏览器会话池的默认常量。
// [WHY] ai-headless.ts 略超 §4 模块 400 行；默认值独立后主文件可减约 22 行。
// [CHANGE-IMPACT] ai-headless.ts 通过 import 消费；DEFAULT_* 值语义不变。

import path from 'node:path'
import { ROOT } from '../config.js'

/** DeepSeek 默认会话地址（可被环境变量覆盖） */
export const DEFAULT_URL = 'https://chat.deepseek.com/'

/**
 * 无头浏览器默认 profile 目录。
 * [profile-global-v1] 与 ROOT 解耦：登录态是**账号级资产**，不该随工作区目录变化。
 *   原实现 `path.join(ROOT, '.ai-runner', 'headless-profile')` 导致：
 *   切工作区后 profile 路径变化 → 在新目录里未登录 → 表现为「登录了但还是找不到输入框」。
 *   改为用户级固定目录（~/.ai-runner/headless-profile），所有工作区共用一份登录态。
 * [CONSTRAINT] 迁移：旧路径下的 profile 不会自动搬走，首次使用需重新登录一次。
 */
export function defaultUserDataDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (!home) return path.join(ROOT, '.ai-runner', 'headless-profile')
  return path.join(home, '.ai-runner', 'headless-profile')
}

/** 浏览器启动超时（毫秒），超时抛错 */
export const LAUNCH_TIMEOUT_MS = 30_000
/** 登录稳定期（毫秒） */
// [login-close-fast-v1] 原 10s 稳定窗让用户关窗后要干等十几秒。
//   探针已要求 tokenState==='yes' + 有输入框 + 非登录页三重正面证据，2s 足够过滤页面跳转抖动。
export const LOGIN_STABLE_MS = 2_000
// [login-autoclose-timeout-v1] 时间兜底：探针识别不出新存储格式（tokenState=unknown）时，
//   有头窗口若已打开超过此值且页面有输入框 + 非 /sign_in 即视为用户已登录，主动关窗释放 profile。
//   [WHY] 用户实际场景：DeepSeek 已登录但探测读不到 userToken，autoclose 判据不满足 → 窗口久开 → inflight 永久挂起。
export const LOGIN_AUTOCLOSE_FALLBACK_MS = 90_000
// [login-gui-max-ms-v1] doOpenLoginGui 等待 ctx.close 事件的硬上限：超过此时长强制 close，
//   避免用户只关了浏览器窗口而 Playwright 仍认为 context 存在（close 事件未触发）导致永久阻塞。
export const LOGIN_GUI_MAX_MS = 300_000

/** 无头会话池的并发上限 */
export const DEFAULT_POOL_LIMIT = 5
/** 池满时排队等待上限（毫秒），超时抛错 */
export const DEFAULT_QUEUE_TIMEOUT_MS = 60_000
/**
 * 请求间隔抖动下限（毫秒）——模拟真人操作节奏，规避限流。
 * [jitter-budget-v1] 2026-10-18：3500/6000 → 600/1200。原值让**每一轮**多付 3.5–6.0s 固定等待，
 *   实测（headless.jsonl n=109 同口径轮间 + send.jsonl n=29 油猴对照）：
 *     无头轮间 p50 14.74s / p90 57.62s，油猴 p50 7.04s / p90 8.20s ⇒ 差额 7.7s 里 4.75s 是纯 jitter。
 *   `EXECUTE` 阶段两通道同为 0.14–0.26s、run 管道 1.64–2.03s ⇒ 脚本本身没变慢，慢的全是调度。
 * [WHY 600–1200] 油猴 `doSend` 是 300ms + 400ms = 700ms 才出回执，本区间与其同量级，更接近真人
 *   （真人打字 + 点发送约 1–2s）。原 3.5–6.0s 不产生任何正确性收益，只把钱花在等待上。
 * [CONSTRAINT] 自适应保留：ai-headless.ts 的 `rateLimitedRatio() > 0.1 ? 2 : 1` 不动，
 *   有频控迹象时自动回到 1200–2400ms。下调后该自适应的绝对放大值比原来小 5.8 倍，
 *   且 rateWindow（最近 100 次 fill）覆盖时长由 ~24.5min 缩到 ~12.5min ⇒ 单次 429 的污染期同时减半。
 *   两个维度都是减轻，故无需为「跨 sid 共享单例」这条既有缺陷额外加码。
 */
export const DEFAULT_JITTER_MIN_MS = 600
/** 请求间隔抖动上限（毫秒，不含），与下限配合 */
export const DEFAULT_JITTER_MAX_MS = 1200
