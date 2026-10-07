# 工单：知识库（LLM Wiki）接入 — core 代理基座 + 工作台检索入口（WO-20261007-08）

> 派发方：宿主侧（复核方）。执行方：应用端。
> **背景附件**：`docs/plan/llm-wiki-knowledge-integration.md`（三重豁免区，含**用户提问原文**、
> 可行性/加成两轮分析、阶段计划、论证边界）。本单是该计划的落地，不重复其论证。
> **范围**：只落计划的**阶段 1 + 阶段 2**（用户拍板 D2 的建议默认值 = 1+2）；
> 阶段 3（`__AI__.wikiSearch`）**本单不执行**，待阶段 2 数据后再评估；阶段 4 为宿主侧自办。
> **编号说明**：`WO-20261007-06`/`07` 已被应用端自拟工单占用
> （`workorder-app-ui-baseline-and-channel-gap-2026-10-07.md` / `workorder-app-pitfalls-and-residual-risks-2026-10-07.md`），
> 故本单顺延为 **08**。
> **前置阻塞**：LLM Wiki 本机**未安装**（宿主侧实测：`127.0.0.1:19828` 无监听、`/Applications/LLM Wiki.app` 不存在）
> ⇒ 段〇 只能由用户在 GUI 完成。**但应用端的段一不被阻塞**——判据用本地 stub 自证；
> 真实联通由宿主侧在段〇完成后亲跑。
>
> **修订 v2（2026-10-07，应用端前置核对后）**：修正 **1 处路径错误**（`handle.ts` →
> `server/handle.ts:25`，原路径不存在），并采纳 4 项优化：① env **请求期**读取；
> ② 转发目标 host 校验；③ 留痕新增 `'wiki'` channel（连带 `LogChannel` 类型，应用端未预见）；
> ④ 段二**不碰 `App.scss`** + 排期后置。
>
> **修订 v3（2026-10-07，应用端实施前终校）**：核对 v2 全部源码锚点后确认——
> ① 路径（`server/handle.ts:25`）、barrel（`routes/index.ts`）、豁免清单、`LogChannel`（`snapshot.ts:25`）
> 四处引用**均属实**；② 补 2 处遗漏的连带改动：
> （a）`control-log.ts:336` 的 `@param channel` 列举**已漏现有 `send`**，加 `'wiki'` 时一并补齐；
> （b）判据③的「留痕」文件路径明确为 **`.ai-runner/logs/wiki.jsonl`**（`writeChannelLog` 的落点，channel 作文件名）。

---

## 段〇（用户侧，非应用端任务）：打通外部依赖

| 项         | 内容                                                                                  |
| :--------- | :------------------------------------------------------------------------------------ |
| 动作       | 安装 LLM Wiki（GUI 应用）→ 建一个项目 → 设置里开 API → 生成 token                     |
| token 落点 | **只落服务端 env**：`LLM_WIKI_URL`（默认 `http://127.0.0.1:19828`）、`LLM_WIKI_TOKEN` |
| 硬禁令     | **token 不入库、不进 git、不写进任何文档 / 日志 / 回执 / 前端**                       |
| 完成标志   | 宿主侧亲跑 `curl http://127.0.0.1:5175/wiki/health` 返回在线态（非 degraded）         |

> 常驻方式见计划 §5 的 D3：建议纳入 **pm2 托管**（前车之鉴：2026-10-07 油猴分发服务因脚本放在
> 被回收目录而无声死亡，「外部常驻依赖不托管 ⇒ 时不时的降级会被误读为功能没做」）。

---

## 段一（P0）：core `/wiki/*` 代理路由 —— token 边界是唯一硬约束

**为什么必须走服务端代理**（不是可选设计）：沙箱子进程 env 为 `{...process.env, ...}`
（`packages/core/src/post-run/run-script.ts:89-90`），而 `process` 在沙箱内可用（仅禁 `.exit`）
⇒ **token 一旦进 env，AI 脚本可 `console.log(process.env.LLM_WIKI_TOKEN)` 把它渲染到页面上**。
代理路由让 token 只存在于服务端进程，是唯一的合规做法。

