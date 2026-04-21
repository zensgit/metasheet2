# DingTalk Notification Template Lint Verification

Date: 2026-04-20

## Commands Run

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
```

## Results

- `multitable-automation-rule-editor.spec.ts` + `multitable-automation-manager.spec.ts`: `33 passed`
- `pnpm --filter @metasheet/web build`: passed

## What Was Verified

- invalid placeholder syntax such as `{{record-id}}` surfaces a warning in the full rule editor
- unclosed placeholder braces such as `{{recordId` surface a warning in the inline automation manager
- valid template authoring flows remain intact
- both surfaces still build cleanly after the lint helper is introduced

## Runtime Alignment

Runtime template rendering in `packages/core-backend/src/multitable/automation-executor.ts` accepts dotted placeholder paths via:

- `{{recordId}}`
- `{{sheetId}}`
- `{{actorId}}`
- `{{record.xxx}}`
- and other `{{path.with.dots}}` forms that resolve through object lookup

The frontend lint therefore only warns on malformed syntax, not on arbitrary dotted lookup paths.

## Known Non-Blocking Noise

The frontend build still emits existing Vite warnings:

- dynamic import warning for `WorkflowDesigner.vue`
- chunk-size warnings

These warnings predate this change and did not block build success.
