---
name: skill-discovery
description: 当需要为项目寻找、筛选或安装外部 SKILL.md 时使用。定义「本地优先」的获取阶梯、技术栈检索协议、候选分级与合规落盘流程，避免重复安装与一次性补搜
keywords: 技能 安装 检索 skill install 本地优先
---

## 为什么存在

两段历史失败，都要防：

1. **检索面太窄**：首轮只用「agent skills」等通用词检索，结果全是语言无关的方法论技能，
   漏掉 Vue / TypeScript / Vite 等本项目真实技术栈的专用技能。
2. **顺序错了**（2026-10-04 实测）：把「查本地」交给一张**手工维护**的 `.registry.json`，
   而它与磁盘静默漂移（磁盘 15 个技能 / 表 14 条，缺 pnpm）→ 查表得**假阴性**「没装」→
   重复联网、在 /run 沙箱手搓 curl 拉 21 个文件 → 必撞 60s 硬超时（实测 66.2s / exit -1）→
   文件其实已写完，但只看 exit code 判定失败 → 下轮再装一遍。**自增强死循环。**

本技能据此固定两件事：**获取顺序本地优先且不可跳层**，**判成功只认端点自检**。

## 获取阶梯（不可跳层）

### 第 0 步：刷新本地视图（必做，先于任何网络请求）

- `GET /__ai/skills` —— 已装清单，**磁盘为准**，同时把 `.registry.json` 收敛到磁盘；
- `POST /__ai/skills/match`，body `{ "query": "<任务描述>" }` —— 按任务检索，返回命中技能与正文。

命中即直接用（读该 SKILL.md 全文 → `__AI__.loadSkill(<全文>)`）。**命中就不要联网。**
注意：`.registry.json` 只是来源标注，**不要**用它判断「装没装」。

### 第 1 步：刷新技术栈快照（仅在准备联网发现时）

技术栈会随依赖漂移，检索前重新读取，禁止凭记忆。合并根与各包 package.json 的
dependencies 与 devDependencies，去重后按语义归类：

- 框架运行时：vue、@vueuse/core、@floating-ui/vue
- 语言与类型：typescript、vue-tsc、typescript-eslint、@types/*
- 构建与测试：vite、vitest、@vitest/coverage-v8、@playwright/test
- 样式：unocss、sass-embedded
- 后端与协议：hono、@hono/node-server、ws
- 静态检查：eslint、eslint-plugin-vue、eslint-vue-setup-rules、@antfu/eslint-config
- 工具链陷阱源：unplugin-auto-import

### 第 2 步：栈专属 query（先于通用 query）

每个高权重依赖至少一条，形如 `<dep> SKILL.md`：

vue SKILL.md / vue3 composition api SKILL.md / typescript strict mode SKILL.md / vue-tsc SKILL.md /
vite plugin SKILL.md / vitest SKILL.md / unocss SKILL.md / playwright SKILL.md

### 第 3 步：通用方法论 query（补足，不替代第 2 步）

systematic-debugging、code-review、planning 等语言无关技能。价值在流程约束，不解决栈特异问题。

### 第 4 步：合并去重与分级

- P0 栈专属：query 命中具体依赖名，且正文含该依赖的 API / 配置示例
- P1 栈相邻：同生态（前端通用 / Node 通用），可迁移
- P2 通用方法论：语言无关，仅作流程约束补充

输出必须 P0 在前。P0 为空需显式说明「本轮未命中栈专属技能」并给出换仓库方案，禁止用 P2 冒充 P0。

## 安装：一律走端点，不要在沙箱里下载

```json
POST /__ai/skills/install
{ "source": "antfu/skills", "skill": "pnpm", "path": "skills/pnpm", "ref": "HEAD" }
```

- **顺序由服务端强制**：① 本地已装（0 网络）② 本地库 `.ai-runner/skills/.store/`（0 网络）
  ③ 联网下载。前两层命中时返回体 `network` 恒为 0，没有「跳过本地直接联网」的余地。
- 返回体判读：`ok` / `status`（`already-installed` / `from-store` / `downloaded` / `failed`）/
  `network` / `files` / `error`。**先看 status，不要靠 HTTP 码或 exit code 猜。**
- `force: true` 忽略「已装」重装（仍可用本地库）；`refresh: true` 强制重新下载。
- **禁止**在 `/run` 沙箱里 curl/fetch 批量拉文件：沙箱 60s 硬超时，`__AI__.shell` 又是同步阻塞，
  大批量下载必被 SIGTERM/SIGKILL 腰斩。

## 判成功（缺一不可）

- `GET /__ai/skills` 能列出该技能，且 `POST /__ai/skills/match` 能命中它；
- **不要用 exit code / 变更数判成败**：`.ai-runner` 被 git 忽略（changeCount 恒为 0），
  且超时被杀时文件可能已写完（`/run` summary 的 `timedOut: true` 说的是「超时」，不是「没成功」）；
- 输出 pass / fail 计数，fail 非零即中止。

## 落盘流程（端点不可用时的兜底）

1. 抓取原文，校验 frontmatter 存在且可解析（name + description 必需）；
2. name 必须 kebab-case 且全局唯一，冲突按来源重命名（两个 test-driven-development，
   后者改 tdd-red-green-refactor），并在此登记消歧规则；
3. description 裁剪到 20-200 字符，保留触发场景关键词；
4. 目标路径 `.ai-runner/skills/<name>/SKILL.md`，原子写入；
5. 在技能目录留 `SOURCE.md`（写一行 `来源: owner/repo`），供 registry 收敛与追溯。

## 存量登记（避免重复安装与重名）

- 已装清单以 `.ai-runner/skills/` 为唯一事实来源，安装前先列目录比对（用 `GET /__ai/skills`）。
- 已知消歧：test-driven-development 归 obra/superpowers，tdd-red-green-refactor 归 addyosmani。

## 网络通道（实测更正）

- **`curl` 与 `fetch` 都可用**。本节旧文称「本环境 gh 与 curl 均不可用，唯一远端通道是 fetch」，
  已被实测推翻：2026-10-04 那次安装正是 curl 成功拉下了 21 个文件。
- 但**可用 ≠ 该用**：沙箱里批量下载会撞 60s 超时。批量获取一律用 `POST /__ai/skills/install`。
- 匿名配额：GitHub 搜索 10/h、核心 60/h。第 0 步的本地优先正是省配额的主要手段。
