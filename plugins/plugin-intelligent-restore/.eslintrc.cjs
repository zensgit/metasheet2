module.exports = {
  extends: ['../../packages/core-backend/.eslintrc.json'],
  env: {
    browser: true,
    es2022: true,
  },
  parser: 'vue-eslint-parser',
  parserOptions: {
    parser: '@typescript-eslint/parser',
    ecmaVersion: 2022,
    sourceType: 'module',
    extraFileExtensions: ['.vue'],
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
}
