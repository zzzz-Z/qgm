# __AI__ 完整 API 手册

> 由 RULES 第四章拆出（batch3-1）。RULES 保留速览索引；此处为完整参数说明。
> 按需加载：涉及文件操作 / 断言 / 状态时先读本文件。

## 核心偏好

- 能用 __AI__ 函数解决的，不用原生 fs / console / process。
- 原生 API 仅用于 __AI__ 未覆盖的场景。
- 若 runner 未注入速查表 → 报告异常并退出，不猜测 API 签名。

---

### 文件操作

- `__AI__.readText(path)` : 读取文本
- `__AI__.writeText(path, content)` : 写入文本（自动创建目录）
- `__AI__.replaceInFile(path, { oldString, newString, unique })` : 替换文本，unique=true 时若非唯一出现会报错
- `__AI__.exists(path)` : 判断文件是否存在
- `__AI__.readJSON(path)` : 读取并解析 JSON

### 质量检查

- `__AI__.lint(files)` : 运行 ESLint，返回 { ok, output }
- `__AI__.typeCheck()` : 运行 vue-tsc --noEmit，返回 { ok, output }

### 日志与断言

- `__AI__.log(...args)` : 带 [AI] 前缀的 console.log
- `__AI__.assert(cond, msg)` : 断言失败即 process.exit(1)

### 执行控制

- `__AI__.writeReport(obj)` : 输出 `__AI_REPORT__` 结构供 Runner 解析
- `__AI__.writeDiffReport(obj)` : 标记为只读预览并退出
- `__AI__.exitNeedInput(question, options, defaultId)` : 请求人工输入

### 语义输出（推荐用，替代裸 console.log）

- `__AI__.ok(msg)` : 绿色 ✓
- `__AI__.skip(msg)` : 黄色 !
- `__AI__.warn(msg)` : 黄色 ⚠
- `__AI__.err(msg)` : 红色 ✗，输出到 stderr

### 文件安全补丁（替代手写 readFileSync + replace + writeFileSync）

- `__AI__.backup(file)` : 备份 `file` → `.ai-runner/backup/<相对路径>`，已存在则保留首次
- `__AI__.patchFile(file, anchor, replacement, opts)` : 幂等补丁
  - 自动 readFileSync → 校验 anchor 命中 → backup → 替换 → 写回 → 回读验证
  - `opts.unique` : anchor 命中数必须为 1，否则抛错
  - `opts.marker` : 命中则返回 `{ ok: true, skipped: true }`（幂等）
  - 返回 `{ ok: true, replaced: N }`

### 断言

- `__AI__.assertContains(file, anchor)` : 文件不含 anchor 则 exit 1
- `__AI__.assertNotContains(file, anchor)` : 文件含 anchor 则 exit 1

### State helper

- **AI**.statePath() : .ai-runner/state.json 绝对路径
- **AI**.readState() : 解析失败返回 null
- **AI**.updateState(fn) : 读 -> fn(st) -> round+1 -> 写回 -> 返回 st

### Regex / file

- **AI**.esc(s) : 正则元字符转义
- **AI**.dump(file, from, to) : 返回「行号: 内容」（1-based 含端点）
- **AI**.atomicWrite(file, content) : tmp + rename

### Env gate

- **AI**.cwdMust(expected) : cwd 不符则 err + exit 2
---

<a id="ch5"></a>
