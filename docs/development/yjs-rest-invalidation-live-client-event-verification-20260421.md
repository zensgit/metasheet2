# Verification - Yjs REST Invalidation Live Client Event

- Branch: `codex/yjs-invalidation-event-20260421`
- Date: 2026-04-21
- Linked development MD:
  `docs/development/yjs-rest-invalidation-live-client-event-development-20260421.md`

## Focused Backend Verification

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/yjs-awareness.test.ts \
  tests/unit/yjs-rest-invalidation.test.ts \
  --reporter=verbose
```

Result:

```text
Test Files  2 passed (2)
Tests       12 passed (12)
```

Coverage:

- Existing REST -> Yjs invalidation regression still passes.
- `invalidateDocs()` still evicts in-memory docs without snapshotting stale
  content.
- `YjsRecordBridge.cancelPending()` still prevents debounce re-materialization.
- New `notifyInvalidated()` event is delivered to sockets subscribed to
  `yjs:<recordId>`.
- Connected but unsubscribed sockets do not receive `yjs:invalidated`.

## Focused Frontend Verification

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/yjs-document-invalidation.spec.ts \
  tests/yjs-document-stale-guard.spec.ts \
  tests/multitable-yjs-cell-binding.spec.ts \
  --reporter=verbose
```

Result:

```text
Test Files  3 passed (3)
Tests       8 passed (8)
```

Coverage:

- Current-record `yjs:invalidated` disconnects the socket, destroys the local
  Y.Doc, clears connected/synced state, and leaves an explicit invalidation
  error.
- Other-record `yjs:invalidated` events are ignored.
- Existing stale-connect guard and cell-binding fallback behavior still pass.

## Wider Yjs Regression

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/yjs-text-field-diff.spec.ts \
  tests/yjs-text-field-seed-guard.spec.ts \
  tests/yjs-document-stale-guard.spec.ts \
  tests/yjs-document-invalidation.spec.ts \
  tests/yjs-awareness-presence.spec.ts \
  tests/multitable-yjs-cell-binding.spec.ts \
  tests/multitable-yjs-cell-editor.spec.ts \
  --reporter=dot
```

Result:

```text
Test Files  7 passed (7)
Tests       34 passed (34)
```

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/yjs-poc.test.ts \
  tests/unit/yjs-hardening.test.ts \
  tests/unit/yjs-awareness.test.ts \
  tests/unit/yjs-rest-invalidation.test.ts \
  tests/unit/record-write-service.test.ts \
  --reporter=dot
```

Result:

```text
Test Files  5 passed (5)
Tests       71 passed (71)
```

## Typecheck And Build

Command:

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result:

```text
EXIT=0
```

Command:

```bash
pnpm --filter @metasheet/core-backend build
```

Result:

```text
tsc
EXIT=0
```

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

```text
vue-tsc -b && vite build
✓ 2351 modules transformed.
✓ built in 5.21s
EXIT=0
```

The production build emitted only the existing non-Yjs assets in the default
flag-off configuration; no `useYjsDocument-*`, `useYjsTextField-*`, or `yjs-*`
runtime chunk was produced.

## Decision

Code-level verification is green. The next required validation after merge is a
staging manual check:

1. Open the same text cell through Yjs in one browser.
2. Update the same record field through REST or another non-Yjs editor path.
3. Confirm the Yjs editor receives invalidation, disconnects, and falls back to
   REST instead of continuing to edit the stale Y.Doc.
