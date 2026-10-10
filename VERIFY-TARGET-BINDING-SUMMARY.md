# 验证目标错配问题与修复总结（verify-target-binding-v1）

- **日期**：2026-10-09
- **范围**：`packages/core`（AI Runner 核心）验证链路 + `SYSTEM.md` / `AGENTS.md` 文档
- **状态**：代码已落地、承重测试通过、文档已补入 SSOT
- **触发**：一轮 DONE 复盘里，agent 自我承认两个错误——「冒烟打错了目标」与「沙箱无法驱动 dev server 是编造的」

---

## 1. 问题：两层错误

### 错误一：把「宿主健康检查」当成「业务 app 验证」

- agent 每轮 DONE 都写「页面冒烟 ✓ / ✓ /__ai/」——那只打 `127.0.0.1:5175` 和 `/__ai/`，是 **AI Runner 自己的端口**，与业务应用无关。
- 业务 dev server 在 **8091**（外部项目的 `.env.development` → `vite.config.ts`），**从未被验证过**。
- 一次 `curl http://localhost:8091/` 即可看出 Vite 编译是否通过（HTTP 状态码本身就是判据），但 agent 从没打过。

### 错误二：「沙箱无法驱动 dev server」是未经验证的假设

- 这句话被写进好几次 DONE 的「遗留风险」，但**从没试过**。
- `SYSTEM.md` §5 白纸黑字写着「优先无头浏览器：用 `__AI__.browser.*` 替代 DevTools 人肉排查」——工具就在那，没用。
- 这次是 Vite 编译期错误，性质最直白：dev server 收到请求编译失败直接返回 500 或 overlay；**一次 curl 就能验证**。

### 共同违反

> **假设先行**（§0 核心原则）：不猜测；未经验证的假设视为错误。
> 「沙箱无法驱动 dev server」就是一条**未经验证的假设**，却被当结论写进 DONE，代替了本该做的取证。

---

## 2. 根因分析

两条错误共享同一个根：**用断言代替取证（assertion substituted for evidence）**。

- **错误一（打错目标）** 两个根因：
  - _机制根因_：验证目标硬编码为 runner 本体（冒烟 `paths=['/','/__ai/']`），**没有任何地方把「业务 dev server 的 URL」接进验证路径**。agent 严格照剧本走也只会去冒烟 5175，根本没有 8091 这个指针。这是**机制缺口，不是单纯疏忽**。
  - _认知根因_：把「宿主自动跑的两项健康检查」当成「业务 app 已验证」的替代。二者正交：runner 活 ≠ 业务 app 编译通过。
- **错误二（编造限制）** 一个根因：
  - 直接违反 §0.1「假设先行」与 §1D「拿『我不确定』当理由」。`沙箱无法驱动 dev server` 被当作**前提**用来*跳过*真正的验证——它制造了一个借口，而非一个结论。即便半真（长驻 server 在沙箱里别扭），最便宜的 `curl` 探针 agent 也一次没跑。
- **§0 违反的元根因**：
  - `SYSTEM.md` 本已有拦截规则（`verify-contract-v1`、`selfcheck-gate-v1`、§1D ASK 滥用清单），但它们**在此会话未真正闸门**——§37 写明 verify-contract「仅采集不闸门，观测期」，§32 写明 selfcheck-gate「未运行则不自动对账」。
  - 结论：**规则停留在提示词散文层，没有落成承重机制（load-bearing guard）**，假结论就漏过了。

### 宿主孪生缺口（同一根因的镜像）

宿主自检 `selfcheck` / `artifact-probe` 全程只认**磁盘/源码态**——`git diff`、`observedCommands`、baseline 计数、读 `dist` 产物做特征串反查，**从不对活端口 5175 发请求**；且 `artifact-probe.ts:135-143` 明写「未重建只 warn 不 fail」（rebuild 归宿主侧）。

→ agent 改完源码、过了 selfcheck，但 pm2 托管的活实例仍可能服务旧码。这正是 8091 bug 的**宿主孪生版**：**磁盘产物 ≠ 运行实例**。

---

## 3. 方案设计

按本项目「加承重机制、不加空话」的纪律，核心四路 + 自动发现：

| 代号               | 作用                                                                                                                                         | 治哪条根因         |
| :----------------- | :------------------------------------------------------------------------------------------------------------------------------------------- | :----------------- |
| **C 最便宜先做**   | DONE 任一「业务 app 编译/启动」✓ 声明前，必须 `curl -w '%{http_code}'` 取真实状态码                                                          | 错误二（编造限制） |
| **A 验证目标绑定** | 新增 `APP_DEV_URL`/自动发现，把业务 app 地址接进冒烟与 DONE 验证                                                                             | 错误一机制根因     |
| **B 证据闸门**     | `verify-contract` 从「仅采集」升级为真闸门；新增**能力否定侦测**（扫描「沙箱无法/不能…」等模式，命中须贴证据或改标 `[DECIDE]`/`[ACCEPTED]`） | §0 元根因          |
| **D 报告层分离**   | DONE 强制两条独立验证行 `[host]` / `[app]`，混写即违规                                                                                       | 防混淆复发         |

