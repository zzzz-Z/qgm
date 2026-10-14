/**
 * 沙箱脚本执行的全局超时（秒级常量集中在此，避免多处魔数漂移）。
 * [WHY] 该值同时被 routes/run.ts（发起执行）与 post-run/run-script.ts（执行器默认值）消费，
 *   两处各写一份 180_000 时，调整其一另一处静默失配（前例：60s 放宽到 180s 时只改了一处）。
 * [CONSTRAINT] 该值是 /run 单轮脚本的硬上限：超过即 SIGTERM→SIGKILL，脚本被强制终止；
 *   需要更长执行时间的任务必须走 __AI__.shell(cmd, { background: true }) 起 detached 子进程，
 *   由跨轮 shellStatus / readShell 轮询收口 —— 后台子进程不受本常量约束。
 * [CHANGE-IMPACT] 改动会同时影响服务端超时行为与前端 useAiWaiting 的看门狗（两者语义不同，
 *   前者限脚本执行、后者防 AI 回复丢失导致 waiting 永久为 true，不要混同）。
 */
export const SCRIPT_TIMEOUT_MS = 180_000

/** [run-timeout-visible-v1] 超时 stderr 的教学后缀：告诉 AI 是超时而非失败，并给出绕行手段。 */
export const SCRIPT_TIMEOUT_HINT
  = '[sandbox-timeout] 脚本被沙箱超时终止（非脚本自身失败）。若任务本身耗时较长（如全量测试/构建），'
    + '请改用 __AI__.shell(cmd, { background: true }) 起后台子进程，跨轮用 shellStatus/readShell 轮询收口。'
