# DingTalk Notify Template Governance Package Verification 2026-04-20

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
```

## Results

- Frontend tests: `37 passed`
- Web build: `passed`

## Verified Package Behavior

- DingTalk group message authoring supports:
  - presets
  - token insertion
  - summary preview
  - syntax warnings
  - rendered examples
  - copy actions
  - unknown-path warnings

- DingTalk person message authoring supports:
  - presets
  - recipient picker
  - token insertion
  - summary preview
  - syntax warnings
  - rendered examples
  - copy actions
  - unknown-path warnings

## Deployment

- No remote deployment
- No migrations