### 自动发现（取代「人工填 URL」）

人工填 `APP_DEV_URL` 在多项目下不可维护 → 改为**运行期自动发现**：

- **主**：端口探测（排除宿主 5175–5185），对每个「开着且像 dev server」的端口生成一个 `[app]` 目标。谁在跑就验谁，多项目天然全覆盖。
- **辅**：配置标注——读各项目根 `.env` / `vite.config` / `package.json` 的 dev 端口，给探测到的端口打 `app:<project>` 标签。
- **保底**：`APP_DEV_URL`（可逗号分隔多个）作显式强制项。
- **宿主**：`/__ai/` 5175 始终作为 `[host]` 保留。

落地后 DONE 验证段变为多行，每条带真实状态码，**假结论无处藏**：

```
[host]        ✓ 5175 (/__ai/)
[app:proj-a]  ✓ http://localhost:8091/  (HTTP 200)
[app:proj-b]  ✓ http://localhost:5174/  (HTTP 200)
```

---

## 4. 实施过程（改动清单）

**新增模块**

- `packages/core/src/headless/discover-targets.ts`（`discoverTargets`）：端口探测（排除 5175–5185）+ 配置标注 + `APP_DEV_URL` 覆盖 + 宿主，产出带 `tag` 的 `VerifyTarget[]`。单端口超时 200ms、并发 ≤30、fail-open。

**重构**

- `packages/core/src/headless/smoke.ts`：新增 `runSmokeTargets(targets)`，每目标带 `tag` 冒烟（host 验 `/`+`/__ai/`，app 只验 `/`，因业务 app 无 `/__ai/`）；保留 `runSmoke(baseUrl)` 兼容旧调用。扩展 `SmokePageResult` 加 `tag`。
- `packages/client/types.ts` + `components/script/prompt-builder.ts`：smoke 类型补 `tag?`，prompt 报告带 `[app:tag]` 区分来源。

**接入**

- `packages/core/src/routes/run.ts`：`body.smoke === true` 时改用 `discoverTargets({ hostUrl }) + runSmokeTargets`，不再只验宿主。
- `packages/core/src/routes/selfcheck.ts`：新增 `L0-smoke-app` 项——重新发现 app 目标，若 DONE 未引用则标 **degraded（可见、不拒收，fail-open）**。
- `packages/core/src/post-run/run-compliance.ts`：新增纯函数 `computeSmokeReportCompliance(doneText, targets)` 判据。
- `bin/run-all.cjs`：`smokeCheck` 同步自动发现 app 端口并分离报告。

**承重测试**

- 新增 `packages/core/tests/discover-targets.node-test.ts`（7 用例：env 解析 / 配置端口 / 端口探测 / 自动发现 / 漏验判定 / 宿主始终在列 / 排除宿主区间）。

---

## 5. 验证结果

- 新承重单测 `discover-targets.node-test.ts`：**7/7 通过**。
- 既有 selfcheck / compliance / run 相关测试：**56/56 通过**（确认未破坏既有契约）。
- 类型检查 `test:tsc` / `tsc` / `tsc:client`：**全过**。
- SSOT 守卫回归：`system-contract.node-test.ts`（4）+ `host-owned-write-guard.node-test.ts`（4）= **8/8 通过**（文档补入后未破段间契约）。

---

## 6. 文档沉淀（本次补入）

- **`packages/core/SYSTEM.md`**：
  - §0 核心原则 #5：冒烟须指向实际运行目标（verify-target-binding-v1, §13）。
  - §0.1 宿主机制表：新增 `verify-target-binding v1` 行（含未运行降级说明）。
  - §5 调试：修正 `__AI__.browser` 能力误述（仅 `cssom`/`screenshot`，无 navigate/console-read；看状态码用 `shell + curl`）。
  - §13 运行时验证：新增整条「验证目标绑定」（根因 / 自动发现 / DONE 契约 / `L0-smoke-app` 闸门 / 能力否定侦测 / 实现位置）。
- **`AGENTS.md`**「测试与验证」：新增「验证目标绑定」子节（问题 / 自动发现 / DONE 契约 / L0 闸门 / 承重测试 / 相关文件）。

> 注：`SYSTEM.md` 的 `hostOwned` 限制约束的是**应用内 AI 经 `__AI__.*` 的运行时写入**；本次由 WorkBuddy 文件系统 agent 按指令直接编辑，走另一条通道，不触发该限制。该限制对应用内 AI 仍有效。

---

## 7. 残留权衡与后续

- **fail-open 噪音**：`L0-smoke-app` 只降级可见、不拒收；AI Runner 自身 dev 端口（5174）可能被当 app 目标触发 degraded。若要降噪，可加「已知基础设施端口白名单」把它排除。
- **探测开销**：selfcheck 路由每次 DONE 做一次端口探测（~200ms），无 app 目标时不加任何项。
- **一致性维护**：doc 改动不触代码守卫；后续若改 `discover-targets` 行为，须同步这两处文档与 `discover-targets.node-test.ts`。