**先例**：`packages/core/src/skills/installer.ts:174` 已在用 `await fetch(url, { headers, signal })`
——照此模式，**不新增任何依赖**（Node 22 全局 `fetch` + `AbortSignal.timeout`）。

### 施工要点

1. **新文件** `packages/core/src/routes/wiki.ts`，范式照 `packages/core/src/routes/userscript.ts`
   （导出 `export const wikiHono = new Hono()`）。
2. **barrel 三处同步** `packages/core/src/routes/index.ts`：
   `import { wikiHono } from './wiki.js'` + 加进 `HONO_SUB_APPS` + `HONO_PREFIXES` 加 `'/wiki'`。
3. **工作区豁免**：`/wiki` 与工作区无关，须照 `/userscript` 先例在
   **`packages/core/src/server/handle.ts:25`** 的 `WORKSPACE_EXEMPT_PREFIXES`
   （现为 `['/workspace','/preset','/userscript','/restart']`）中加 `'/wiki'`
   ——**漏改会被工作区中间件拦掉**。（本工单 v1 误写 `packages/core/src/handle.ts`，该路径
   **不存在**；应用端前置核对已纠，此处已改正。）
4. **端点**：
   - `GET /wiki/health` → 透传上游健康状态；未配置 token 或上游不可达 ⇒ `{ ok:false, degraded:true, reason }`；
   - `GET /wiki/search?q=<kw>&limit=<n>` → 透传检索结果（保留上游的路径/片段字段）。
5. **env 语义（含一条承重前提）**：`LLM_WIKI_URL` 缺省 `http://127.0.0.1:19828`；
   `LLM_WIKI_TOKEN` 缺失**不算错误**——视为「未配置」，直接返回 degraded（不得 500，不得抛）。
   **⚠️ 必须在「请求期」读 `process.env`，不得在模块顶层缓存**
   （`const BASE = process.env.LLM_WIKI_URL` 是错的）：判据靠 env 注入 stub 随机端口，
   模块级缓存会让注入失效 ⇒ **判据恒真（真空）**。正确写法是在 handler 内取值。
6. **转发目标校验（收窄 SSRF 面）**：**不接受任何来自请求的 host / url 参数**——转发目标恒为
   配置的 `LLM_WIKI_URL`；用 `new URL(path, base)` 拼接后**断言 `u.origin === 配置 origin`**
   （照 `packages/core/src/skills/installer.ts:161` 的 `assertAllowedHost` 精神，但白名单即
   配置 origin 自身）。理由：一旦将来加了 `?url=` 之类透传参数而忘了校验，代理就成了跳板。
7. **超时与异常**：3s（`AbortSignal.timeout(3000)`）；`fetch` **必须 try/catch 包住**——
   超时抛 `TimeoutError`、拒连抛 `TypeError`，两者都要落到 degraded，**不得冒泡成 500**。
8. **降级语义（关键）**：上游不可达 / 超时 / 非 2xx ⇒ 返回 `{ degraded: true, reason }` 且 **HTTP 200**；
   **严禁**返回 `{ results: [] }`。理由：空结果与「没启动」不可分 —— 前者会让 AI 与用户都
   误判为「知识库里没有」，这正是本项目一贯要求的**可判据降级**。
9. **留痕（含连带改动）**：走 `writeChannelLog`（`packages/core/src/state/snapshot.ts:339`），
   条目只含 `q` 摘要（过 `toSingleLine(s, 200)`，见 `routes/control-log.ts:60`）/ 命中数 / 耗时 /
   degraded。**不得传整个 req 或 headers**（headers 含 `Authorization`）。
   **连带**：`snapshot.ts:25` 的 `LogChannel` 是**受控联合类型**
   （`'runner'|'pipeline'|'decisions'|'reject'|'board'|'send'`），新增 channel 须在此加 `'wiki'`
   ——这是应用端前置核对**未预见**的连带改动（一行）。退路是复用 `'decisions'`，但语义不纯
   （那是「决策留痕」），**推荐新增 `'wiki'`**。

