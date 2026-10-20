# 油猴脚本 TS 重写 · 拼接顺序

> [tampermonkey-ts-rewrite-v1] 本目录是 `scripts/tampermonkey-session-id.user.js` 的 TS 重写版，
> 按职责切成 21 段。**当前尚未替换产物**，原 .js 片段仍在 `packages/core/src/tampermonkey/*.js`。

## 为什么需要顺序

所有片段拼回后是同**一个 IIFE 作用域**：函数声明会提升，但 `const`/`let` 与已执行的初始化语句不会。
顺序错了的症状是「首发上报拿到空 ID」这类静默错误——不报错，但行为不对。

## 顺序

1. `types.ts` —— 共享类型（纯 interface/type，无运行时代码）
2. `hash.ts` —— hash32 指纹
3. `language.ts` —— 语言判定四级回退 + 行号剔除
4. `markdown.ts` —— DOM→Markdown 反推
5. `roots.ts` —— AI 回复容器定位与身份指纹
6. `session.ts` —— 会话 ID 提取与上报
7. `limits.ts` —— 正文剥壳扫描与触顶探针
8. `state.ts` —— 模块级状态 + resetRoundState
9. `stop.ts` —— 生成中判定（三条判据互相隔离）
10. `detect.ts` —— 正文签名 / 最新回复文本
11. `turn-emit.ts` —— turn 信封 → 块帧 / 结束帧（[legacy-marks-removed-v1] 脚本下发的唯一路径）
12. `dispatch.ts` —— 分类分发主流程
13. `observer.ts` —— 回复观察器与空转唤醒
14. `fill.ts` —— 输入框注入与发送复核
15. `actions.ts` —— 停止生成 / 开新会话
16. `listener.ts` —— 入站指令处理
17. `channel.ts` —— 消息通道（外发缓冲 + 断链队列 + 回执）
18. `bootstrap.ts` —— 启动序列（必须最后：直接调用 send()）

> [legacy-marks-removed-v1] 已删段：`marks.ts`（首行 SCRIPT/ASK/DONE/HANDOFF/TEXT 扫描）、
> `emit.ts`（旧 script / plain 回传）、`script-extract.ts`（按围栏猜脚本）、`fence.ts`（围栏契约兜底）。
> 契约 §1 只允许 ```json 围栏包住的 turn 信封，围栏外零字符，裸文本一律整轮丢弃。

## 拼回前置条件

TS 片段含类型注解与 `interface`，**不能直接拼接成 .js**。落地需要先剥离类型：
`tsc --target es2022 --module none`（保持 script 语义，不产出 import/export）或等价的单文件转译。

## 每段开头的 `// @ts-nocheck`

片段引用其它片段定义的符号，单文件检查下不可见，且存在顶层 `return` 等非模块语法。
全部片段按拼回后的联合视图接线后应统一移除。

## 命名对照（与原 .js 的差异）

原 .js 有两个 MutationObserver，都叫得很泛（`observer` / `replyObserver`）。TS 版按职责重命名，避免读者混淆两者：

- 原 `observer`（会话身份通道，URL/DOM 变化时上报 session-id）→ `sessionObserver`（在 `bootstrap.ts`）
- 原 `replyObserver`（回复回传通道）→ 保持 `replyObserver`（在 `observer.ts`）

其余符号名与原 .js 一致，便于逐行对照。
