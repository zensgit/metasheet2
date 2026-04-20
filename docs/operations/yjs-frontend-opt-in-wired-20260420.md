# Yjs Frontend Opt-In — Wired (Companion Note)

Date: 2026-04-20
Branch: `codex/wire-yjs-text-cell-20260420`
Companion to: `docs/operations/yjs-internal-rollout-trial-verification-20260420.md`

## TL;DR

The frontend text-cell editor now has an opt-in code path that wires
`useYjsDocument` + `useYjsTextField` through to the actual `<input>` used
in `MetaGridTable`. The path is gated behind the build-time flag
`VITE_ENABLE_YJS_COLLAB=true` and is **off by default**. When off, the
cell editor behavior is byte-identical to what shipped before.

This closes the third finding from the monthly delivery audit
(`docs/operations/monthly-delivery-audit-20260420.md`, row "Yjs
collaborative editing" / audit PR #944 gap #4): the composables are no
longer orphan exports.

**This does NOT claim end-to-end user validation.** Backend pipeline is
validated (see `yjs-node-client-validation-20260420.md`), but a real
two-browser concurrent edit has still not been exercised. The opt-in
flag is intentionally off until someone runs an explicit POC session.

## What got wired

| Location | Change |
|---|---|
| `apps/web/src/multitable/composables/useYjsCellBinding.ts` | New composable. Reads `VITE_ENABLE_YJS_COLLAB`, owns connect timeout (`2500ms` default), owns fallback-to-REST on timeout/error. |
| `apps/web/src/multitable/components/cells/MetaCellEditor.vue` | Text (`string`, non-date-like) branch now binds `<input>` value to `yjsText` when `yjsActive`, otherwise to `modelValue` as before. Renders `MetaYjsPresenceChip` next to the input when there are other collaborators on the same field. Emits new `yjs-commit` event when the edit was carried over Yjs. |
| `apps/web/src/multitable/components/MetaGridTable.vue` | Passes `record-id` to cell editor, listens for `yjs-commit`, and suppresses the REST `patch-cell` emit when that exact cell was handled via Yjs. |
| `apps/web/tests/multitable-yjs-cell-binding.spec.ts` | New test file (4 tests): flag off → no io() call; flag set to `"1"` → no io() call; flag on + synced → Y.Text drives input + `yjs:update` emitted; flag on + timeout → fallback + disconnect, no further Yjs emits. |

No other cell types (number, date, select, boolean, link, attachment)
were touched. No record create/delete paths were touched. No backend
code was touched.

## How to enable it for testing

Build-time only (intentional — keeps the Yjs code tree-shakable from
production bundles):

```bash
VITE_ENABLE_YJS_COLLAB=true pnpm --filter @metasheet/web build
# or for dev server
VITE_ENABLE_YJS_COLLAB=true pnpm --filter @metasheet/web dev
```

Then, to verify it is actually live in a browser session:

1. Open a text cell in any grid view, start editing.
2. Open devtools Network panel, look for Socket.IO handshake under
   `/yjs` namespace.
3. Hit `GET /api/admin/yjs/status` — `activeDocCount` should increment
   while the cell editor is open and decrement on blur.
4. On a different browser (or second user), open the same record/field
   — both should see `MetaYjsPresenceChip` showing the other user.

If any of the above fails silently, the composable's `onFallback`
callback logs a `console.warn`. The REST submit continues to work
regardless.

## Fallback behavior (read before rolling out)

The composable is explicitly designed so that any Yjs failure
degrades to REST without user-visible breakage:

| Trigger | Result |
|---|---|
| `VITE_ENABLE_YJS_COLLAB` not `"true"` at build time | No `socket.io-client.io()` call. Editor behaves exactly as before. |
| Flag on, no JWT present | `useYjsDocument` surfaces `error = 'Not authenticated'`, composable enters fallback, editor keeps REST path. |
| Flag on, `/yjs` handshake never completes within `2500ms` | Composable times out, disconnects, enters fallback, editor keeps REST path. |
| Flag on, mid-edit socket disconnect | Composable enters fallback, editor keeps REST path (user's current text is preserved in `modelValue`). |
| Flag on, backend returns `yjs:error` | Composable enters fallback, editor keeps REST path. |

On each fallback reason other than `'disabled'`, a `console.warn` is
emitted (single line). User never sees a blocking error, user never
loses an edit — the REST patch path is still wired to the input's
`update:modelValue` events and still fires on `confirm` when Yjs was
not active for the cell.

## Reviewer-attention items

These are the places a reviewer should look closely, because they are
the places a regression would be silent rather than loud:

1. **Dual-write suppression** — when Yjs is active for a cell,
   `MetaGridTable.confirmEdit` MUST NOT emit `patch-cell`. If the
   `yjsHandledCellKey` comparison is broken (e.g. wrong key format),
   every Yjs-handled edit will also trigger a REST patch. Not
   corruption (idempotent), but defeats the purpose.
2. **Flag gating at the call site** — the flag check is in
   `useYjsCellBinding` **before** the `useYjsDocument` call. If anyone
   moves the flag check *inside* `useYjsDocument`, the composable's
   `watch(recordId, ..., { immediate: true })` will still fire on
   mount and attempt an `io('/yjs')` call even when the flag is off.
   The test `"flag off → no io() call"` catches this.
3. **Focus / blur lifecycle** — the composable ties to the parent
   component's lifecycle via `onUnmounted(release)`. Because the cell
   editor is `v-if`'d in/out by `isEditing(...)`, the composable's
   teardown runs whenever the user clicks out of a cell or presses
   Esc/Enter. If someone refactors the cell editor to stay mounted
   across edits (e.g. single persistent editor with dynamic target),
   `release` must also be called explicitly on blur to avoid leaking
   sockets.
4. **Character-level merge NOT shipped** — `useYjsTextField.setText`
   does `delete(0, length); insert(0, newText)` on every keystroke
   (last-write-wins, not CRDT-per-character). For this opt-in POC
   that's acceptable. A follow-up should diff `old` vs `new` and emit
   `insertAt` / `deleteRange` ops for real character-level merge.
   Until then, two simultaneous editors on the same cell will see
   replacement, not merge.
5. **Date-like string cells stay on REST** — `fieldIdRef` returns
   `null` for `isDateLike` strings, so the Yjs path never engages for
   them. Intentional: they render a `<input type="date">` which the
   Y.Text bridge has no meaning for.

## What still needs to happen (not in this PR)

- A real two-browser session with the flag on, captured as video +
  `/api/admin/yjs/status` samples, filed in
  `output/yjs-rollout/frontend-opt-in-<date>/`. This is the preflight
  step #1 per `docs/operations/poc-preflight-checklist.md`.
- If that session reveals edge cases in merge semantics, file as
  regression tests against the Node.js client validator first.
- Decision on whether to expose the flag as a user-level feature flag
  (runtime per-tenant) instead of build-time. Build-time is deliberate
  today because it tree-shakes the Yjs code path from production
  bundles that don't want it.

## Link back

Audit PR: #944 (gap #4 — frontend wiring).
Monthly audit: `docs/operations/monthly-delivery-audit-20260420.md`.
Preflight checklist: `docs/operations/poc-preflight-checklist.md`.
