---
name: ui-pitfalls
description: UI 排查踩坑（CSS 选择器、UnoCSS、组件抽取、!important）
keywords: css, 样式, 颜色, 选择器, flex, 布局, 边距, important, uno, vue
---

# UI 排查踩坑录（2026-09 会话复盘）

> 主题：One Dark 改造 + UnoCSS 迁移 + 组件抽取
> 教训：**70% 的时间浪费在"改错地方"**。根因是**没先拿到确凿证据**就开始动手。

---

## 一、CSS 选择器组 + 注释 = 灾难

### 现象

主区 `.terminal` / `.flow-timeline` / `.term-body` 被刷成 `rgba(88,166,255,0.14)` 蓝透，改 `.pane-main` / `style.css` 变量 / 删 `m.oneDark` **全无效**。

### 真凶

```css
/* 坏：注释插在多选择器组中间 */
.pane-main *::-webkit-scrollbar,
.editor ::-webkit-scrollbar,
...
.side-tree ::-webkit-scrollbar,

.pane-main *,      ← 通配所有后代
.chat-list,
.cm-scroller,
.cm-host,

/* 注释夹在中间 */
.primary-btn.takeover:hover:not(:disabled) {
  background: rgb(88 166 255 / 14%) !important;   ← 声明被并到上面选择器组
  ...
}
```

**CSS 解析规则**：选择器组后面的注释被忽略，**下一条规则的声明体被并入当前选择器组**。所以 `.pane-main *` 拿到了 `background: rgba(88,166,255,.14)`，**所有主区后代全蓝透**。

### 定位方法（一行）

```bash
grep -n "\.pane-main \*" client/components/ScriptPanel.vue
```

### 预防

- **CSS 注释不要写在选择器组和 `{` 之间**
- **多选择器组每个选择器独占一行，末行不带注释**
- **改 CSS 前先 `grep` 目标选择器，别靠"改容器"猜**

---

## 二、Console 的 `matches()` 对通配选择器失灵

### 现象

```js
[...document.styleSheets].forEach(sheet => {
  [...sheet.cssRules].forEach(r => {
    if (el.matches(r.selectorText)) { ... }
  });
});
```

**查不到 `.pane-main *`** —— 因为 `el.matches('.pane-main *')` 对元素自身**返回 false**（该选择器需匹配**完整祖先链**）。

### 正确查法

用 DevTools **Elements → Styles 面板**逐条看，**不靠 `matches()` API**。

### 预防

- **CSS 规则排查，DevTools Styles 面板 > Console API**
- `matches()` 只能验证**完整选择器链**，不能验证**后代通配**

---

## 三、删了 `oneDark` 主题，编辑器退回亮色

### 现象

上上轮删 `m.oneDark` → 编辑器变白底黑字；用户以为"亮蓝色是主区背景"，实际是 **CodeMirror 默认亮色主题**。

### 根因

`@codemirror/theme-one-dark` **不只改颜色**，还改 token 高亮、光标、选区、行号等**所有内部状态**。只删它 + 加 `EditorView.theme` 覆盖 3 个选择器 → **内部全亮**。

### 正确做法

1. **保留 `m.oneDark`**（CM 官方主题提供全部子样式）
2. **在 `EditorView.theme(...)` 里覆盖容器色**（`& / .cm-content / .cm-gutters / .cm-activeLine / .cm-cursor / .cm-selectionBackground`）
3. **加 `{ dark: true }`** 让 CM 选暗色变体

---

## 四、UnoCSS 的 `(--var)` vs `[var(--var)]`

### 现象

```css
border-(--border)  /* 被当 border-width: var(--border)，生成无效声明 */
bg-(--surface)     /* 同上 */
```

### 真规则

- UnoCSS presetWind4 **只支持** `[var(--xxx)]` **方括号语法**
- 简写 `(--xxx)` 只对**部分属性**有效（`bg-(--xxx)` 在 UnoCSS 66.10 无效）

### 预防

- **UnoCSS 里所有 CSS 变量一律 `[var(--xxx)]`**
- **改完 `grep` 一次**，确认无 `(--` 残留

---