### 承重判据（`packages/core/tests/wiki-proxy.node-test.ts`）

> 判据**不得依赖真实 19828**（本机未装 ⇒ 依赖运行态的判据必红）。用 `node:http` 在
> `127.0.0.1:0` 起 stub、取随机端口，通过 env 注入 `LLM_WIKI_URL` 指向它。

| #   | 判据                                                                                   | 变异（必须变红）                                                                   |
| :-- | :------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| ①   | stub 校验 `Authorization: Bearer <token>`；带 token ⇒ 200 且 `/wiki/search` 返回该结果 | **删掉 header 注入行** ⇒ stub 返 401 ⇒ 路由转 degraded ⇒ ① 红（证 token 真被注入） |
| ②   | stub 被杀/拒连 ⇒ 返回 `degraded:true` 且 HTTP 200                                      | **把降级分支改成返回 `{results:[]}`** ⇒ ② 红                                       |
| ③   | 响应体与**留痕**均不含 token 字面量（成功路径 + 失败路径**都要**断言）                 | 把 token 拼进错误 reason ⇒ ③ 红                                                    |
| ④   | **env 请求期生效**：注入 stub A 端口后改成 stub B 端口，同一进程内第二次请求须打到 B   | **把 env 读取提到模块顶层缓存** ⇒ 第二次仍打 A ⇒ ④ 红（施工要点 5 的机器化）       |

> ③ 若只在成功路径断言 = 判据真空：失败路径才是最容易把 token 带出来的一条。
> ④ 存在的理由：「判据靠 env 注入」的隐藏前提就是「实现不缓存 env」——不写这条，
> 实现一旦缓存，①②③ 仍可能全绿而功能已坏。

---

## 段二（P1）：工作台知识库入口（只读）

> **避让约束（硬，v2 新增）**：面板样式**不得改 `App.scss`**——该文件正被 WO-20261007-02 / -03
> 占用（WO-03 段三在做 148 处 `!important` 分批收敛），三单同改一个文件必撞车。
> 实测 `App.scss` 目前**只被 `packages/client/App.vue` 引用** ⇒ 新面板用 **scoped 样式或
> 独立 `.scss`** 即可完全解耦。
>
> **排期（v2 新增）**：段二**排在段一之后单独交付**——段一自洽、不撞 UI、可独立验收；
> 段二开工前须先确认与 WO-02/03 的 UI 批次不冲突。**即：阶段 A 先走，阶段 B 后置。**

| 项     | 内容                                                                               |
| :----- | :--------------------------------------------------------------------------------- |
| 落点   | `packages/client` —— 工作台加「知识库」面板                                        |
| 行为 1 | 调 `/wiki/health`：**在线** / **离线（显示 degraded reason）** 两态可见            |
| 行为 2 | 一个只读搜索框：调 `/wiki/search`，展示命中条目的**文件路径 + 片段**，点击不做什么 |
| 硬约束 | **不做「一键把结果注入当前对话」**（首问/上下文污染风险，待观察后再议）            |
| 判据   | 离线态必须渲染「离线」而非空列表；**变异**：把离线态也渲染成空列表 ⇒ 红            |

---

## 段三（本单不执行）：`__AI__.wikiSearch` 检索面

计划的阶段 3 依赖 D2 二次确认，**本单不做**。留两条要点给下一单：

1. 沙箱脚本**本来就能** `fetch('http://127.0.0.1:5175/wiki/search?q=...')`（静态禁令只拦
   `fs/path/child_process/os/process.exit`，不拦 fetch）——所以这一段的收益是「统一超时/限流/留痕」，
   不是「能不能查到」；
