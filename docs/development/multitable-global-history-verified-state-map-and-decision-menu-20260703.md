# Multitable Global History / Version-Restore — verified state map + remaining-decision menu (2026-07-03)

**Status: line ESSENTIALLY COMPLETE.** Every substantive capability is built; the remainder is (a) one runtime wiring gap now fixed (PR #3541), (b) a set of stale design-doc *status headers* corrected here, and (c) a curated **owner-decision menu** (flag flips / product entries / irreversible-semantics sign-offs) plus one item that is honestly *impossible*. Nothing else is "just build it."

**Baseline:** re-assessed primary-source against `origin/main` (`17688041f`, 2026-07-03) via a 5-cluster parallel audit — every claim below is grounded in current code, not a prior draft. This doc is the authoritative current-reality view; where an older per-slice doc header still says "docs-only / NOT built," **this doc supersedes it** (see §2).

---

## 1. Progress — verified capability map

### 1.1 Record-level history + Layer-1 restore — **COMPLETE**
- Revision capture on create/update/delete (snapshot+patch+actor+source; `null`-sentinel removal; faithful after-image) → `record-service.ts` / `record-write-service.ts`; store `meta_record_revisions` (+ batch_id migration).
- Single-record history read + 3-layer field-mask (F1) → `GET …/records/:id/history`; real-DB `multitable-record-history-field-mask.test.ts`.
- Single-record restore with all **7 error codes** (VERSION_CONFLICT/NOT_FOUND, RESTORE_UNSUPPORTED, SNAPSHOT_UNAVAILABLE, SCHEMA_DRIFT, RESTORE_FORBIDDEN, VERSION_EXPIRED) + canonical-spine reuse (`source:'restore'` → Yjs invalidation) + faithful set∪unset diff; **per-field (column-level) restore** hardened against existence/change leaks.
- FE: record-history drawer + workbench `onRestoreRecordVersion` + preview-before-execute identity flow.
- Retention: `built-gated-off` (see §3 for the config-sweep wiring fix).
- **Gap:** record undelete (Slice 2b) — *missing by design* (owner-gated + data-model gap; §4c).

### 1.2 PIT (point-in-time) view / revert / reset / undelete — **COMPLETE** (destructive paths behind default-off flags)
- `reconstructRecordsAtT` (delete-aware, deterministic order) → read primitive.
- **T8-1 Revert-to-T** (non-destructive, zero-loss): always-on, `canManageSheetAccess`, preview-identity bound, operator/API-only by design.
- **PIT undelete-execute** (resurrect deleted records + rebuild outbound `meta_links`): `built-gated-off` (`MULTITABLE_ENABLE_PIT_UNDELETE`); all-or-nothing single-txn, id-collision 409, typed confirm; 14 goldens + acceptance harness (#3524). Inbound links re-materialize on next save (L4-A, intentional).
- **T8-2 Reset-to-T** (destructive: revert survivors + soft-delete post-T-created to trash): `built-gated-off` (`MULTITABLE_ENABLE_PIT_RESET`); all-or-nothing preflight, FOR UPDATE + version-CAS, fail-closed trash INSERT, ceiling 413, typed confirm; 12 goldens; recoverability confirmed (reset-deleted records restorable via `/records/:id/restore`).
- Preview-identity (scope+strategy-bound, re-enumerated at execute → 409/410) → `restore-preview-identity.ts`.
- FE: `ResetToPointPicker` + `ResetConfirmDialog`, `built-gated-off` (hidden unless `pitResetEnabled`).

### 1.3 Config/schema history + T9-W restore tiers — **COMPLETE** (5 tiers behind default-off flags)
- Config revision capture (`meta_config_revisions`, diff-first, txn-atomic, all 4 entity types) → `config-revision-recorder.ts`; 23 real-DB tests.
- Config-restore **safe subset** (field name/order + all view-config reverts): always-on.
- Five `built-gated-off` tiers: **sheet_config** revert (rowLevelRead/conditionalRead), **field-retype** (scalar-safe / lossless), **config-uncreate** (drop entity, typed confirm, no-oracle), **config-undelete** (definition-only recreate), **permission-revert** (de-escalation-only, live re-check inside `meta_sheets FOR UPDATE`). Each has a real-DB suite + design-lock.
- **Permission-writer serialization CLOSED** (#3402 forward routes + #3414 legacy route both take `meta_sheets FOR UPDATE`; §2 flipped CLOSED in #3418) — the earlier "un-serialized legacy writer" concern is resolved, verified primary-source.
- **Gaps:** lossy value-transform retype (§4c), field-undelete DATA recovery (§4d impossible).

### 1.4 Restore preview (T5) / scoped restore (T6) / diff-unify / batch-scope identity — **COMPLETE**
- T5 dry-run preview endpoints (record / PIT revert / PIT reset / config) — compute the masked would-be diff, write nothing, mint a preview-identity.
- T6 scoped/subset restore — field-subset (`fieldIds`) + multi-record `restore-batch-preview`/`-execute` (PARTIAL default + `allOrNothing` opt-in); per-record deny/version gates re-applied at execute. (Undelete-in-scope deliberately deferred.)
- Diff-unify — single shared `computeRecordRestoreDiff` (`record-restore-diff.ts`) consumed by all restore families; canonical link-set compare; golden-pinned.
- Batch-scope identity + no-side-channel — scope/resurrect/delete-set hashes bound into an actor-bound token, minted-at-preview + re-verified-at-execute (narrow/widen/alter → whole-batch 409); denied/missing share one `'unavailable'` skipReason (never in the hash); **2b trash-restore rule-deny** returns the exact same 404 shape as a missing record (no reveal callers in the restore range).

### 1.5 Global History Center (FE/IA) + flag-enablement readiness — **COMPLETE**
- `HistoryCenterModal` — read-only base-level timeline + filters (search/actor/source/action/date/field/all-tables) + cursor pagination + expandable per-record detail; always-on toolbar entry; 10 FE specs.
- Value-level before/after diff in the record drawer (cross-sheet center masks values by LOCK-3, by design).
- `MetaConfigHistoryModal` — config history read + Tier1/2 revert entry (the 3 destructive tiers have no FE — §4b).
- Flag readiness — staging smoke (#3448) + operator checklist (#3449) + read-only flag-status helper (with stop-conditions) + acceptance harnesses (reset + pit-undelete). All 7 flags remain default-off; no prod flag changed.

---

## 2. Stale design-doc statuses reconciled (the "还差哪些 vs the design MD" answer)

Several per-slice design-lock headers still read "DESIGN-LOCK, docs-only / runtime GATED / NOT built." Their **runtime shipped after the header was written** — the headers are stale, not the code. Corrected reality:

| Doc (header says…) | Verified reality on origin/main |
|---|---|
| `…remaining-dev-plan-20260625` §4a/§5 — undelete-execute "GATED, not built; two planned-and-gated" | PIT undelete-execute **BUILT** (#3307), default-off flag; only *enablement* is gated. (Corrected inline in that doc.) |
| `…t8-2-reset-ui-design-20260625` — "DESIGN ONLY — NOT built" | Reset-UI **BUILT** (#3301), default-off (`pitResetEnabled`). |
| `…t5-restore-preview` / `…t6-scoped-restore` / `…restore-batch-scope-identity` / `…restore-diff-unify` — "docs-only, runtime GATED" | All **BUILT** (routes + `record-restore-diff.ts` + `restore-preview-identity.ts` + unit tests). |

The `…gated-remainder-readiness-refresh-20260629` doc is **current** (it already records undelete built, reset-UI corrected, permission-revert inside `FOR UPDATE`); the only correction is that the permission-writer serialization is now fully CLOSED (#3402/#3414/#3418), so its "lock the legacy writer" prerequisite is done.

---

## 3. The one runtime gap found + fixed — config-revision retention wiring (PR #3541)

`startMetaRevisionRetention` scheduled only `sweepMetaRevisionRetention` (record revisions). `sweepConfigRevisionRetention` existed and was real-DB tested but was **never called by the scheduler**, so `meta_config_revisions` would grow unbounded even with retention enabled — contradicting #3168's "same policy as records / one knob ages both" intent. **Fix:** `runSweep` now runs both sweeps each tick, isolated, under the same flag/policy/interval, each keeping its never-delete-latest floor. **Verify:** unit test asserts one tick sweeps both tables (would fail pre-fix); `8/8` pass. Inert until `MULTITABLE_META_REVISION_RETENTION_ENABLED=1` (unchanged default-off).

---

## 4. Remaining = owner-decision menu (not "unbuilt features")

### 4a. Flag enablements — ops/rollout decisions (per-flag, staging→prod)
Seven default-off flags: `PIT_RESET`, `PIT_UNDELETE`, `SHEET_CONFIG_REVERT`, `FIELD_RETYPE_REVERT`, `CONFIG_UNCREATE`, `CONFIG_UNDELETE`, `PERMISSION_REVERT`. Four are staging-smoke-verified + FE-reachable; three (uncreate/undelete/permission-revert) are built but FE-less and un-smoked. **`PIT_RESET` carries a STOP-SHIP condition**: keep `META_REVISION_RETENTION` off (or set trash retention ≥ approval window) so revert-undo stays recoverable. Runtime-merged ≠ prod-enabled — each flag is a single-item owner go.

### 4b. Product-entry decisions
- History-anchored Reset T-source (snap T to a real change point) vs the current free `datetime-local` picker — deferred by #3301 for the owner to steer.
- FE for the 3 destructive config tiers (uncreate = permanent column drop; undelete = definition-only recreate; permission de-escalation) — surfacing irreversible ops to users is a product call.
- Optional: render the already-carried masked per-field `after` values as an inline diff in `HistoryCenterModal` (currently shows changed-field count).

### 4c. Irreversible-semantics slices needing explicit sign-off
- Lossy / value-transform field-retype revert (coerce/drop cell values) + property-only retype — needs a loss-oracle, preview↔execute loss-magnitude binding, write-symmetric cap. No flag yet.
- Forward field-value/link/auto-number **tombstone-capture** slice — to make *future* field deletes / lossy retypes value-recoverable (recovers no already-deleted data).
- Record undelete (Slice 2b) — resurrect a hard-deleted record + rebuild links; blocked on a capture gap (link edges hard-deleted, not in the delete snapshot) + irreversible semantics.

### 4d. Honestly impossible (record it, don't fake it)
- **Value-level undelete of already-deleted field-column data.** The field-delete path strips values (`data - $fieldId`) and hard-deletes links/sequences with **no tombstone** — the bytes exist nowhere, so no design recovers them. This is why config-undelete ships **definition-only**. Distinct from record-level restore (which has `meta_records_trash` + revision snapshots).

---

## 5. Verification methodology + honest gaps
- **Method:** 5-cluster parallel primary-source audit against `origin/main`; every capability classified built / gated-off / partial / missing with file:line evidence + gap-vs-design-lock. Two assessor claims were **overturned by direct verification** — the legacy permission route is already locked (#3414), and config-revision pruning intent was confirmed in-scope (#3168) — which is exactly why the map is grounded, not drafted.
- **PR #3541** unit-verified (8/8).
- **Honest gaps (carried, not hidden):** several PIT/config goldens are CI-registered but not locally re-run here; a "multi-resurrect forced-failure atomicity" golden and a cross-strategy token-rejection golden are recommended test-hardening (runtime is correct by construction); flag-on live smokes for the three un-smoked tiers are pending their enablement decision.

## 6. Bottom line
基本已完成。The Global History / version-restore line is functionally complete end-to-end; the one real runtime gap (config-revision retention scheduling) is fixed in PR #3541; the rest is a curated owner-decision menu — mostly per-flag enablement, a few product-entry calls, a small set of irreversible slices needing explicit sign-off, and one item that is genuinely impossible and recorded as such.
