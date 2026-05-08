# Integration Core Dead-Letter Open Mark Design - 2026-05-07

## Context

Dead-letter replay already checks `status === 'open'` before it runs the target write. The final bookkeeping call, `deadLetterStore.markReplayed()`, updated by tenant/workspace/id only.

That left a small race: another operator or worker could discard or replay the same dead letter after the read check but before the write mark. In that case the bookkeeping update could overwrite a non-open row back to `replayed`.

## Change

- Add `status: 'open'` to the `integration_dead_letters` update predicate in `plugins/plugin-integration-core/lib/dead-letter.cjs`.
- Return a clear `DeadLetterError` when no open row is updated.
- Add a direct store-level regression test showing a discarded row cannot be marked replayed and remains unchanged.

## Scope

This is a store-level guard. The runner's existing preflight status check remains unchanged and still gives user-friendly errors before any ERP write.

## Impact

- Open dead letters replay as before.
- Replayed or discarded dead letters cannot be rewritten by the final mark operation.
- Concurrent replay/discard races fail closed during bookkeeping instead of silently mutating a non-open row.
