// ESLint 9 flat config
// 存量代码以「告警不阻塞」方式接入：规则多为 warn，CI 只拦 error。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '.ai-runner/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],

  // TypeScript inside <script setup lang="ts">
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    },
  },

  // CommonJS：拦截器、bin、.cjs 测试
  {
    files: ['**/*.cjs', '**/*.config.[jt]s'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
      },
    },
  },

  {
    rules: {
      // TS 自身负责未定义检查；any/非空断言在本项目存量代码中大量合理使用
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/ban-ts-comment': 'off',
      // 大文件存量风格问题先告警
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      'no-var': 'warn',
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'off',
      'vue/require-default-prop': 'off',
      'vue/html-self-closing': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/attributes-order': 'warn',
      'vue/no-unused-components': 'warn',
      'vue/no-unused-vars': 'warn',
      'vue/no-template-shadow': 'warn',
      'vue/prop-name-casing': 'off',
    },
  },
]
