# Time Machine remaining-dev push (T9-W + T8-1 + sub-features) — design & verification

Status: **built and landing.** This documents the development that completed the remaining work on the Global History
/ Time Machine line after the read side closed (record history T1–T7 + config history T9 R1–R4 shipped). It carries the
line from *read the past* into *write the past* — the config-restore and the non-destructive table-restore — plus two
deferred sub-features, while keeping the destructive subset gated behind its own sign-off.

PRs: T9-W backend #3164 · T9-W FE #3169 · T8-1 Revert-to-T #3165 · sub-features (retention + hasMore) #3168.

## 0. What was complete before this push, and what remained

Shipped: record-data history + masked read (timeline, batch detail, audit-grant reveal), restore preview (single +
batch), the scoped record-restore writes, the as-of-T reconstructor, T7's point-in-time read-only view; config history
recording (R1/R2), read API (R3), and the FE view (R4). The remaining work was the **write halves and the destructive
arc**: config-restore (T9-W), point-in-time table restore (T8), and a handful of deferred sub-features. This push
delivers the **safe** subset of those; the destructive pieces stay gated (§5).

## 1. T9-W — config / schema-change restore (the config write half)

### Design (design-lock: `multitable-t9w-config-restore-design-lock-20260624.md`)

A config-restore reverts a recorded `meta_config_revisions` change **forward** — re-applies its `before` state as a
new change, never rewriting history. The dangerous parts and the locks that answer them:

- **No mixed config+data restore (L2)** — touches only config tables; restoring a deleted field never resurrects its
  cell data. Data history stays the record line's job.
- **Read-gate ≡ write-gate ≡ restore-gate (L3)** — restore re-checks, per entity type, the same capability the
  mutation route checks (field/field-perm → `canManageFields`; view/view-perm → `canManageViews`;
  sheet_config/sheet-perm → `canManageSheetAccess`).
