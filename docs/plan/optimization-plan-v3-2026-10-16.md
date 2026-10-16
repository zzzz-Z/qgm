# 优化计划 v3（战略重排版）

- **生成时间**：2026-10-16T04:29:32.604Z
- **相对 v2 的战略调整**：① **无头链路从「补测试」升级为「战略关键路径」**；② **i18n 项删除**（不出海）；③ **M5（e2e 进 CI）优先级提升**（无头的端到端测试在 e2e 里）
- **v1**：`optimization-plan-2026-10-16.md`（初版）；**v2**：`optimization-plan-v2-2026-10-16.md`（复检修正版）；本版为战略重排

---

## 一、战略调整

用户明确回答两点，直接改变优先级排序：

| 输入                                                 | 原判断                                                            | 调整后                                                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **无头是战略方向**（当前油猴主力，正在推进无头转正） | headless 是「两个链路之一」，补测 3.5 人日（只覆盖 145 行调度层） | headless 是**战略关键路径**，需覆盖**全链路**；effort 从 3.5 升到 **约 10.5 人日** |
| **不出海**                                           | M12（i18n 词条抽取）放长尾                                        | **整项删除**，释放 5 人日                                                          |

**一句话**：v2 把 headless 当「一个待补测模块」，v3 把 headless 当「产品转型的主战场」——后者的测试深度要求完全不同。

---

## 二、无头链路全景复检

### 2.1 全量规模（实测 `wc -l`）

| 文件                         |     行数 |      测试文件引用数 | 判断                                   |
| ---------------------------- | -------: | ------------------: | -------------------------------------- |
| `headless-inject.ts`         |      696 |                  13 | 覆盖较足（DOM 逻辑，守卫测试多）       |
| `ai-headless.ts`             |      497 | **2（均为浅引用）** | **主流程无真跑测试**                   |
| `headless-inject-simple.ts`  |      328 |                   5 | 有覆盖                                 |
| `discover-targets.ts`        |      224 |                   1 | 有覆盖                                 |
| `smoke.ts`                   |      104 |                   2 | 有覆盖                                 |
| `headless-scheduler.ts`      |       77 |               **0** | 4 个纯函数，逻辑清晰，**易补且价值高** |
| `headless-types.ts`          |       67 |                   0 | 纯类型，**无需测试**                   |
| `site-adapters/**`（4 文件） |      177 |               **0** | **v1 新增抽象层，站点适配核心**        |
| `headless-slot-queue.ts`     |       45 |               **0** | 并发槽位队列，有超时/顺序逻辑          |
| `headless-constants.ts`      |       38 |               **0** | 常量                                   |
| `browser-engine.ts`          |       23 |               **0** | 惰性加载 + 失败降级                    |
| **合计**                     | **2276** |                     |                                        |

### 2.2 关键发现

**发现 1：`ai-headless.ts`（497 行）的「2 处引用」是假覆盖**。

实测两处引用的真实性质：

- `fill-verify-guard.node-test.ts:16` — 只是 `const AI_HEADLESS = 'packages/core/src/headless/ai-headless.ts'` **路径常量**，用于断言源码文本匹配（静态字符串检查）
- `headless-completion-error.node-test.ts:2` — 只 `import { parseDeepSeekCompletionError }`，而该函数已移到 `headless-scheduler.ts`，ai-headless 只是 re-export

⇒ **ai-headless.ts 的主流程（会话池管理、回复轮询、登录引导、prompt 注入编排）完全无动态测试**。这是无头链路的心脏。

**发现 2：`site-adapters/` 是 v1 新增抽象层，177 行，零测试**。

它是站点适配的核心接口（`SiteAdapter` 类型 + `deepseek` + `chatglm` + 工厂 `getAdapter`）。`deepseek.ts` 的注释明确写着「从原硬编码点提取（grep 定位 28 处）」「行为必须与原实现逐字符对齐」。

当前有 3 个守卫测试（`limit-marker-guard` / `rate-marker-guard` / `fill-verify-guard`）保护「提取前后行为一致」——但**提取出的新抽象层自身**（工厂函数、环境变量覆盖 `AI_SITE_ADAPTER`、回退逻辑）**无测试**。

⇒ 这是**新代码 + 战略方向 + 零覆盖**的组合，是本次复检中风险最高的单点。

**发现 3：`headless-scheduler.ts` 里藏着 4 个高价值纯函数**。

