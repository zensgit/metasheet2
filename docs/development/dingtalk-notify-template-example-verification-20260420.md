# DingTalk Notify Template Example Verification 2026-04-20

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
claude -p "Reply only with OK."
```

## Results

- Frontend tests: `33 passed`
- Web build: `passed`
- Claude Code CLI availability check: `OK`

## Verified Behavior

- DingTalk group message summaries show:
  - raw title/body templates
  - rendered title/body examples
- DingTalk person message summaries show:
  - raw title/body templates
  - rendered title/body examples
- Rendered examples resolve sample token data such as:
  - `{{recordId}} -> record_demo_001`
  - `{{record.xxx}} -> 示例字段值`

## Non-Goals Confirmed

- No backend changes
- No migration changes
- No remote deployment
