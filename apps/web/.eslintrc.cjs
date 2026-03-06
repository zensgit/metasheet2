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
    project: ['./tsconfig.app.json'],
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'coverage/',
    'src/auto-imports.d.ts',
    'src/components.d.ts',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
  },
}
