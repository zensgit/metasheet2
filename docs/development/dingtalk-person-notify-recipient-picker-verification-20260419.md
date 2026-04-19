# DingTalk Person Notification Recipient Picker Verification

- Date: 2026-04-19
- Branch: `codex/dingtalk-person-notify-20260419`
- Scope: searchable recipient picker for `send_dingtalk_person_message`

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
```

## Results

### Frontend

- `tests/multitable-automation-rule-editor.spec.ts`
- `tests/multitable-automation-manager.spec.ts`
  - `21 passed`

### Build

- `pnpm --filter @metasheet/web build`
  - passed

## Notes

- This slice intentionally reuses `listCommentMentionSuggestions` and does not introduce a new user-search backend route.
- The existing `Local user IDs` textarea remains in place so current payload shape and manual fallback are preserved.
- Web build still prints the existing Vite chunk-size warning; build still passes.

## Deployment

- None
- No remote deployment
- No migration execution
