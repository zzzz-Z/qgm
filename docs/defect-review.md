# 应用缺陷分析报告（2026-10）

> **范围**：e2e 测试套件、Playwright 配置、构建链路、仓库卫生。
> **方法**：只读取证——测试结果、源码、配置、快照目录、跨轮变更记录。
> **结论**：5 项缺陷，其中 P0 两项导致 17 个 e2e 用例全红。

## 摘要

| 级别 | 缺陷                                           | 影响                            | 修法成本 |
| :--- | :--------------------------------------------- | :------------------------------ | :------- |
| P0   | 视觉快照平台耦合（`-darwin`）                  | 非 macOS 环境全部视觉用例失败   | 低       |
| P0   | e2e 依赖 build 产物但未等待                    | 冷环境 headless-ws 必挂         | 中       |
| P1   | `playwright.config.ts` 的 `webServer.cwd` 错位 | CI / 干净环境启动失败           | 极低     |
| P2   | 无 CI 配置                                     | 上述缺陷长期潜伏                | 中       |
| P3   | 自动生成物 / 测试产物入库                      | git 污染，`git status` 铁律失效 | 低       |

---

## P0-1 · 视觉基线快照平台耦合

### 现象

`packages/client/test-results/.last-run.json` 记录 `status: "failed"`，17 条失败用例中 11 条为视觉基线（`visual.spec.ts`），错误信息统一为：

```
Error: expect(page).toHaveScreenshot(expected) failed
  12178 pixels (ratio 0.02 of all image pixels) are different.
```

### 证据

`packages/client/e2e/visual.spec.ts-snapshots/` 下 10 张快照**全部带 `-darwin` 后缀**：

```
01-home-dark-chromium-darwin.png   01-home-light-chromium-darwin.png
02-tree-dark-chromium-darwin.png   02-tree-light-chromium-darwin.png
03-changes-dark-chromium-darwin.png 03-changes-light-chromium-darwin.png
04-tasks-dark-chromium-darwin.png  04-tasks-light-chromium-darwin.png
05-editor-dark-chromium-darwin.png 05-editor-light-chromium-darwin.png
```

`visual.spec.ts` 的 `toHaveScreenshot` 调用**未指定 `snapshotPathTemplate`**，走 Playwright 默认命名：

```
{testFilePath}/{testName}-{arg}{ext}  →  实际会插入 {platform} 段
```

### 根因

Playwright 的 `toHaveScreenshot` 默认按 `process.platform` 拼快照后缀。基线由 macOS 一次性生成后入库，
在 Linux / Windows 上会去找 `-linux` / `-win32` 后缀的文件，**找不到即判失败**——这与「像素差异」的表象
不同，实为**快照名不匹配**。

### 修法

二选一：

1. 在 `playwright.config.ts` 设 `snapshotPathTemplate` 去掉 `{platform}` 段（单平台团队适用）；
2. 按平台分目录提交多套基线（跨平台团队适用）。

---

## P0-2 · e2e 依赖 build 产物但未等待

### 现象

`packages/client/e2e/headless-ws.spec.ts:100` 失败：

```
Error: air-server 未在 15s 内就绪（http://127.0.0.1:5518/__ai/）
```

### 证据

`headless-ws.spec.ts` 的 `beforeAll` 直接 `spawn` launcher，仅等 15s：

```text
child = spawn(process.execPath, ['apps/standalone/bin/air-server.cjs'], { ... })
const ready = await waitForHttp(HTTP_URL, 15000)
if (!ready) throw new Error(`air-server 未在 15s 内就绪`)
```

`apps/standalone/bin/air-server.cjs` 是「仓库态检测 + 必要时先 build」的 launcher，主入口为 `dist/_server/index.js`。
在未跑过 `pnpm build` 的冷环境里，build 尚未完成即撞 15s 超时。

### 根因

e2e 的前置条件（build 产物存在）未在 spec 内或 `globalSetup` 里显式声明与等待。

### 修法

1. 新增 `globalSetup`，在测试前确保 build 完成；或
2. spec 内显式检测 `apps/standalone/dist/_server/index.js` 存在，并把超时提到 120s。

---

## P1 · `playwright.config.ts` 的 `webServer.cwd` 错位

### 证据

`packages/client/playwright.config.ts`：

```text
webServer: {
  command: 'pnpm dev:web',
  cwd: '..',        // ← config 在 packages/client/ 下
  url: 'http://localhost:5174/__ai/',
  reuseExistingServer: true,
}
```

`pnpm dev:web` 定义在**根** `package.json`；而 Playwright 的 `cwd` 相对 config 文件目录解析：
`packages/client/` + `..` = `packages/`——该目录下没有此脚本。

### 根因

路径少上了一级（应为 `../..`）。

### 为何长期未暴露

`reuseExistingServer: true` + 本地常年已有 dev server 占用 5174，直接复用跳过了启动流程。
**CI / 干净容器一跑必炸**。

### 修法

`cwd: '..'` → `cwd: '../..'`（单字符级改动）。

---

## P2 · 无 CI 配置

### 证据

`.github/workflows` **不存在**。

### 影响

这正是 P0-1 与 P1 长期潜伏的使能条件：没有跨平台、干净环境的自动化验证，
darwin-only 快照与 `cwd` 错位都能一直「绿」在开发者本机。

### 修法

新增 GitHub Actions workflow：`pnpm install` → `pnpm build` → `pnpm verify` → `pnpm test:e2e`。

---

## P3 · 自动生成物 / 测试产物入库

### 证据

跨轮变更记录中反复出现：

```
modified packages/client/auto-imports.d.ts
added    packages/client/test-results/**/error-context.md
```

### 根因

- `auto-imports.d.ts` 是 `unplugin-auto-import` 的产物（AGENTS.md 明令「不手工编辑」），**被 git 追踪**；
- `test-results/**` 是 Playwright 运行产物，同样不该入库。

### 影响

每次 dev / build / test 都产生 diff，污染 `git status`，也让 AGENTS.md「`git status` 不得包含 `.ai-runner/` 运行态文件」这条铁律形同虚设。

### 修法

1. `.gitignore` 补 `test-results/`；
2. `auto-imports.d.ts` 视团队约定：要么 untrack + 加 `.gitignore`，要么在 pre-commit 钩子里自动重生成后纳入提交。

---

## 修复优先级

```
P1（一行）→ P0-1（config 一行）→ P3（.gitignore）→ P0-2（globalSetup）→ P2（CI）
```

理由：前两项改动成本极低、收益立竿见影（解 12/17 失败）；P3 是止血；P0-2 需新增文件；
P2 是使能基建，放在最后以免一开始就卡在 CI 编写上。

## 附录 · 证据索引

| 文件 / 目录                                     | 用途                                         |
| :---------------------------------------------- | :------------------------------------------- |
| `packages/client/test-results/.last-run.json`   | 17 条失败记录                                |
| `packages/client/e2e/visual.spec.ts`            | 视觉基线 spec，未覆盖 `snapshotPathTemplate` |
| `packages/client/e2e/visual.spec.ts-snapshots/` | 10 张 `-darwin` 快照                         |
| `packages/client/e2e/headless-ws.spec.ts`       | 15s 超时的 `beforeAll`                       |
| `packages/client/playwright.config.ts`          | `webServer.cwd: '..'`                        |
| `apps/standalone/bin/air-server.cjs`            | launcher，依赖 `dist/_server/index.js`       |
| 根 `package.json`                               | `test:e2e` / `dev:web` 脚本定义              |
