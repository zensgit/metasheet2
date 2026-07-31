# Approval Authoring and Data Closure Closeout Verification (2026-07-31)

**Status:** ENGINEERING CANDIDATE COMPLETE - not merged, deployed, tenant-tested, or enabled
**Design lock:** `approval-canvas-v2-development-plan-20260720.md` (ratified; 2026-07-31 reconciliation in section 16)
**Execution ledger:** `approval-authoring-data-closure-execution-ledger-20260721.md`
**Candidate head:** `1f92c6720`
**Runtime posture:** all related product flags remain default OFF

## 1. Verdict

The approval editor candidate now provides the core ordinary-user authoring experience requested for DingTalk/Feishu
comparison:

- a visual form builder with a draggable/clickable component palette, field canvas, typed inspector, reorder, and
  undo/redo;
- a vertical flow Canvas for linear, conditional, and parallel approval graphs, with edge insertion, semantic movement,
  branch priority, contextual configuration, keyboard alternatives, and fail-closed topology validation;
- version history with readable structural diff, synchronized before/current canvases, and restore-to-new-draft;
- embedded route preview that calls the existing backend saved-draft evaluator and highlights the matched Canvas path;
- stable desktop/tablet/mobile layouts with measured contrast, touch sizes, no tested horizontal overflow, and no
  sticky-header/action overlap.

This is an **engineering candidate**, not a production close. The entire editor remains on a stacked Draft PR series.
No merge, deployment, real-tenant UAT, or flag enablement is claimed.

## 2. Product comparison boundary

### Delivered in the candidate

| Area | Candidate behavior |
|---|---|
| Form design | drag or click components into the form; reorder by drag/keyboard; edit in the inspector |
| Flow design | tree-style Canvas; edge `+`; approval/cc/condition/parallel nodes; semantic move and branch reorder |
| Safety | typed commands, rollback on invalid drops, backend normalization authority, no raw JSON/IDs in normal UI |
| History | draft/version timeline, form/node/edge diff, synchronized graphs, restore as a new draft |
| Preview | sample-data route preview through the existing backend contract; no approval instance is created |
| Accessibility | non-drag command path, keyboard reorder/activation, focus return, live status, measured target sizes |
| Responsive | 1280px/1024px/390px browser evidence; form and Canvas surfaces stack without document overflow |

### Not claimed

- A visual clone of DingTalk or Feishu.
- Arbitrary free-line drawing or persisted node coordinates. The product intentionally uses semantic graph operations.
- Native-mobile flow construction, 100+ node virtualization, or unrestricted cross-region drag.
- New runtime node meanings such as handler nodes or within-node ordered approvers.
- New organization-derived approver sources beyond the already supported contracts.
- Production numeric FWB mapping. `number` remains fail-closed with `exact_number_mapping_unavailable`.
- Production readiness before merged-main verification, staging UAT, and the owner flag decision.

## 3. Findings closed in the final slices

| Finding | Severity | Resolution | Discriminating evidence |
|---|---|---|---|
| Version fence was checked after other bundle-derived reads | P2 | compare `expectedLatestVersionId` immediately after the same creation bundle loads | neutralizing the fence changes stale+invalid input from 409 to 400 |
| Preview disappeared when Canvas rendering was unavailable | P2 | retain the existing structured preview as a capability-preserving fallback | mounted fallback-condition mutant turns RED |
| Ambiguous/reconvergent route anchors could imply a false edge path | P2 | highlight nodes only and show a partial warning unless the graph path is unique | ambiguity mutant turns the focused test RED |
| Returned internal/user IDs could reach ordinary-user copy | P2 | sanitize labels and unresolved directory identities | raw-ID mutant turns the focused test RED |
| Compact header actions overflowed and sticky bars covered work | P2 UX | stable 3-column actions; static narrow navigation/actions; larger scroll margin | 390/1024 geometry and sticky-separation assertions |
| Active flow tab appeared low contrast during transition | P2 a11y | explicit primary state plus computed contrast gate | browser poll requires >=4.5:1 before capture |
| Mobile Canvas and preview controls were below the ratified target | P2 a11y | node/move actions >=40px; toolbar/branch-inspector/route-preview controls, including form controls, >=44px | per-control `getBoundingClientRect` assertions |
| Tablet steps navigation covered the authoring mode switch | P2 UX | make steps navigation static throughout the <=1024px stacked layout | 761/800/900/1024 geometry assertions prove zero intersection |
| Larger mobile controls could overlap the next graph node | P2 regression risk | retain semantic layout spacing and assert every linear node box is disjoint | ordered node rectangles have `next.top >= previous.bottom` |
| Version history card/date was only partly visible on phone | P3 UX | <=560px timeline becomes full-width vertical cards | date/card width assertions and mobile screenshot |
| Compact-desktop palette labels overlaid adjacent drag sources | P1 UX | keep a usable palette track until the workspace stacks, then use bounded five/two-column layouts | every palette item is >=80px and every label has `scrollWidth <= clientWidth` |

