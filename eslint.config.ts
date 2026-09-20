import antfu from '@antfu/eslint-config'

export default antfu({
  unocss: true,
  typescript: true,
  vue: true,
  plugins: [],
  formatters: true,
  rules: {
    '@typescript-eslint/no-unused-vars': 'warn',
    'no-console': 'warn',
    'vue/no-v-text-v-html-on-component': 'off',
    'perfectionist/sort-imports': 'off',
    'vue/comma-dangle': 'off',
    'style/comma-dangle': 'off',
    'style/jsx-quotes': 'off',
    'import/order': 'off',
    'antfu/if-newline': 'off',
    'style/brace-style': 'off',
    'vue/define-macros-order': 'off',
    'vue/block-order': 'off',
    'vue/component-name-in-template-casing': 'off',
    'vue/require-default-prop': 'off',
    'eslint-comments/no-unlimited-disable': 'off',
  }
})
