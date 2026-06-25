# Global History remaining-dev (pass 2) — design & verification

## Current status after T8-2 ratification

- **T8-2 Reset-to-T** (destructive PIT restore — *soft-deletes* records created after T) is now ratified and implemented
  by #3214 behind `MULTITABLE_ENABLE_PIT_RESET` (default off). D1-D5 are no longer an open design gate: v1 is whole
  sheet only, `canManageSheetAccess` + flag gated, synchronous under `MULTITABLE_SHEET_REVERT_MAX_RECORDS`, typed
  `confirm:'reset'`, and preview-token-bound.
- **T9-W data-loss config ops** (field *undelete* / *lossy retype*) + **T8-1 undelete-execute** remain gated; they need
  the codebase-wide undelete/link-rebuild story first and are refused `422` today.

Production enablement of T8-2 remains an operational flag decision, not a code/design gap.

## What this pass DID complete (safe, non-destructive)

This pass closed the [P1] review findings on the prior pass, then completed the safe remaining items.

### Review fixes (the [P1]/[P2] from your review)
- **[P1] T9-W signed preview identity** (#3172): execute now requires a server-minted `previewToken` (JWT/HS256, binds
  sheet/revision/entity/baselineHash/actor + TTL) — a client-computable hash can no longer skip preview. 9 goldens
  incl. *computed-hash-without-token fails*. FE plumbs the token (#3169). *(Resolved a 3-way merge with main's view
  filterInfo redaction — the redaction is display-only and does not affect the token's raw baselineHash.)*
- **[P1] T8-1 gate + ceiling** (#3165, merged): gate `canManageSheetAccess` (above record-write, D2) + a hard
  `SHEET_REVERT_MAX_RECORDS` ceiling (`413` fail-closed, D3/PIT-6). Deny goldens: normal editor `403`, over-ceiling
  `413`.
- **[P2]** design-lock status corrected (#3172); the closeout MD records both fixes (#3170).

### Safe completions

> **Status correction (2026-06-25).** #3177 below was listed here prematurely — it is **NOT a completed/landed item.**
> As of this correction **#3177 is still OPEN with `multitable-web-guard` FAILING**, and **#3169 (FE) is also still
> OPEN** (with a blocking REQUEST-CHANGES: post-restore `onConfigReverted` doesn't reload sheet-meta/grid, so a revert
> looks successful while the field name / view filter / grid stay stale). The "Landing status" section below describes
> the *intended* dependency order, not what has actually merged.

- **R4 config-history polish** (#3177) — **OPEN; `multitable-web-guard` FAILING; not yet landed.** diff-rendering depth (`summarizeConfigValue` — compact `k: v` for config
  objects instead of raw JSON, config-only so no value masking) + an **end-to-end mount→button→fetch wire test**
  (clicks Revert→confirm, asserts the real `config-restore-preview` then `config-restore-execute` fetches fire with the
  server `previewToken`) — closing the wire-coverage gap flagged earlier. vue-tsc 0; spec 13/13.
- **BS-3.1 all-or-nothing batch restore** (agent-built, landing): an opt-in `allOrNothing` mode on the scoped
  batch-restore execute — if ANY target is denied/conflicted, the whole batch is rejected and nothing is written
  (vs the default partial-skip). Real-DB goldens incl. zero-write-on-block.

## Deferred (smaller, non-blocking — noted, not silently dropped)
- **Record-history projection `hasMore`** — needs the in-app LOCK-3 filter restructured (security-sensitive); left as a
  perf follow-up rather than rushed.
- **Base-level config history** — no base-config mutation chokepoints exist to wire today; needs its own investigation.
- cross-base data-sync, dashboards — parked off this line.

## Landing status
[P1]#2 #3165 + sub-features #3168 **merged**. Landing dependency-gated (this is the **INTENDED** order — corrected
2026-06-25 to live state, not all merged): #3172 (identity) → #3169 (FE — **OPEN**, blocking REQUEST-CHANGES) → #3177
(R4 polish — **OPEN, `multitable-web-guard` failing**) → #3170 (MD — **closed as superseded** by #3178/#3181). BS-3.1 +
this doc follow. Each new write path is mutation/trigger-proven, allow-and-deny.

## The honest bottom line
The read/preview/scoped-write/non-destructive arcs of the Global History / point-in-time restore line are complete and
hardened. The destructive Reset v1 is now built behind the default-off flag with PIT-2 / ceiling / preview-identity /
single-transaction atomicity goldens. Remaining work is no longer "build T8-2"; it is narrower:

- production rollout of `MULTITABLE_ENABLE_PIT_RESET` when an environment owner wants Reset enabled;
- T8-1 undelete-execute, which needs the cross-cutting resurrect + link-rebuild slice;
- T9-W irreversible config operations (field undelete / lossy retype), still design-lock-first;
- optional T8 scale extensions: async reset above the synchronous ceiling and permission-filtered subset reset.