## 4. Exact-head evidence

### Frontend product path

- CI-equivalent Playwright real-browser workflow at `1f92c6720`: **15/15** (11 approval-designer scenarios plus four
  neighboring browser verifications).
- Focused frontend Canvas/form/version/preview suites at the preview head: **77/77**.
- Required Web Tests on the exact documentation tree over `1f92c6720`: **361 files / 4378 tests**.
- `vue-tsc --noEmit`: pass.
- Vite production build: pass. Existing unrelated chunk-size/dynamic-import warnings remain visible and were not
  misreported as errors.
- #4705 remote CI at `1f92c6720`: all four emitted checks passed (`approval-web-guard`, `attendance-web-guard`,
  `Multitable browser verify (chromium)`, and `pr-validate`).

### Backend preview contract

- Fresh real-PostgreSQL route-preview API suite: **11/11**.
- Stale-version, incomplete Canvas, no-existence-oracle, authorization, and values-free error legs remain covered.

### Browser geometry and visual evidence

The verification harness captures:

- `apps/web/verification-output/approval-designer-desktop.png`
- `apps/web/verification-output/approval-designer-tablet.png`
- `apps/web/verification-output/approval-designer-mobile.png`
- `apps/web/verification-output/approval-route-preview-canvas.png`
- `apps/web/verification-output/approval-route-preview-mobile.png`
- `apps/web/verification-output/approval-version-workspace.png`
- `apps/web/verification-output/approval-version-workspace-mobile.png`

Screenshots are visual evidence only. Contrast, overflow, target size, card visibility, sticky separation, and node
non-overlap are asserted from the browser DOM; downsampled image measurements are not accepted as geometry proof.

### Independent review

- Route-preview exact-diff re-review: APPROVE, no P1/P2 after the early fence and fallback fixes.
- Kimi visual critique found the sticky-header and mobile-target issues; both were reproduced or refuted with DOM
  geometry. The valid issues were fixed. Kimi is not the final correctness authority.
- The responsive/accessibility re-review at `1f92c6720`: APPROVE, 0 P1/P2/P3. It independently rendered every
  route-preview and inspector target class, neutralized their size rules, and observed the corresponding browser
  assertions turn RED.
- The first exact-tree browser run reused another reviewer-owned Vite process; that process exited after twelve tests,
  so the run was rejected as evidence. The full workflow was rerun with `CI=1` and an owned server and passed 15/15.

## 5. Merge and enablement gates

### Bottom-up merge order

1. #4642 -> #4649 -> #4652.
2. Form lane: #4657 -> #4696 -> #4699 -> #4700.
3. Flow lane: #4697 -> #4698 -> #4701.
4. Rebase #4702 onto both landed lanes and verify that only the integration delta remains.
5. #4703 -> #4704 -> #4705 -> this documentation PR.

Required checks must be recalculated after every rebase. A green stacked head does not transfer automatically to a
different merged-main tree.

### Merged-main gate

Before staging, rerun on the exact merged-main head:

1. the complete real-browser suite at 1280px, 1024px, and 390px;
2. required Web Tests and frontend/backend typechecks;
3. the real-DB route-preview API suite;
4. flag-OFF compatibility for legacy and Canvas-unavailable paths;
5. the broader approval/FWB/attachment matrix relevant to the deployed build.

### Owner UAT and flag gate

Staging UAT must cover component drag and click insertion, field reorder, condition/parallel authoring, semantic move,
undo/redo, version compare/restore, route preview, keyboard-only operation, and narrow layout. Capture baseline and
post-action screenshots plus the exact deployed SHA.

Only the owner may enable `APPROVAL_CANVAS_V2_ENABLED`, initially as a staged canary. Durable automation, Class A/Class
B, FWB, and attachment flags remain independent and cannot be enabled by this closeout.

## 6. Closeout disposition

**Engineering development:** complete on the Draft stack for the scope in section 2.

**Delivery:** open. Review, merge, merged-main verification, staging UAT, and flag enablement remain required.

This document may be marked production FINAL only after those owner/operations gates have real evidence. Until then,
the honest terminal state is **CANDIDATE COMPLETE / DELIVERY PENDING**.
