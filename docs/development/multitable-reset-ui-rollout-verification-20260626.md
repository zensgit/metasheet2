# T8-2 Reset UI rollout — development & verification

Grounding: `origin/main` 2026-06-26, after the Reset capability (T8-2) merged and its staging acceptance passed. This
records the **Reset UI rollout** (#1 acceptance harness → #2 UI foundation) and what remains a decision, not a build.

## 0. Where the line stands

| Piece | State |
|---|---|
| T8-2 Reset runtime (single-tx, default-off flag) | **merged** (#3214) — staging-accepted |
| record-history `hasMore` keyset | **merged** (#3217) |
| Reset acceptance harness + runbook (#1) | **merged** (#3232) + (d)-fix (#3248) |
| Reset UI design + model correction | **merged** (#3239, #3251) |
| Reset UI **foundation** (signal + client + inert dialog) (#2) | **#3250** — [P1]/[P2] green, in merge |
| Reset UI **entry wiring** | **blocked on a T-source product decision** (§3) |
| undelete-execute · T9-W data-loss | **gated** on item-specific sign-off |

## 1. Rollout #1 — acceptance harness (merged)

`packages/core-backend/scripts/reset-acceptance.mjs` + runbook: one-click staging proof of the flagged Reset, asserting
every gated code with PASS/FAIL. **Owner-run staging result: PASS** — flag-off inert (`RESET_DISABLED`); flag-on (b)–(g)
green (editor→403, no-confirm→400, locked→409 `RESET_BLOCKED`+zero-writes, drift→409+nothing-deleted, happy→post-T
soft-deleted + survivors reverted); trash confirmed (post-T records recoverable, `deleted_by`=admin). The (d) lock
scenario needed editor-held locks vs admin-reset to actually exercise the block — fixed in #3248.

## 2. Rollout #2 — Reset UI foundation (#3250)

**Backend signal** — `/context` serializes `pitResetEnabled = (MULTITABLE_ENABLE_PIT_RESET on) && canManageSheetAccess`
(flag-derived + cap-gated), so the FE can *truly hide* the Reset entry when off (no phantom client flag read). Added to
the `MultitableCapabilities` OpenAPI schema + regenerated dist/SDK.

**API client** — `MultitableApiClient.resetPreview` / `resetExecute` (execute body `{ asOf, previewIdentity,
confirm:'reset' }`).

**`ResetConfirmDialog.vue`** (inert — not yet rendered) — preview → **typed two-step confirm** (`canConfirm =
hasIdentity && typed==='reset' && ackCount`) → execute. Hard copy: "moves the N records created after T to the **recycle
bin** — recoverable, **not** a normal restore; use **Revert** to keep them." `deleteCount===0` → non-destructive path.
Gated codes → clear copy (403/409 `RESET_BLOCKED`/409-drift/413/400). Modeled on `RestorePreviewDialog.vue` (the design's
"mirror the Revert panel" was wrong — sheet-wide Revert is operator/API-only; corrected in #3251).

## 3. Remaining: the T-source picker (PRODUCT DECISION — not built)

The Reset UI needs a selected `asOf` (T) to act on. The whole sheet-wide restore line (Revert + Reset) is
operator/API-only — there is **no point-in-time picker** in the workbench, so the inert dialog has nothing to mount
against. "Reset to *which* T?" is a product/UX decision, deliberately not guessed.

**Recommendation** (for the decision, not yet built): mount Reset as the **destructive sibling of the existing Global
History / point-in-time surface** — the user opens the history timeline, lands on a T (the same `asOf` the point-in-time
read already uses), and triggers "Reset to this point" from there, gated on `pitResetEnabled`. This reuses the one place
in the product where a point-in-time T is already a first-class concept, rather than inventing a free-floating date
picker. On your confirmation, wiring the entry is a small slice: a `pitResetEnabled`-gated action on that surface that
opens the ready `ResetConfirmDialog` with the selected `asOf`.

## 4. Verification

- **Acceptance:** owner-run staging harness — flag-off + (b)–(g) all PASS; trash recoverability confirmed by hand.
- **FE:** `multitable-reset-confirm-dialog.spec.ts` **6/6** (entry-hidden-when-!pitResetEnabled · typed+count double-gate
  · hard copy names recycle-bin/count/Revert · mount→preview→confirm→execute wire with `confirm:'reset'`+previewIdentity
  · `deleteCount===0` skip). vue-tsc 0.
- **Backend contract:** `multitable-context.api.test.ts` **22/22** incl. a route-level golden (flag-ON+admin →
  `pitResetEnabled:true`; flag-off / non-admin → false) — the new FE signal is contract-locked. tsc 0.
- **OpenAPI:** `contracts (openapi)` green — base.yml + regenerated `dist/combined.openapi.yml` + SDK carry
  `pitResetEnabled` (the gate rebuilds + diffs the dist).

## 5. Bottom line

Reset is a complete, staging-accepted capability with an inert, verified UI foundation and a contract-locked signal on
main. The only path to a **user-facing** Reset button is the T-source picker in §3 — a product decision, with a concrete
recommendation ready to build on your word. undelete-execute and T9-W data-loss remain gated on sign-off. Nothing else
on this line is buildable without one of those two decisions.
