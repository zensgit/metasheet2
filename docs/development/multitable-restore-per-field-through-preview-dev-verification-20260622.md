# Restore Per-Field-Through-Preview 开发与验证 MD (slice 2)

> Owner-ratified T6 follow-up (2). Route a per-field (column-subset) restore through the same
> preview→confirm→execute chain as full-record, instead of the legacy direct `/restore`. A field subset is a
> FILTER of the single-record-version diff — folded into the `changesHash` — **not** a new identity scope.

## 1. The design (advisor pre-checked, owner-ratified)

- **No new scope claim.** The canonical `changesHash` is over `[fieldId, op, value]` per entry, so it already
  binds *which* fields change and *to what*. A different selection → a different filtered diff → a different hash
  → reject. Per-field stays inside record-version-v1; the T6-1 identity claims are untouched (the [P2] scope-lock
  is about MULTIPLE records — that's slice 3). The identity comment was updated to say exactly this (so it isn't
  the next stale line).
- **Filter-then-hash, symmetric at both routes (the load-bearing constraint).** `restore-preview` and
  `restore-execute` each: recompute the full diff → mask → **filter to `fieldIds` → hash the FILTERED result →
  (execute) verify**. The selection is folded into the hashed value at both ends, never trusted as a side input.
- **Probe-safe ordering:** mask *then* `fieldIds`-filter — a requested-but-hidden field is already gone before the
  selection, so no 403-vs-no-op oracle.
- **Empty handling:** an empty `fieldIds` array → **400** (schema `.min(1)`); a selection that nets zero changes
  (unchanged/hidden) → **no executable identity** — preview returns `previewIdentity: null`, and execute
  **verifies the identity FIRST**, so an arbitrary / foreign / forged token → **409 `PREVIEW_IDENTITY_INVALID`**;
  the empty-diff noop is reachable only AFTER a valid identity is consumed — never a `hash([])` executable token.
  (Corrected post-#3045 `d0c27aed`: the earlier "noop before consulting the identity" was the bug that PR fixed.)
- **FE:** the drawer already emits `fieldIds`; the client + workbench now carry it through preview→execute, and
  the legacy `restoreFieldsDirect` direct-`/restore` fallback is removed. Full-record and per-field share one path.

## 2. Verification

- backend `tsc` 0; `vue-tsc -b` 0; no migration.
- **9 per-field real-DB goldens**: happy path (preview [A] → execute [A] restores only A); **KEYSTONE** [A,B]→[A,C]
  reject; **full-identity → subset-execute reject** (the case that distinguishes filter-then-hash from verify-full
  — **mutation-proven**: hashing the full diff at execute makes it fail); subset → full-execute reject;
  order/dup-insensitive ([B,A,A] ≡ [A,B]); unchanged → no identity; hidden → no identity (masked before filter);
  empty array → 400 at both routes.
- **Existing suites unchanged-green:** `restore-preview` 6 + `restore-execute` 7 + `/restore` 35 = **48/48**, no
  assertion edits (the per-field path is additive; the full-record path is byte-identical).
- **FE web-guard (official filter): 321/321 across 32 files** (incl. the dialog spec, grid, history).
- **Slice-1 cleanup folded in:** the two stale "diff unify is a P3 follow-up" comments are removed.

## 3. Known pre-existing (NOT this slice)

The `multitable-workbench-*` specs (incl. `restore-wiring`) fail on a **shared scaffold error** (`Cannot read
'value'`) that is **pre-existing on `main`** — verified by stashing this slice's FE changes and re-running (still
17/17 fail). They are the "historical/flaky" specs the web-guard deliberately excludes, so they do not run in CI.
One consequence: `restore-wiring.spec.ts` is a wire-drift lock whose assertion (the *old* per-field-direct
`restoreRecordVersion` call) is now stale; it should be updated when that scaffold is fixed (a separate
pre-existing issue, out of this slice's scope).
