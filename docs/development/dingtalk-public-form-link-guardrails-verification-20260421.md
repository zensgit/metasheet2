# DingTalk Public Form Link Guardrails Verification

- Date: 2026-04-21
- Target branch: `codex/dingtalk-public-form-link-guardrails-20260421`

## Verification Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/dingtalk-public-form-link-warnings.spec.ts tests/dingtalk-recipient-field-warnings.spec.ts tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
git diff --cached --check
```

## Results

- First focused test attempt before dependency install: failed with `Command "vitest" not found`.
- `pnpm install --frozen-lockfile`: passed.
- Frontend focused tests: `75 passed`.
- `pnpm --filter @metasheet/web build`: passed.
- `git diff --check`: passed.
- `git diff --cached --check`: passed.

## Focused Coverage Added

### Shared Public Form Link Warning Utility

`apps/web/tests/dingtalk-public-form-link-warnings.spec.ts`

- active public-form sharing returns no warning
- stale/missing view IDs warn
- non-form views warn
- unconfigured, disabled, missing-token, and expired public-form sharing warn
- both `expiresAt` and `expiresOn` are treated as expiry inputs

### Full Rule Editor

`apps/web/tests/multitable-automation-rule-editor.spec.ts`

- group DingTalk automation public-form selector warns when the selected form sharing is disabled

### Inline Automation Manager

`apps/web/tests/multitable-automation-manager.spec.ts`

- person DingTalk automation public-form selector warns when selected form sharing is missing a public token

## Notes

- `pnpm --filter @metasheet/web build` still emits existing Vite warnings about large chunks and a mixed static/dynamic import for `WorkflowDesigner.vue`; the build exits successfully.
- `pnpm install` produced local `plugins/**/node_modules` and `tools/cli/node_modules` noise; those files should not be staged.
