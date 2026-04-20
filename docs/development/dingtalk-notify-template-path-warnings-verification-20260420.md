# DingTalk Notify Template Path Warnings Verification 2026-04-20

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
```

## Results

- Frontend tests: `37 passed`
- Web build: `passed`

## Verified Behavior

- Syntax warnings still show for malformed placeholders such as `{{record-id}}`
- Unknown-path warnings now show for valid-but-unsupported placeholders such as:
  - `{{recoredId}}`
  - `{{record}}`
- Existing valid placeholders remain accepted:
  - `{{recordId}}`
  - `{{sheetId}}`
  - `{{actorId}}`
  - `{{record.xxx}}`

## Deployment

- No remote deployment
- No migrations
