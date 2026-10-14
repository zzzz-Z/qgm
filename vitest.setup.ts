// [test-root-align-v1] 测试环境 root 对齐守卫。
// WHY: 宿主 ai-runner 进程的 AI_RUNNER_ROOT 会被 /workspace/activate 写成任意注册工作区的 root
//   （多工作区特性引入的全局状态）；vitest 从 pnpm 起，继承了父进程的 env ⇒ 所有走
//   resolveScopedRoot() 的模块（error-fingerprint / post-run/error-files / overlay / tsc-targets 等）
//   会在 vitest 进程里读到「不是本仓库」的 root，导致 fs.existsSync(abs) 恒假、返回空数组。
//   这在生产环境是**正确**行为（root 就该是活跃工作区）；出问题的是**测试跑在仓库根，但 root 未显式声明**。
// CONSTRAINT: 只在无 AI_RUNNER_SCOPE 标记时覆盖（避免将来某个测试故意设置 root 被冲掉）。
//   测试若需自定义 root，自行在用例里设置即可（本文件是进程级，不干扰 per-test 修改）。
// CHANGE-IMPACT: 影响所有 packages/**/*.node-test.ts 的 root 解析；新增依赖 AI_RUNNER_ROOT 的测试不再需要各自声明。
if (!process.env.AI_RUNNER_TEST_ROOT_LOCKED) {
  process.env.AI_RUNNER_ROOT = process.cwd()
  process.env.AI_RUNNER_TEST_ROOT_LOCKED = '1'
}
