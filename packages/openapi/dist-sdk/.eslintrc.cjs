module.exports = {
  extends: ['../../core-backend/.eslintrc.json'],
  env: {
    browser: true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: [
    'node_modules/',
    '*.js',
    '*.d.ts',
  ],
}
