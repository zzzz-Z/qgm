# 死代码扫描取证（2026-10-07）

任务来源：看板 `扫描未使用导出（死代码）并取证`。

## 方法

- 扫描 206 个 ts/vue 文件（client composables/utils/components + core src）
- 抽取 566 个 `export function|const|class` 定义
- 严格判据：名字在「非定义文件、非 auto-imports.d.ts、非注释、非测试」中零出现

## 结果：零确证死代码

严筛出 11 个候选，逐个 grep 核验后全部排除：

- MAX_ATTACH_BYTES：本文件 + useAiWindowSend.ts 使用
- COOLDOWN_WAITS：ai-headless.ts 使用
- TSC_SKIP_RE：本文件多处使用
- listSkillMetas：routes 与 registry 使用
- PAGE：兼容入口（buildPage 结果），模块加载时求值
- SKILLS_DIR_REL / STORE_DIR_NAME / saveRegistry：registry.ts 内使用
- projectItems / writeTaskState：task-store.ts 内使用（后者为 commitTaskState 兼容包装）
- SEARCH_SKIP：search.ts 内多处使用

## 结论

- 未发现确证的跨模块零引用死代码。
- PAGE 与 writeTaskState 显式标注「兼容入口」，有意保留。
- 本任务无清理对象：后续「安全清理 + 闸门验证」无操作空间。
