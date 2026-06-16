# Record Restore — Per-Field Backend + Review-Hardening Closure (Development & Verification, 2026-06-16)

Closure report for the **backend** record-restore track. Extends, and should be read after,
`multitable-record-restore-layer1-design-20260615.md` and
`multitable-record-restore-layer1-dev-verification-20260615.md` (which cover full-record restore,
Slice 2a link restore, retention, and the PR #2654 review round). This document records the two
slices that landed after L1 — per-field (column-level) restore and the adversarial-review hardening —
and the audit that closes the field-existence probe class.

## 0. Lineage (all merged to `main`)

| Commit | PR | Slice |
|---|---|---|
| `ff3d1c655` | #2654 | Layer 1 — record-level version restore (full record) |
| `62f2ea9d3` | #2660 | Slice 2a — link-field restore + revision retention |
| `6ed4d9afc` | #2672 | Per-field (column-level) restore — backend |
| `73fd154c4` | #2677 | Adversarial-review fixes — schema-drift scope, per-field leak, link reorder (+ probe-closure + hardening) |

The **frontend** restore MVP (`#2662`, Slice 3) is OPEN and gated on owner real-app QA; per-field
checkbox UI is queued behind it. Both are out of scope for this backend closure.

## 1. What was built

**Per-field restore (#2672).** The restore endpoint
`POST /sheets/:sheetId/records/:recordId/restore` accepts an optional `fieldIds: string[]`. When
present, the faithful set∪unset diff (built over the whole current schema) is restricted to the
selected subset; the atomic concurrency + permission gate then runs over only that subset, so a caller
can restore the columns they picked even when another changed field in the revision is forbidden or
unselected. Absent `fieldIds`, behaviour is unchanged (full-record restore). Response shape is
identical in both modes: `{ ok, data: { recordId, newVersion, noop, restoredFieldIds[], skippedFieldIds[] } }`,
with `skippedFieldIds` always `[]` (the diff is atomic — nothing is partially written).

**Adversarial-review fixes (#2677).** Three real defects found by an independent review of #2672 were
fixed, plus the field-existence probe was closed and locked:

1. **Schema-drift scope (the probe).** The drift guard (a snapshot field id absent from the current
   schema ⇒ revision N cannot be faithfully reproduced ⇒ `422 SCHEMA_DRIFT`) is now scoped to
   **full-record restore only** (`if (!fieldIds) { … }`). In per-field mode an unknown/deleted requested
   id falls through to the empty selected diff and returns an identical `200` no-op. This removes a
   status-differential probe: previously a request for a since-deleted field that was still present in
   the target snapshot returned `422`, while a never-existed id returned `200`, letting an actor learn
   whether a now-deleted column existed in that revision. The earlier `driftScope = fieldIds ? … : …`
   intersection form (which reintroduced exactly this probe for deleted historical fields) is gone.
2. **Hidden-field response leak.** A requested field the actor cannot SEE (statically hidden, or
   layer-3 `visible=false`) is dropped by `canSeeField` **before** the `hasForbidden` gate, so an
   invisible-but-changed field returns the same `200` no-op as an unknown id rather than a `403`.
3. **Link-reorder spurious revision.** A pure reordering of a link field's ids is a no-op
   (`meta_links` is an unordered set); restore no longer emits a spurious version bump for it. Uses the
   canonical `normalizeLinkIds` + an order-insensitive `sameLinkSet` comparison.

## 2. Field-existence probe — adversarial audit (no leak)

Because the probe class recurred across review rounds, the per-field path was audited by four
independent adversarial lenses (status-code, response-body, equivalence, contract/coverage), each
tasked to **construct** a distinguisher rather than confirm safety. The threat model: can an
authenticated actor tell apart, by any observable (HTTP status, response body, error code/message),
these three per-field requests holding all else equal —

- **A** — `fieldIds:[X]`, X present in the target snapshot but DELETED from the schema since;
- **B** — `fieldIds:[Y]`, Y NEVER existed;
- **C** — `fieldIds:[Z]`, Z exists, changed in the revision, but is HIDDEN from this actor.

**Result: no distinguisher found.** All three collapse to an identical
`200 { noop:true, restoredFieldIds:[], skippedFieldIds:[] }`. A/B never enter the diff (not in the
current schema), C is removed by `canSeeField` before the forbidden gate; `skippedFieldIds` is
hardcoded `[]`, so no id is echoed back. The `403 RESTORE_FORBIDDEN` path is unreachable by A/B/C
since those ids never reach the gate. The full-record `SCHEMA_DRIFT 422` does name the missing field
id, but it lives on the no-`fieldIds` path that is deliberately retained, and full restore cannot
target a specific id — it is reviewer-endorsed behaviour, not a per-field probe.

## 3. Hardening (in #2677)

- **`T21` — full-body A≡B≡C lock.** One fixture, one actor (`USER_RO`); asserts the three probe
  responses are **byte-identical** (`toEqual` across all three `data` bodies) plus the exact no-op
  shape (`restoredFieldIds:[]`, `skippedFieldIds:[]`, `noop:true`), and that none mutated the record.
  This closes the gap that `T18` (A≡B) and `T19` (B≡C) left open: those assert only `status`+`noop` in
  separate fixtures, so a regression echoing a dropped/hidden id into `restoredFieldIds`/`skippedFieldIds`
  would have passed them.
- **Visibility-filter order invariant.** A do-not-reorder comment pins `canSeeField` ahead of the
  `hasForbidden` gate in the `selectedDiff` construction, so a future refactor cannot turn an
  invisible-but-changed field into a `403` and reopen the hidden-field probe.

## 4. Files changed

| File | Change |
|---|---|
| `packages/core-backend/src/routes/univer-meta.ts` | `fieldIds` per-field selection (#2672); drift guard scoped to `!fieldIds`, `canSeeField` filter precedes `hasForbidden`, `sameLinkSet` order-insensitive link compare, invariant-pin comment (#2677). |
| `packages/core-backend/tests/integration/multitable-record-restore.test.ts` | Per-field matrix (#2672); `T18` (per-field not blocked by non-requested drift + probe A≡B), `T19` (hidden≡unknown B≡C), `T20` (link reorder no-op), `T21` (full-body A≡B≡C lock) (#2677). |
| `packages/openapi/src/paths/multitable.yml` | `fieldIds` request body; documents that an unknown requested field is simply not restored (no `422`). |

## 5. Verification — commands and results

Run from the worktree with `DATABASE_URL` pointed at a real Postgres
(`postgresql://chouhua@localhost:5432/metasheet_restore_l1`):

```
# Type check (core-backend)
cd packages/core-backend && npx tsc --noEmit            → PASS (0 errors)

# Restore integration matrix (real DB)
pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/multitable-record-restore.test.ts   → 30 passed (30)
```

CI on #2677 (squash `73fd154c4`): all required checks green; merged at behind=0.

### Probe-lock tests (the closure-critical ones)

| Test | Locks |
|---|---|
| `T18` | Per-field restore of an available field is not blocked by a non-requested drifted field; full restore still `SCHEMA_DRIFT`s; deleted-in-snapshot id `≡` never-existed id (both `200` no-op). |
| `T19` | Requesting an invisible+changed field `≡` requesting an unknown id (both `200` no-op; no `403` existence/change leak); a visible+writable field still restores. |
| `T21` | Deleted-in-snapshot, never-existed, and hidden-changed probes return a **byte-identical** `200` no-op body (full `restoredFieldIds`/`skippedFieldIds`/`newVersion` equality). |

## 6. Scope notes / honest gaps

- **Static-hidden vs layer-3-hidden.** `T19`/`T21` exercise the layer-3 `visible=false` hidden case.
  The static `property.hidden=true` branch of `canSeeField` is covered by code (same equivalence class)
  but not separately asserted — left as-is; the invariant-pin protects it from refactor regressions.
- **Timing side-channel** was not measured; per-request work is near-identical (the diff loop runs over
  the whole schema regardless of the requested subset), and it is out of scope for an observable-body
  audit.
- **Type-change drift** remains partially covered (a missing field ⇒ `SCHEMA_DRIFT`; a field whose
  *type* changed since capture is caught fail-closed by the spine value validators ⇒ `VALIDATION_ERROR`,
  not `SCHEMA_DRIFT`) — precise type-at-capture is Layer 2. Unchanged from the L1 report.

## 7. Remaining (gated — not in this track)

- **Frontend restore MVP `#2662`** — OPEN, awaiting owner real-app QA before merge.
- **Per-field checkbox UI** — queued behind `#2662`.
- **Owner opt-in items** — retention activation (scheduler is shipped but disabled-by-default),
  partial-unique-index migration, `plugin-intelligent-restore` cleanup, Slice 2b undelete, Layer 2
  `MetaSnapshotService` (schema-at-capture). Each is a separate gated decision.

**Backend record-restore track: CLOSED.** Full-record + link + retention + per-field, with the
field-existence probe audited and locked.
