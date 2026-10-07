// [pm2-ecosystem-v1] AI Runner 服务托管配置
// [WHY] 沙箱内 kill 承载会话的服务会自断执行通道；pm2 托管后 restart 不依赖被重启进程
// [CONSTRAINT] interpreter 固定 node；cwd=仓库根保证 ROOT 解析正确
module.exports = {
  apps: [
    {
      name: 'ai-runner',
      script: 'apps/standalone/bin/air-server.cjs',
      cwd: __dirname,
      interpreter: 'node',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      env: {
        AIR_SERVER_PORT: '5175',
      },
    },
    {
      // [serve-userscript-pm2-v1] 油猴脚本分发端点（5178），独立进程常驻：
      //   [WHY] 该端点原放 .ai-runner/tmp 且需手动 `node` 启动 → 被 gcLogs 回收 / 跨会话不存活，
      //     用户点「安装/更新油猴脚本」时端点已死（工作台 toast「分发端点未启动」）。
      //   [CONSTRAINT] 与 userscript.ts 的 SERVE_PORT=5178 一致；改端口两处同步。
      name: 'ai-runner-userscript',
      script: 'scripts/serve-userscript.mjs',
      cwd: __dirname,
      interpreter: 'node',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
  ],
}
