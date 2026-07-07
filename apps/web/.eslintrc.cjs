module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2022: true,
  },
  parser: 'vue-eslint-parser',
  parserOptions: {
    parser: '@typescript-eslint/parser',
    ecmaVersion: 'latest',
    sourceType: 'module',
    extraFileExtensions: ['.vue'],
  },
  extends: [
    'eslint:recommended',
    'plugin:vue/vue3-recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      },
    ],
    'vue/attributes-order': 'off',
    'vue/multi-word-component-names': 'off',
  },
  overrides: [
    {
      files: ['src/components/plm/*.vue'],
      rules: {
        'vue/no-mutating-props': 'off',
      },
    },
    {
      files: ['tests/**/*.ts'],
      globals: {
        afterAll: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        describe: 'readonly',
        expect: 'readonly',
        it: 'readonly',
        vi: 'readonly',
      },
    },
    // UI foundation design-lock (docs/development/ui-foundation-design-lock-20260706.md §6
    // UF-6): "ESLint 禁 style=" scoped to the migrated UF surface set. `allowBinding: true`
    // only forbids the static `style="..."` attribute — it does NOT police `:style="{...}"`
    // bindings (several of these views legitimately compute layout via :style, e.g. the
    // TemplateAuthoringView canvas), matching the fs-source guard's scope
    // (tests/ui-foundation-style-guard.spec.ts). Note: apps/web's `lint` script invokes eslint
    // with an explicit file list that today only includes WorkflowDesigner.vue/
    // WorkflowHubView.vue from this set, so the ui-foundation-style-guard.spec.ts vitest gate
    // — not `pnpm lint` — is the CI-enforced check for the rest of the set; this override
    // still makes the rule active for IDE feedback and any future `pnpm lint` glob expansion.
    {
      files: [
        'src/views/approval/ApprovalCardDecisionView.vue',
        'src/views/approval/ApprovalCenterTable.vue',
        'src/views/approval/ApprovalCenterView.vue',
        'src/views/approval/ApprovalDetailView.vue',
        'src/views/approval/ApprovalMetricsView.vue',
        'src/views/approval/ApprovalMobileList.vue',
        'src/views/approval/ApprovalNewView.vue',
        'src/views/approval/DelegationSettingsView.vue',
        'src/views/approval/MyDelegationView.vue',
        'src/views/approval/TemplateAuthoringView.vue',
        'src/views/approval/TemplateCenterView.vue',
        'src/views/approval/TemplateDetailView.vue',
        'src/views/ApprovalInboxView.vue',
        'src/views/AutomationExecutionsView.vue',
        'src/views/WorkflowHubView.vue',
        'src/views/WorkflowDesigner.vue',
        'src/components/layout/PageHeader.vue',
        'src/components/layout/PageShell.vue',
        'src/components/status/StatusTag.vue',
        'src/multitable/components/MetaAutomationManager.vue',
        'src/multitable/components/MetaAutomationRuleEditor.vue',
      ],
      rules: {
        'vue/no-static-inline-styles': ['error', { allowBinding: true }],
      },
    },
  ],
}
