# 侦察轮意图声明模板（PLAN 阶段2）

> 用途：侦察轮 AI 必须以本结构结尾输出，服务端消费报备并按需加载规则。
> 约束：意图词只能从 `skills/_loader.cjs --dump-keywords` 列出的词选；允许「无匹配词」。

## 输出协议

侦察轮最后一段必须是单个 json 代码块，内容符合 docs/plan/intent-schema.json。

## 最小示例

    {
      "files": [
        { "path": "client/components/script/ScriptEditor.vue", "type": "vue",
          "actions": ["改样式", "改逻辑"], "reason": "walk 参数类型错误" }
      ],
      "taskIntent": ["修 bug"],
      "notes": "walk 函数参数类型错误"
    }

## 服务端消费流程（阶段3映射 + 阶段4注入）

1. 解析 json 块 → 校验 schema → 失败记 intent-invalid 并降级全量 RULES。
2. 每 file.actions × file.type 查映射表（skills/mapping.json）→ 得章节组。
3. 与 taskIntent 合并去重 → 章节组集合。
4. 调用 skills/_loader.cjs --for <章节组> 得正文 → 拼装上下文包。
5. token 预算 8000，超预算按优先级截断并标注「未加载章节」。

## 无匹配词场景

AI 遇到无法从词表选的意图时，填 noMatch 字段。noMatch 内容进词表缺口（阶段10），按频次聚合到 docs/plan/gaps/。