## 五、组件抽取 = 副作用连锁

### 现象

抽 4 个子组件（DiffOverlay / LoopBar / NoteBar / SidePane）后：

- `getChangeType` / `resumeLoop` 被误删（模板仍在引用）
- `SidePane` 的 `rolling` prop 类型写错（应该是 `Record<string, boolean>` 不是 `boolean`）
- `.pane-side` / `.terminal` 的 scoped 样式错位

### 根因

**删除前没 `grep` 所有调用方**。

### 预防

- **删任何函数/组件前**：`grep -rn "函数名\|组件名" client/`
- **类型检查**：`pnpm tsc` 每轮跑
- **抽取后立即 `tsc`**，别攒几轮再跑

---

## 六、CSS `!important` 堆叠 = 后来的赢

### 现象

同选择器被 3+ 块定义，**最后一块赢**。改前面任一块都无效。

### 定位

```bash
grep -n "^\.pane-main {" client/components/ScriptPanel.vue
# 或
awk '/^\.pane-main \{/,/^\}/' client/components/ScriptPanel.vue
```

### 预防

- **修改前先 `grep` 数选择器出现次数**，>1 时小心
- **用 DevTools Styles 面板**看哪条生效（划掉的 = 被覆盖）

---

## 七、执行环境混用

### 现象

把**浏览器 Console 命令**（含 `document`）贴到**工作台 Node 面板** → `document is not defined`。
把 **bash 命令**（含 `$()`）贴到工作台 → `syntax error near unexpected token`。

### 三个环境

| 环境               | 能跑                                  | 进入方式     |
| ------------------ | ------------------------------------- | ------------ |
| **工作台面板**     | Node.js `.cjs` 脚本                   | 面板         |
| **浏览器 Console** | `document` / DOM / `getComputedStyle` | F12          |
| **系统终端**       | bash / sed / grep / npm               | Terminal.app |

### 预防

- **看到 `document` / `window` / `getComputedStyle` → 浏览器**
- **看到 `fs` / `require` / `process` → 工作台**
- **看到 `sed` / `grep` / `$()` → 终端**
- **别复制粘贴，先确认当前是哪个环境**

---

## 八、UI 排查正确顺序（记牢）

1. **DevTools Elements → 选中目标元素**
2. **Styles 面板逐条看** background / color 生效规则
3. **找到"哪条规则给的异常色"**（带文件名 + 行号）
4. **回到源码 `grep` 那行**
5. **一处一改，改完强刷**
6. **不要**：靠截图猜色值、改容器背景、改全局变量、删主题

---

## 九、AI 与用户协作

### 用户的正确姿势

- **看到 AI 给"猜测性改动"时**，先问"你怎么确认的？"
- **报错先贴完整 stderr**，别贴"就是不行"
- **一个命令一个动作**，别一把梭

### AI 的正确姿势

- **先 `grep` 再改**，别猜
- **每轮只改一处**，可回滚
- **改完必跑 `tsc`**
- **不确定时输出只读诊断脚本**，别输出修改脚本

---

## 十、本会话数据

- **轮次**：~60 轮
- **有效改动 commit**：~15 个
- **回滚操作**：~8 次
- **时间浪费**：真凶定位（.pane-main * 拼接）占了 **~15 轮**，事后用 `grep` 一行定位
- **教训**：**CSS 类名诡异色值 → 先 `grep` 类名 + 通配选择器**

---

## 附：常用排查命令

```bash
# 找某选择器所有定义（含通配）
grep -n "^\.pane-main\|\.pane-main " client/components/ScriptPanel.vue

# 找某色值出现位置
grep -rn "rgba(88 166 255 / 14%)" client/

# 找某函数所有引用
grep -rn "\bgetChangeType\b" client/

# 查看某个选择器块完整内容
awk '/^\.pane-main \{/,/^\}/' client/components/ScriptPanel.vue

# 检查 CSS 括号平衡
node -e 'const s=require("fs").readFileSync("client/components/ScriptPanel.vue","utf8");const a=(s.match(/\{/g)||[]).length;const b=(s.match(/\}/g)||[]).length;console.log(a+"/"+b);'
```
