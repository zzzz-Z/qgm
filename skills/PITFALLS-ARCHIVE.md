# 已修复踩坑归档

> 由 RULES 第六章拆出（batch3-3）。这些坑已在代码/流程中修复，不再活跃。
> 保留供事后查阅或回溯。活跃坑仍在 RULES 第六章。

---
**T2. overlay 沙盒里 `chmodSync` 报 ENOENT**

- 根因：`writeFileSync` 只进内存，真实磁盘无该文件
- 规避：脚本里去掉 `chmodSync`；可执行位由用户在终端 `chmod +x` 补


**T3. overlay 里 `statSync().mtime` 是 undefined**

- 现象：`.mtime.toISOString()` 崩溃
- 规避：统一用 `mtimeMs`（数字）


**T5. macOS 无 GNU `timeout`**

- 现象：`/bin/sh: timeout: command not found`
- 规避：
  - 不用 `timeout`
  - 用 playwright / node 内置 timeout；或 `perl -e 'alarm N; exec @ARGV'`


**T7. interceptor 的 `readdirSync withFileTypes` bug**

- 现象：`The "path" argument must be of type string. Received an instance of Dirent`
- 根因：overlay patch 把 Dirent 对象当字符串传给 `path.join`
- 已修：见 commit `fix(interceptor): handle fs.readdirSync withFileTypes`
- 规避：脚本里避免直接用 `fs.readdirSync(dir, { withFileTypes: true })`，改用 `safeReaddir`


**T8. helpers.cjs 正则双重转义**

- 现象：`SyntaxError: Invalid regular expression: /...\\s/: Unterminated group`
- 根因：写正则时错误地写了双反斜杠（应为单反斜杠 + s）
- 规避：正则字面量写完后 `node --check` 或 `node -e 'console.log(/.../)'` 验证


**P5. `git rm --cached` 后 `git add` 路径不存在**

- 现象：`fatal: pathspec '...' did not match any files`
- 根因：`--cached` 移除索引后，磁盘上文件已被手动删掉
- 规避：直接 `git commit`（不 `git add`），或在删除前先 `git add -A`
