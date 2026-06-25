# T8-2 Reset-to-T (destructive PIT restore) — build-readiness + decisions for sign-off

> Status: **AWAITING EXPLICIT OWNER SIGN-OFF — NOT built.** The T8 design-lock (§5) requires Reset to have a *separate
> rollback-semantics sign-off, not just doc approval*. A re-issued `/goal` is not that sign-off. This doc resolves the
> §5 decisions (D1–D5) and proposes a flag-gated build, so the sign-off is a concrete yes/no rather than an open
> question. Nothing destructive ships until you approve this.

## Why this is gated and not auto-built

Reset is the one genuinely destructive capability in the whole Global History / point-in-time restore line: it **deletes records created after
T** (Revert keeps them). A bug here loses data. The line's discipline — and the [P1] review that just caught a T8-1
gate miss — say the destructive path gets an explicit, deliberate sign-off, not a broad "complete it." So this is
presented for decision, with the safe half (T8-1 Revert) already shipped (#3165).

## Reset = Revert + delete-post-T-created

Reset reuses everything T8-1 Revert built (the `reconstructRecordsAtT` target, the forward-revision write,
`source=restore` batch, the `canManageSheetAccess` gate, the size ceiling, PIT-3/LOCK-3 masking, PIT-7 reveal-non-
composition). It **adds one thing**: enumerating the records created after T and deleting them, under an all-or-nothing
preflight.

## Decisions to ratify (T8 design-lock §5)

- **D1 — ship Reset at all?** Recommend **yes** — it's the natural capstone. **There is no destructive code yet; the
  build awaits THIS sign-off.** On your yes I build it, and the runtime ships behind a default-OFF flag
  (`MULTITABLE_ENABLE_PIT_RESET`) as belt-and-suspenders so it's inert even post-build until explicitly enabled — but
  the flag is the *operational* gate *after* authorization, not a substitute for it. Revert stays the default,
  always-on path.
- **D2 — who may execute?** Recommend **`canManageSheetAccess`** (the sheet-admin cap T8-1 now uses), *plus* the flag.
  A dedicated `multitable:history-restore` capability is the eventual target but not a v1 blocker.
- **D3 — size ceiling + async?** Recommend **reuse the T8-1 `SHEET_REVERT_MAX_RECORDS` ceiling** (fail-closed `413`
  above it); **no async in v1** (async-above-threshold is a follow-up). Reset over the ceiling is refused, never
  truncated.
- **D4 — confirmation?** Recommend **a typed two-step confirm**: the execute body must carry an explicit
  `confirm: 'reset'` (or the deleted-count echoed back), so Reset cannot be triggered by a stray Revert call. Audit via
  the `source=restore` batch (actor / T / scope; never values).
- **D5 — scope?** Recommend **whole-sheet only** in v1 (a permission-filtered subset is a follow-up).

## The load-bearing lock (PIT-2) and how it's proven

**All-or-nothing permission preflight:** before ANY delete, EVERY post-T-created record to be deleted AND every record
to be reverted is permission-checked; if a SINGLE one is denied, the **entire Reset is rejected and nothing is
written** (no partial skip, no fail-halfway — unlike Revert, which may partial-skip). The proving golden is a
**mutation check**: drop one preflight check → a denied target slips into the destructive set → the test fails.

## Proposed verification (what the build would ship with)

Real-DB goldens: flag-off → Reset refused (inert); flag-on + whole-sheet Reset → post-T-created **deleted**,
pre-T-state reverted, forward revisions + `source=restore` batch written; **PIT-2 all-or-nothing blocks on any single
denial, zero writes** (+ the mutation check); above-ceiling → `413`; `confirm`-absent → refused; PIT-3 no count/
existence leak; PIT-7 reveal-non-composition. Plus a destructive-delete atomicity golden (a forced mid-write failure
leaves the sheet untouched).

## What I need from you

A yes/no on **D1–D5 as recommended** (or your amendments). On a yes, I build T8-2 behind the default-off flag with the
goldens above, on the T8-1 branch/its successor, and present it for review before the flag is ever enabled in any real
environment.

## Adjacent destructive/irreversible items (same gate, same ask)

- **T9-W data-loss config ops** — field *undelete* (the column data is gone; honest "undo" is impossible) and *lossy
  retype*. Refused `422` today. These need the same explicit sign-off + likely the codebase-wide undelete slice first.
- **T8-1 undelete-execute** — pending that same cross-cutting undelete slice (resurrect + link-rebuild).
