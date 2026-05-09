# Multitable Yjs Contract Verification

- Date: 2026-05-05
- Branch: `codex/multitable-yjs-contract-20260505`

## Verification Plan

1. Run the new Yjs contract parity gate.
2. Run the existing backend Yjs socket unit tests.
3. Run the existing frontend Yjs composable tests.
4. Check formatting/whitespace with `git diff --check`.

## Commands

```bash
pnpm verify:multitable-yjs:contract
pnpm --filter @metasheet/core-backend exec vitest --config vitest.config.ts run tests/unit/yjs-awareness.test.ts tests/unit/yjs-hardening.test.ts --reporter=dot
pnpm --filter @metasheet/web exec vitest run tests/yjs-awareness-presence.spec.ts tests/yjs-document-invalidation.spec.ts tests/multitable-yjs-cell-binding.spec.ts --reporter=dot
git diff --check
```

## Results

| Gate | Result |
| --- | --- |
| `pnpm verify:multitable-yjs:contract` | PASS, 2 tests |
| Backend focused Yjs tests | PASS, 2 files / 10 tests |
| Frontend focused Yjs tests | PASS, 3 files / 10 tests |

The frontend Vitest run emitted the existing `WebSocket server error: Port is already in use` warning, but exited successfully.

## Expected Coverage

- Contract event names match backend `YjsWebSocketAdapter`.
- Contract event names match frontend `useYjsDocument`.
- Auth and permission errors remain documented and guarded.
- REST-write invalidation stays `reason: "rest-write"`.
- Existing backend and frontend Yjs behavior tests keep passing.
