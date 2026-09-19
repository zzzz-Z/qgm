## 环境自检（会话首条）
- [ ] pwd 正确，非空目录
- [ ] git rev-parse --abbrev-ref HEAD 分支正确
- [ ] ls src/ 有文件，node_modules 存在
- [ ] git worktree list 无孤儿

## 提交前闸门
- [ ] node --check 所有改动的 .cjs
- [ ] pnpm tsc 通过
- [ ] git status 无 .ai-runner/ 运行态文件

## 脚本编写
- [ ] 注释/字符串避开 bash-guard 黑名单字面量
- [ ] 改动幂等 + 有 --rollback
- [ ] 关键结果 assert 自检

## 与 AI 协作
- [ ] 精确改动的文件贴原文，不用压缩包
- [ ] 一次 ≤3 个文件
- [ ] 报错先贴 pwd/ls，再贴 stderr