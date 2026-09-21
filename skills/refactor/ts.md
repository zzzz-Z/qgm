---
name: refactor-ts
description: TypeScript 高内聚低耦合（HCLC）架构审查与重构规范
keywords: refactor, hclc, typescript, 高内聚, 低耦合, 接口隔离, 依赖注入, 领域模型, 模块边界, 纯函数
---
# 🛠️ Skill: TypeScript HCLC Architect (高内聚低耦合架构师)

### 🎯 核心目标
在 TypeScript 项目中，通过严格的类型约束、模块化设计和依赖管理，确保每个模块**职责单一且完整（高内聚）**，模块间**依赖最小化且易于替换（低耦合）**。

### 🧠 思维框架 (Design Mindset)

1.  **内聚性检查**：这个文件/类是否只关心"一件事"？修改一个业务需求是否只需要改动这一个文件？
2.  **耦合度检查**：删除或替换这个依赖，是否会导致其他模块崩溃？是否可以通过接口抽象隔离变化？
3.  **类型即文档**：TypeScript 的类型系统不仅是校验工具，更是表达"契约"和"边界"的核心手段。
4.  **显式优于隐式**：拒绝 `any`，拒绝全局状态污染，所有依赖关系必须在构造函数或函数签名中显式声明。

---

### ⚙️ 执行规范 (Actionable Rules) - 增强版

#### 1. 接口隔离与契约优先 (Enhanced)
*   **规则**：跨模块通信必须通过契约进行。优先使用 **TypeScript 原生类型系统** 表达业务语义，而非仅靠 Interface。
*   **TS 实践**：
    *   **状态表达**：使用 Discriminated Unions 替代 Enum + Class 继承。
        ```ts
        // ✅ Good: 穷尽性检查 + 数据与状态绑定
        type OrderState = 

          | { status: 'draft'; items: CartItem[] }
          | { status: 'paid'; paymentId: string; paidAt: Date }
          | { status: 'shipped'; trackingNo: string };

        ```
    *   **契约验证**：使用 `satisfies` 确保实现符合契约且不丢失字面量类型推断。
    *   **ISP 落地**：若 Interface > 3 个方法，强制审查是否可拆分为 Role-based Interfaces。

#### 2. 依赖管理分级策略 (Tiered Dependency Strategy)
*   **规则**：根据代码层级采用不同的耦合容忍度，避免过度设计。
*   **分级标准**：

    | 层级 | 耦合要求 | DI 方式 | 类型约束 |
    | :--- | :--- | :--- | :--- |
    | Domain Core | 零外部依赖 | 纯函数 / Value Objects | Strict, No `any` |
    | Application | 仅依赖 Domain 接口 | 构造函数注入 / Factory | Interface Only |
    | Infrastructure | 允许具体实现 | 容器注入 / Adapter | 允许 SDK 类型穿透 |
    | Edge/API | 允许框架耦合 | 框架原生 Hooks/Decorators | Zod/Schema 验证边界 |

#### 3. 重构安全协议 (Refactoring Safety Protocol)
*   **⚠️ 强制执行**：在对任何模块进行 HCLC 重构前，必须确认以下任一条件满足：
    1.  存在覆盖该模块公共 API 的单元测试/集成测试。
    2.  已编写 Characterization Test 锁定当前输入输出行为。
    3.  调用方极少且可通过人工/E2E 快速验证。
*   **重构手法**：优先使用 IDE 支持的自动化重构（Extract Method, Move File），再手动调整抽象。禁止“复制粘贴后删除旧代码”的高风险操作。

### 🔍 Code Review 自检清单 (量化版)

| 检查项 | 🟢 合格 | 🟡 警告 (需记录技术债) | 🔴 阻断 (必须修复) |
| :--- | :--- | :--- | :--- |
| 文件 Import 数 | ≤ 5 个 | 6-8 个 | > 8 个或含循环依赖 |
| 函数参数个数 | ≤ 3 个 | 4 个 | ≥ 5 个 (应封装为 Options Object) |
| 圈复杂度 | ≤ 10 | 11-15 | > 15 |
| `any` 使用 | 0 (Core) / <3 (Infra) | 有合理注释的 `any` | 无注释 `any` 或 `@ts-ignore` |
| 变更影响面 | 单文件 | 同模块内 2-3 文件 | 跨模块 > 3 文件 |

### 📝 AI 输出格式规范 (Output Schema)

当被要求审查或重构时，**必须**按以下结构响应：

1.  **🩺 诊断摘要**：一句话概括核心架构问题（如："OrderService 承担了持久化与业务计算双重职责"）。
2.  **🎯 违规映射**：列出具体代码行号及其违反的 HCLC 原则编号。
3.  **🛠️ 重构方案**：
    *   **Step-by-Step**：分步骤说明（先提取接口 -> 再创建适配器 -> 最后替换注入）。
    *   **Before/After**：提供关键代码对比片段（Diff 风格）。
4.  **🧪 验证策略**：明确说明如何验证重构未破坏功能（如："运行 `npm test -- orders` 并确保覆盖率不下降"）。
5.  **⚖️ 权衡说明**：诚实指出重构带来的潜在成本（如："增加了 2 个文件，但提升了订单状态流转的可测试性"）。