- `withBackoff(fn, maxRetry)` — 指数退避 + 冷却序列 `COOLDOWN_WAITS = [15s, 30s, 60s, 90s, 120s]`
- `jitterDelay(min, max)` — 模拟真人的随机抖动
- `recordRequest` / `rateLimitedRatio` — 429 比例滑动窗口（>10% 降频）
- `parseDeepSeekCompletionError` — SSE 解析（**已有测试**）

这些函数**逻辑清晰、无副作用、易测**，且直接决定无头链路在限流下的韧性。补测成本低、收益高。

**发现 4：`M5`（e2e 进 CI）的价值被 v2 低估**。

e2e 目录里有 `headless-ws.spec.ts` —— 这是**无头链路的端到端测试**。它不进 CI，意味着战略方向的主 e2e 不在门禁里。v2 把它排在第 3 迭代（P2），v3 提升到第 1 迭代（P1）。

---

## 三、排除项（更新）

| 原 ID      | 内容                               | 排除理由                         |
| ---------- | ---------------------------------- | -------------------------------- |
| 原 M2 / M3 | video 编排器 + provider + 面板补测 | 实验性功能（v2 已排除）          |
| **原 M12** | **i18n 词条抽取**                  | **不出海（本版新增排除）**       |
| 原 S3      | video 定位决策                     | 已答：实验性                     |
| **原 S4**  | **是否出海**                       | **已答：不出海（本版新增排除）** |

剩余 **S2** 已由用户回答（无头是战略方向），无待决项。

---

## 四、headless 补测的分层设计

不追求一次全覆盖（2276 行不现实），按「战略价值 × 可测性」分三层：

**Layer 1：纯逻辑（低成本，高价值）— 3 人日**

- `headless-scheduler.ts`（77 行）：4 个纯函数，逐个断言边界
- `headless-slot-queue.ts`（45 行）：并发/超时/release 顺序
- `browser-engine.ts`（23 行）：惰性加载 + 缓存 null + 失败降级
- `headless-constants.ts`（38 行）：关键常量值与契约

**Layer 2：抽象层（新增代码，战略接口）— 3 人日**

- `site-adapters/types.ts`：接口契约（纯数据约束、序列化安全）
- `site-adapters/index.ts`：工厂函数（`getAdapter` / `getDefaultAdapter` / `AI_SITE_ADAPTER` 覆盖 / 回退）
- `site-adapters/deepseek.ts` + `chatglm.ts`：适配器字段完整性（选择器非空、正则可编译）

**Layer 3：主流程（高成本，需 mock）— 4.5 人日**

- `ai-headless.ts` 的**关键路径**（不做全量）：
  - 会话池 acquire/release 与槽位队列的协作
  - 429 退避触发链（`withBackoff` 与 `recordRequest` 的接线）
  - 登录态检测与 profile 落盘路径
  - **不做**：真实浏览器交互（那属 e2e，由 `headless-ws.spec.ts` 覆盖）

**Layer 3 的边界说明**：`ai-headless.ts` 大量逻辑依赖真实 Playwright 上下文，单测只能覆盖到「编排层」——真正的浏览器行为必须靠 e2e。所以 Layer 3 的目标是**把可单测的编排逻辑抽出来测**，而不是硬 mock 浏览器。

---

## 五、迭代路线（战略重排）

**前提**：1 人团队、7 人日/迭代。**无头是战略方向，其补测分布在第 2-3 迭代。**

### 第 0 迭代（0.5 人日）— 清障

| 项  | 动作                                 | 位置                    | effort |
| --- | ------------------------------------ | ----------------------- | -----: |
| M14 | 复核 15 条 lesson（标状态 + 附证据） | `.ai-runner/lessons.md` |    0.3 |
| M13 | 改 README 测试文件数为 120 / 82      | `README.md`             |    0.2 |

### 第 1 迭代（5 人日）— 度量、安全、无头 e2e 门禁

| 项     | 动作                                                  | 位置                                                | effort |
| ------ | ----------------------------------------------------- | --------------------------------------------------- | -----: |
| M4a    | CI 接入覆盖率上报（不设阈值）                         | `.github/workflows/ci.yml`                          |      1 |
| M6     | Dependabot（**不用 pnpm audit**，镜像不支持）         | 新建 `.github/dependabot.yml`                       |      1 |
| M6b    | eslint 安全规则（`no-eval` 等）                       | `eslint.config.ts`                                  |    0.5 |
| **M5** | **e2e 非视觉 spec 进 CI（含 `headless-ws.spec.ts`）** | `.github/workflows/ci.yml` + `playwright.config.ts` |    2.5 |

