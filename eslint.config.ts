import antfu from '@antfu/eslint-config'
import type { Linter } from 'eslint'

const config: Promise<Linter.Config[]> = antfu({
  unocss: true,
  typescript: true,
  vue: true,
  plugins: [],
  formatters: true,
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
    'vue/block-order': 'off',
    'vue/component-name-in-template-casing': 'off',
    'vue/require-default-prop': 'off',
    'eslint-comments/no-unlimited-disable': 'off',
  }
}).append({
  files: ['scripts/**/*.{js,mjs,cjs}'],
  rules: { 'no-console': 'off' },
})
// AIRUNNER-BATCH45-NO-CONSOLE-CLI: CLI 脚本允许 console 输出（antfu composer .append 形式）

export default config