- **Preview-first + signed preview identity (L4/D5)** + **schema-drift is a conflict (L5)** — a write-free preview
  computes the revert and mints a **server-signed token** binding {sheet, revision, entity, baseline-hash, actor};
  execute REQUIRES + verifies it, so a caller cannot skip preview by computing the (client-computable) hash itself.
  Execute refuses if the live config moved since preview (stale token) or diverged from what the change produced
  (drift). *(The signed token was a review fix-forward, #3172 — the initial pass shipped only the raw hash.)*
- **Forward-only + `source=restore` (L1)** — execute appends a new revision marked `source=restore` with a
  `restored_from_id` back-reference; the restore is itself inspectable.
- **Data-loss ops hard-gated (L6)** — field undelete and lossy retype are refused `422` in this slice; they are a
  separate sign-off (the config analogue of T8 Reset).
- **Atomic + idempotent (L7)** — the config write and the restore revision commit together; a replay after a revert is
  rejected (the baseline no longer matches).

**v1 safe subset:** field `name`/`order` reverts + all view config reverts (display-only, non-lossy). Everything else
gated.

### Verification

- **Backend** (#3164): 9 real-DB goldens — preview write-free; revert restores prior config + records `source=restore`
  (L1); **gate-deny mutation-proven** (neuter the per-entity gate → the deny golden fails); gated-op `422` (L6);
  stale-preview `409` (L4); drift + idempotency `409` (L5/L7); view config revert; **ATOMICITY** (a trigger-injected
  failure on the restore-revision insert rolls the config write back, L7). `tsc` clean; allowlisted.
- **FE** (#3169): 11 jsdom specs — each *update* row gets a **Revert** action → preview → confirm rendering
  `target←current`; `opKind==='gated'` shows the reason and offers no confirm; `driftConflict` disables confirm with a
  warning; on confirm executes with the preview's baseline hash. **Faithful client** — the gated/drift/safe decision is
  the server's, rendered as-is, never a client cull — locked by a `getConfigRestorePreview` envelope wire-test. `vue-tsc`
  0; in the web-guard.

## 2. T8-1 — Revert-to-T (the non-destructive table restore) (#3165)

### Design

"Roll the whole sheet back to T," non-destructive: undo post-T changes + (classify) post-T deletions, but **KEEP
records created after T**. Built over the existing primitives — `reconstructRecordsAtT` (PIT-4: the as-of-T state map
IS the revert target; no re-derivation), the scoped-restore write path, and a new PIT revert preview-identity.

Locks honored: PIT-1 preview-first + identity binding the full revert set (drift → `409`); **D2 — gated on
`canManageSheetAccess` (a sheet-admin cap ABOVE plain record-write; interim for a dedicated history-restore cap), so a
normal record editor cannot trigger a sheet-wide rollback**; **D3/PIT-6 — a hard record-count ceiling
(`MULTITABLE_SHEET_REVERT_MAX_RECORDS`), above which the revert is REFUSED `413` fail-closed before the scan** (async
above threshold is a follow-up); PIT-3/LOCK-3 masked counts via the tested `loadDeniedRecordIds` +
`maskStoredRecordFieldIds` seam (denied rows uncounted, unwritten); PIT-5 forward-only `source=restore`; PIT-7
reveal-never-composes (grep-verifiable + golden). *(The D2 gate-elevation + D3 ceiling were a review fix on #3165 — the
initial pass gated on `canEditRecord` with no ceiling.)*

### Verification

8 real-DB goldens — preview classify + write-free; execute reverts to the T-state via forward revisions and **KEEPS
post-T-created**; drift → `409`; atomicity (forced failure leaves data unchanged); PIT-7 no-reveal; **a normal record
editor → `403`** (D2) and **a sheet above the ceiling → `413`** (D3/PIT-6). `tsc` clean; allowlisted.

**Deferred (flagged, not dropped):** undelete-*execute* — the codebase defers undelete everywhere (resurrect +
link-rebuild is its own cross-cutting slice), so preview classifies undeletes but execute reports
`undeleteSupported:false`.

## 3. Sub-features (#3168)

- **Config-revision retention (T9 D4):** `sweepConfigRevisionRetention` mirrors the record-revision sweep — same policy
  knobs (one knob set ages both; disabled by default), prunes `meta_config_revisions` per `(sheet_id, entity_type,
  entity_id)`, **always keeps the latest per entity** (current config stays inspectable + revertible), bounded per
  pass. 4 real-DB goldens (disabled no-op; keep-last-n past the `MIN_KEEP_N` floor; keep-days keeping an old latest;
  batch bound).
- **Config-history `hasMore`:** the R3 list returns `hasMore` via a `limit+1` peek (cheap — the per-entity gate is in
  the WHERE clause, so the peek is gated too and can't leak a denied row), avoiding a COUNT over the gated set. Golden:
  true on a partial page, false when all fit, gate-respecting.

## 4. Verification summary — the full line under test

Config side: R1 16 recording + R2 4 transaction-consistency + R3 8 gate (+1 hasMore) goldens + R4 6 FE specs +
**T9-W 9 restore goldens + 11 FE specs + retention 4**. Data side: the prior T1–T7 suites + **T8-1 6 revert goldens**.
Every new write path is mutation- or trigger-proven, not allow-only-green.

## 5. What remains GATED / deferred (honest ledger)

- **T8-2 Reset-to-T** — the *destructive* table restore (also deletes post-T-created records). Designed (PIT locks),
  **not built**; needs its own rollback-semantics sign-off after Revert is proven.
- **T9-W data-loss config ops** — field undelete / lossy retype; and **permission + sheet_config reverts** (R-W2). All
  refused `422` today; each a separate gated slice.
- **T8-1 undelete-execute** — pending the codebase's cross-cutting undelete slice.
- **R4 polish remainder** — diff-rendering depth (nested permission rules / formula expressions), base-level config
  history (base permissions / automation), and a full workbench mount→button→fetch wire test (today the client-envelope
  round-trip is locked, not the full mount).
- **Record-history projection `hasMore`** — the original deferral (`history-projection.ts`); needs the in-app LOCK-3
  filter restructured, riskier — left as a perf follow-up.
- **BS-3.1** all-or-nothing batch-restore mode (parked); cross-base data-sync, dashboards (parked).

Each gated item is a separate explicit opt-in, design-lock first for the destructive ones — the same discipline the
whole line has followed.
