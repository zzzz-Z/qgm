// @desc 根 vite.config.ts —— 兼容转发层，实际配置在 client/vite.config.ts。
// @why 保留根入口兼容现有工具（build-all.mjs、旧脚本）。配置单一来源在 client 目录。
//      未来 server 侧独立 vite 启动后，本文件仅服务于「web 端 dev/build」链路。
export { default } from './packages/client/vite.config.js'