**M5 的战略意义**：`headless-ws.spec.ts` 是无头链路的端到端测试。它进 CI = 无头链路从此有了提交级门禁。**这是「推进无头为主力」的第一道保险**。

### 第 2 迭代（6 人日）— headless Layer 1 + 数据工厂

| 项  | 动作                                                             | 位置                                                        | effort |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------- | -----: |
| M1a | `headless-scheduler` 4 个纯函数断言（含 `withBackoff` 冷却序列） | 新建 `packages/core/tests/headless-scheduler.node-test.ts`  |    1.5 |
| M1b | `headless-slot-queue` 并发/超时/release 顺序                     | 新建 `packages/core/tests/headless-slot-queue.node-test.ts` |      1 |
| M1c | `browser-engine` 惰性加载 + 失败降级                             | 新建 `packages/core/tests/browser-engine.node-test.ts`      |    0.5 |
| M1d | `headless-constants` 契约值                                      | 并入 M1a 文件                                               |    0.5 |
| M7a | 测试数据工厂 v1（覆盖 headless 域）                              | 扩充 `packages/core/tests/fixtures/`                        |    2.5 |

### 第 3 迭代（7 人日）— headless Layer 2 + Layer 3

| 项  | 动作                                                                 | 位置                                                              | effort |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------- | -----: |
| M1e | **`site-adapters` 全量测试**：类型契约 + 工厂 + 2 个适配器字段完整性 | 新建 `packages/core/tests/site-adapters.node-test.ts`             |      3 |
| M1f | **`ai-headless` 编排层测试**：池/队列协作、429 链、登录 profile 路径 | 新建 `packages/core/tests/ai-headless-orchestration.node-test.ts` |      4 |

**M1e 的关键断言**：`getAdapter()` 在 `AI_SITE_ADAPTER` 无效值时回退 default；每个适配器的选择器字段非空、正则可 `new RegExp()` 编译；`SiteAdapter` 的字段都是可序列化的纯数据（不能是闭包/RegExp 实例）。最后一条直接对应 `types.ts` 头注释里的约束。

### 第 4 迭代（5 人日）— 门禁收紧与外围

| 项  | 动作                                                    | 位置                                                   | effort |
| --- | ------------------------------------------------------- | ------------------------------------------------------ | -----: |
| M4b | 覆盖率门禁 v2（基于 3 周数据；**headless 域单独设线**） | `vitest.config.ts`                                     |    1.5 |
| M8  | WorklogPane 交互补测                                    | 新建 `packages/client/tests/worklog-pane.node-test.ts` |      2 |
| M9  | 3 个零引用脚本冒烟                                      | 新建 `packages/core/tests/scripts-smoke.node-test.ts`  |    1.5 |

**M4b 的战略调整**：`headless/**` 在 v2 里没有单独阈值，v3 应为它单设一条线（因为它现在是战略关键路径）。

### 第 5 迭代（5 人日）— 收尾

| 项  | 动作                             | 位置                                                        | effort |
| --- | -------------------------------- | ----------------------------------------------------------- | -----: |
| M7b | 测试数据工厂 v2（推广到 client） | 新建 `packages/client/tests/fixtures/`                      |      3 |
| M10 | 性能基线趋势                     | 扩充 `perf.node-test.ts` + 新建 `scripts/perf-baseline.cjs` |      2 |

### 长尾（按需）

| 项  | 动作                        | effort | 触发条件   |
| --- | --------------------------- | -----: | ---------- |
| M11 | 版本管理（tag + CHANGELOG） |      2 | 对外分发前 |

> **原 M12（i18n）已删除** —— 不出海。

---

## 六、汇总与带宽

| 迭代 | 内容                              | effort | 累计 |
| ---- | --------------------------------- | -----: | ---: |
| 0    | M14 + M13                         |    0.5 |  0.5 |
| 1    | M4a + M6 + M6b + M5               |      5 |  5.5 |
| 2    | headless Layer 1（M1a-d）+ M7a    |      6 | 11.5 |
| 3    | headless Layer 2 + 3（M1e + M1f） |      7 | 18.5 |
| 4    | M4b + M8 + M9                     |      5 | 23.5 |
| 5    | M7b + M10                         |      5 | 28.5 |
| 长尾 | M11                               |      2 | 30.5 |