2. 若做成 `__AI__` 薄封装，**必须补「经 `__AI__` 面调用」的承重判据**
   （WO-20261007-04 的教训：模块测试全绿但 `__AI__` 面漏暴露 `appendText`/`fileInfo`，
   判据绕过集成点 ⇒ 真空）。

---

## 段四（hostOwned，宿主侧自办，不入本单验收）

宿主侧在 `~/.workbuddy/mcp.json` 加 LLM Wiki 的 MCP server 配置，让宿主 AI 也能直接查。
与段一不冲突（两条独立通道），随时可做。

---

## 段五：明确不做

- ❌ **不给沙箱开通用出站能力包**——它本就能 fetch（禁令不拦），但**不额外提供任何把外部数据
  自动写回项目 / 自动回传页面的通道**，避免构成数据外泄面；
- ❌ **不把项目文档镜像进 wiki**（会造出第四套知识源，与 `docs/` + `SYSTEM.md` SSOT 冲突）；
- ❌ **token 不入前端、不入沙箱 env**（段一的全部理由）；
- ❌ **不做「一键注入对话」**（段二硬约束）；
- ❌ **不动 `LESSONS_BUDGET` 与首问构建**——「lessons 检索化 / 首问瘦身」是计划的后续独立工单，
  与本单解耦，避免一次改两处难归因。

---

## 交付与闸门

**应用端交付物**：

| 文件                                             | 类型                                   |
| :----------------------------------------------- | :------------------------------------- |
| `packages/core/src/routes/wiki.ts`               | 新增                                   |
| `packages/core/src/routes/index.ts`              | 修改（barrel 三处）                    |
| `packages/core/src/server/handle.ts`             | 修改（`:25` 豁免清单加 `/wiki`）       |
| `packages/core/src/state/snapshot.ts`            | 修改（`:25` `LogChannel` 加 `'wiki'`） |
| `packages/core/tests/wiki-proxy.node-test.ts`    | 新增（4 条承重判据 + 4 组变异）        |
| `packages/client/**`（知识库面板，**独立样式**） | 新增/修改（**不改 `App.scss`**）       |

**闸门**（顺序执行）：

1. `pnpm tsc` / `tsc:apps` / `tsc:client` / `test:tsc` → 全绿；
2. 目标测试（wiki-proxy）→ 全绿；**四组变异逐组确认变红后还原**；
3. 全量 `npx vitest run`（带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`，否则 safe-delete 垫片会连环红）；
4. `pnpm anchors:verify` / `pnpm docs:verify` → 绿。

**分工纪律**：

- 应用端**可以** `pnpm build`（构建始终允许）；
- **重启 5175 归宿主侧**（`instance-ownership-v1`）——应用端回执「产物已更新」后由宿主侧执行；
- 段〇未完成前，**不得声称「与真实知识库联通」**——stub 判据通过 ≠ 真实联通，
  真实联通唯一判据是宿主侧亲跑 `/wiki/health` 的在线态。

**复检要点**（宿主侧）：

1. **四组**变异逐组变红（不看自述，亲跑）；
2. `packages/core/src/server/handle.ts:25` 的豁免清单是否真的加了 `/wiki`
   （漏改则功能不可用但单测可能仍绿）；
3. 全仓 grep `LLM_WIKI_TOKEN`：**只允许出现在 wiki.ts 与测试的 env 设置处**，
   不得出现在前端、日志、文档、回执；
4. `wiki.ts` 内**不得有模块级 env 缓存**（`grep -n "process.env" wiki.ts` 应全部在 handler 内）；
5. **生产态豁免验证**（v2 新增，dev 测不出来）：`WORKSPACE_EXEMPT_PREFIXES` 的效力只在
   **无工作区**的生产态显现（`handle.ts:29-31` 注释：生产默认无工作区）——宿主侧须在
   生产态（`pnpm start` 或等价）实拉 `/wiki/health`，确认**不是工作区守卫的 403/拒绝**；
6. 全量闸门 + build + restart 后，活端实拉 `/wiki/health`；
