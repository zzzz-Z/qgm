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
    'vue/block-order': 'error'
  }
}).append({
  // [vue-only-rule] vue3-script-setup 的规则依赖 vue-eslint-parser 的 parserServices；
  //   挂在顶级 rules 会作用到 json 等非 .vue 文件 → TypeError 直接崩掉整个 eslint 进程
  files: ['**/*.vue'],
  rules: { 'vue3-script-setup/declaration-order': 'error' },
}).append({
  files: ['scripts/**/*.{js,mjs,cjs}'],
  rules: { 'no-console': 'off' },
})

export default config