**主路径**（不含长尾）：**28.5 人日 ≈ 4.1 迭代**。

对比：v2 主路径 22.5 人日 → v3 **28.5 人日**。增量 **+6 人日**全部来自 headless 从「补 145 行调度层」升级为「全链路三层补测」（10.5 人日 vs 原 3.5）；同时删掉 i18n（-5）与调整 M5 优先级（不变）。

**headless 占比**：10.5 / 28.5 = **37%** 的工程量投在战略方向——与「无头转主力」的定位匹配。

---

## 七、关键约束与风险

| 约束 / 风险             | 说明                                                  | 应对                                                                                                |
| ----------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **ai-headless.ts 难测** | 497 行大量依赖真实 Playwright 上下文                  | Layer 3 只测「可抽出的编排层」，浏览器行为交给 `headless-ws.spec.ts`（e2e）；**不要硬 mock 浏览器** |
| **M5 前置未验证**       | `playwright.config.ts` 的 webServer 历史上出过 cwd 坑 | 写 CI 前本地先跑 `pnpm test:e2e --grep-invert visual` 确认能起                                      |
| **M6 镜像限制**         | npmmirror 无 audit 端点                               | 用 Dependabot；**不要**写 `pnpm audit` 进 CI                                                        |
| **M14 ratchet 语义**    | 阈值只允许收紧或持平                                  | 只复核不加阈值；15 条 → 40.9%                                                                       |
| **单点带宽**            | 1 人团队                                              | 每迭代 ≤ 3 项；超载顺延                                                                             |
| **headless 战略不确定** | 「正在尝试推进」尚未完成                              | 第 1 迭代先把 e2e 门禁立起来（M5），它同时保护两条链路；即使无头推进失败也不浪费                    |

---

## 八、验收标准

**第 0 迭代**：`pnpm test:unit` 全绿；README 数字与实测一致。

**第 1 迭代**：

- Actions artifact 可下载 `coverage/lcov.info`
- Dependabot 在 Security 页可见扫描结果
- **CI 跑通 10 个非视觉 e2e spec，含 `headless-ws.spec.ts`**
- **反例检查**：注释掉 e2e 步骤，CI 仍通过（说明没接上）

**第 2 迭代**：

- 4 个 headless 纯逻辑文件各有测试
- **变异验证**：把 `COOLDOWN_WAITS` 首项从 15s 改成 1s，`withBackoff` 测试必须变红

**第 3 迭代**：

- `getAdapter('不存在的站')` 回退 default 有断言
- 每个适配器的选择器字段非空、正则可编译有断言
- **变异验证**：删掉 `deepseekAdapter.selectors.assistantMessage`，测试必须变红

**第 4 迭代**：

- `vitest.config.ts` 有 thresholds，且 `packages/core/src/headless/**` 单独一条线
- 3 个零引用脚本各有冒烟断言

---

## 九、与既有文档的关系

| 文档                                           | 关系                                  |
| ---------------------------------------------- | ------------------------------------- |
| `optimization-plan-2026-10-16.md`              | v1（未复检）                          |
| `optimization-plan-v2-2026-10-16.md`           | v2（复检修正，含 video，i18n 在长尾） |
| 本文件（v3）                                   | **最新**：无头升为战略路径，i18n 删除 |
| `.qa/final-report.md` / `.pm/final-report.md`  | 证据源                                |
| `docs/plan/plan-multi-workspace-2026-10-11.md` | 并行计划，无冲突                      |

均在 `docs/plan/**` 下，被 `.gitignore` 忽略，不参与 `docs:verify`。

---

## 十、下一步

1. **立即执行第 0 迭代**（0.5 人日）→ CI 变绿
2. **第 1 迭代开工前**：本地跑一次非视觉 e2e 确认 webServer 能起（M5 前置）
3. **无待决项** —— S2 / S4 已答，S3 已由「video 实验性」解决
4. 每完成一项，在本文件对应行追加实际耗时与偏差

---

**变更记录**：

| 版本 | 变更                                                                             |
| ---- | -------------------------------------------------------------------------------- |
| v1   | 双报告初步合并（未复检）                                                         |
| v2   | 复检修正 4 处；排除 video；53 → 22.5 人日                                        |
| v3   | **无头升战略路径**（3.5 → 10.5 人日）；**删 i18n**；M5 提至 P1；22.5 → 28.5 人日 |
