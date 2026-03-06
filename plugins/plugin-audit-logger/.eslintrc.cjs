module.exports = {
  extends: ['../../packages/core-backend/.eslintrc.json'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
}
