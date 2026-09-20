---
name: env-troubleshooting
description: 环境与工具链踩坑库（cwd/dev server/overlay/bash-guard）
keywords: 踩坑, 故障, 排错, cwd, dev server, overlay, bash-guard, worktree, timeout
---

# 环境自检与踩坑库

## 会话首条自检清单

- [ ] `pwd` 正确，非空目录
- [ ] `git rev-parse --abbrev-ref HEAD` 分支正确
- [ ] `ls src/` 有文件，`node_modules` 存在
- [ ] `git worktree list` 无孤儿
- [ ] `curl -s -o /dev/null -w "%{http_code}" http://localhost:5174/__ai/` 返回 200

## 提交前闸门

- [ ] `node --check` 所有改动的 `.cjs`
- [ ] `pnpm tsc` 通过（用 `if ! pnpm tsc; then exit 1; fi`，不用 `&&`）
- [ ] `git status` 无 `.ai-runner/` 运行态文件

## 踩坑索引

### 环境类

| ID  | 现象                         | 根因                             | 规避                                                  |
| :-- | :--------------------------- | :------------------------------- | :---------------------------------------------------- |
| E1  | 脚本 exit 1/127，找不到 src/ | cwd 指向空目录 / worktree 未关联 | 会话首条跑自检；脚本加 cwd 闸                         |
| E2  | Failed to fetch，面板脚本挂  | dev server 未启动或崩溃          | 改动前 curl 检查；一个 worktree 只保留一个 dev server |
| E3  | 脚本误改到 master            | worktree ≠ 分支名                | worktree 命名严格等于分支名；脚本头部加分支闸         |

### 工具链类

| ID  | 现象                          | 根因                             | 规避                                          |
| :-- | :---------------------------- | :------------------------------- | :-------------------------------------------- |
| T1  | overlay 沙盒崩溃丢改动        | js 通道写内存，非零退出全丢弃    | 关键改动走 bash；js 写后回读验证              |
| T4  | bash-guard 黑名单误伤注释     | 注释含黑名单字面量               | 拆字母拼字符串或改写成动作描述                |
| T5  | macOS 无 GNU timeout          | 系统差异                         | 用 playwright/node 内置 timeout 或 perl alarm |
| T6  | ERR_MODULE_NOT_FOUND .js      | strip-types 不改 import 路径     | 生产入口走 pnpm build → dist/*.js             |
| T7  | readdirSync withFileTypes bug | overlay patch 把 Dirent 当字符串 | 改用 safeReaddir                              |
| T9  | Vue v-if/v-else 相邻性破坏    | 中间插入新元素                   | 插按钮看清相邻结构；或用独立 v-if             |

### 流程类

| ID  | 现象                    | 规避                                            |
| :-- | :---------------------- | :---------------------------------------------- |
| P1  | tsc 失败但脚本仍 commit | 验证步骤用 `if ! cmd; then exit 1; fi`          |
| P2  | merge 带进运行态文件    | .gitignore 覆盖 .ai-runner/；merge 前 diff 检查 |
| P4  | 长脚本被截断            | 单脚本 ≤200 行；复杂改动先探针再改              |

### AI 协作类

| ID  | 现象                   | 规避                                         |
| :-- | :--------------------- | :------------------------------------------- |
| A1  | 源码被压缩，行号不可信 | 精确改动前单独贴原文代码块；一次 ≤3 文件     |
| A2  | 盲改报「未找到锚点」   | 每个改动脚本先 grep 探针；锚点不存在则 abort |
| A3  | 大重构出错无法定位     | 单脚本单目标；每步 commit 独立可回滚         |
