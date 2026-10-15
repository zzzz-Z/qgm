import antfu from '@antfu/eslint-config'
import type { Linter } from 'eslint'
import vueSetupRules from 'eslint-vue-setup-rules'

const config: Promise<Linter.Config[]> = antfu({
  unocss: true,
  typescript: true,
  vue: true,
  plugins: { 'vue3-script-setup': vueSetupRules },
  formatters: true,
  // [lint-scope-v1] 排除运行态与产物目录
  // WHY: .ai-runner 下是 backup 源码副本 + 运行日志，dist/coverage 是构建产物；
  //   原先 `eslint .` 连它们一起 lint，error 数随运行态漂移，回归闸门失去可比性
  ignores: ['.ai-runner/**', '**/dist/**', 'coverage/**', '**/playwright-report/**', '**/test-results/**'],
  rules: {
    // cjs
    'no-cond-assign': 'off',
    'prefer-spread': 'off',
    'prefer-rest-params': 'off',
    'no-restricted-globals': 'off',
    'node/prefer-global/process': 'off',
    'node/prefer-global/buffer': 'off',
    // cjs
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    'ts/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    'unused-imports/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    'no-console': 'warn',
    // [jsdoc-destructured-v1] 单对象参数（opts/deps）的子字段不强制单列 @param。
    // [WHY] checkDestructured 默认 true 时要求 @param opts.script 逐子字段列出，
    //   合并写 @param opts 又会漏报；两者都不满足规则 → 固有冲突（WO-06 段二认定）。
    // [CONSTRAINT] 只关子字段展开要求，参数本身缺失仍会报。
    'jsdoc/check-param-names': ['warn', { checkDestructured: false }],
    'vue/no-v-text-v-html-on-component': 'off',
    'perfectionist/sort-imports': 'off',
    'vue/comma-dangle': 'off',
    'style/comma-dangle': 'off',
    'style/jsx-quotes': 'off',
    'import/order': 'off',
    'antfu/if-newline': 'off',
    'style/brace-style': 'off',
    'style/max-statements-per-line': 'off',
    'vue/define-macros-order': 'off',
    'vue/component-name-in-template-casing': 'off',
    'vue/require-default-prop': 'off',
    'eslint-comments/no-unlimited-disable': 'off',
    'vue/block-order': 'error',
    'prefer-destructuring': ['error', {
      object: false, // 禁止对象解构
      array: false, // 禁止数组解构
    }],
  },
}).append({
  // [vue-only-rule] vue3-script-setup 的规则依赖 vue-eslint-parser 的 parserServices；
  //   挂在顶级 rules 会作用到 json 等非 .vue 文件 → TypeError 直接崩掉整个 eslint 进程
  files: ['**/*.vue'],
  rules: { 'vue3-script-setup/declaration-order': 'error' },
}).append({
  // [declaration-order-exceptions] 这 4 个文件的真实依赖与规则的静态分段顺序冲突
  // WHY: 领域工厂入参（script/attachedFiles/paneRef/previewFile/softPause…）由上方 refs/composables 产出，
  //   按规则重排会把工厂提到 refs 之前 → setup 时 TDZ；写在配置里可避免行内注释被自动修复器吞掉
  // CHANGE-IMPACT: 仅这 4 个文件豁免该规则，其余 .vue 仍受 declaration-order 约束
  files: [
    'packages/client/App.vue',
    'packages/client/components/feedback/TooltipHost.vue',
    'packages/client/components/panels/FileTree.vue',
    'packages/client/components/script/ScriptPanel.vue',
  ],
  rules: { 'vue3-script-setup/declaration-order': 'off' },
}).append({
  files: ['scripts/**/*.{js,mjs,cjs}'],
  rules: { 'no-console': 'off' },
}).append({
  // [review-doc-exempt-v1] 审查报告用代码块引用现有代码作为证据，那些片段本来就不该
  // 被当作可运行示例检查：它们摘录的是问题现状，变量未使用正是被举报的现象本身。
  // WHY: 全仓库关掉 markdown lint 会让所有文档示例失去质量保障，只豁免审查类文档。
  // CONSTRAINT: 仅 REVIEW / AUDIT 类文档豁免；普通指南/教程类 md 仍受 markdown 规则约束。
  // CHANGE-IMPACT: 新增审查报告无需再为代码块加 eslint-disable。
  // [review-doc-exempt-v2] 大小写三态各写一遍：minimatch 的 files 是大小写敏感的，
  //   原版只写 `*REVIEW*` ⇒ 实际命名 `defect-review.md`（小写）**不匹配**、拿不到豁免（实测）。
  // [CONSTRAINT] 本豁免只关 no-unused-vars，**管不了围栏伪代码**：```ts 里的省略号/裸对象字面量
  //   会被当 TS 解析并报 parsing error。节选与伪代码请用 ```text 围栏（见 AGENTS.md 独有约束）。
  files: [
    'docs/**/*{REVIEW,Review,review}*.md',
    'docs/**/*{AUDIT,Audit,audit}*.md',
  ],
  rules: {
    'unused-imports/no-unused-vars': 'off',
    'ts/no-unused-vars': 'off',
  },
}).append({
  // [no-console-test-exempt-v1] 测试/探针里的 console 是诊断输出（用例失败时排障用），
  //   不是生产代码的副作用；glob 覆盖 *.node-test.ts 与 e2e 探针。
  files: ['**/*.node-test.ts', 'packages/**/e2e/**'],
  rules: { 'no-console': 'off' },
}).append({
  // [no-console-logger-exempt-v1] log.ts 是全客户端唯一 console 出口（日志封装器本身），
  //   它不 console 谁 console；豁免其 no-console。
  files: ['packages/client/utils/log.ts'],
  rules: { 'no-console': 'off' },
}).append({
  // [no-console-headless-exempt-v1] headless 是浏览器自动化引擎，其诊断输出（引擎启动、
  //   SSE 字节数等）是运维可见的固有手段，非生产副作用；它们没有可用的 logger（logger.cjs 是沙箱脚本专用）。
  files: ['packages/core/src/headless/**'],
  rules: { 'no-console': 'off' },
})

export default config
