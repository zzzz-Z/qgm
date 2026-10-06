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
  ],
}
