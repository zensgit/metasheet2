# Approval Handler Insert Menu Development Report - 2026-09-05

**Status:** DRAFT / HOLD. This report records a bounded implementation candidate. It does not authorize Ready, merge, feature-flag changes, dispatch, deployment, staging, production, database access, or tenant UAT.

## Authority and objective

The ratified authority remains `docs/development/approval-lock3-handler-node-20260817.md` section 1.5: the handler is the fifth node type available from the Canvas edge-insert menu. This candidate does not add a node type, graph command, runtime policy, or persistence shape. It closes two presentation defects in that already-authorized menu:

1. place Handler immediately after CC, before both branch actions;
2. make the existing `Tickets` icon visible by supplying the missing handler background token used behind the shared white icon foreground.

The resulting menu order is Approval, CC, Handler, Condition branch, Parallel branch.

## Bounded design constraint

The Canvas edge-insert menu groups participant node actions before structural branch actions. Within that group, the stable order is Approval, CC, then Handler. Handler keeps the existing `Tickets` glyph and receives the established informational color token as its icon background. This constraint changes presentation only; it does not change insertion commands, graph validity, persisted node shapes, runtime resolution, or the semantics of either branch action.

## Exact candidate snapshot

- PR: #5473, Draft/HOLD
- exact code evidence head: `3bc9c4ae218bfbdbccfaf4ffa70a3d36dd6e633b`
- ordered merge parents: `ad8b30548caab3b0de8a74d75220f7e93c115877`, then `70dc72d7671cad9cea1925ed93f90d3d9c746aeb`
- tree: `881c0abb11e4d4e9af96b6a591aa84760de5bdf1`
- relative-main file census: exactly two files
- report-only child: intentionally not self-referenced; it requires its own exact-head CI after publication

## Product and test delta

1. `apps/web/src/approvals/components/ApprovalFlowCanvas.vue`
   - moves the existing handler menu button directly after CC;
   - retains the existing `<Tickets />` icon;
   - adds `.template-authoring__canvas-edge-insert-icon.is-handler { background: var(--el-color-info); }`.
2. `apps/web/tests/approval-flow-canvas-a11y.test.ts`
   - pins the handler test id, business label, `Tickets` icon, and visible background rule;
   - pins `CC < Handler < Condition` source order without relying on positional DOM selectors.

No other candidate-owned file changes relative to `70dc72d7671cad9cea1925ed93f90d3d9c746aeb`.

## Current-main union

The replay from `ad8b30548...` to main `70dc72d...` was a zero-conflict true `--no-ff` merge. Both approval candidate blobs remained byte-identical to the prior reviewed head. The merge also retained, without manual editing, the four main-side stock-preparation files: one product view, one service module, one new spec, and the required-web selector update. This is a mechanical main union, not a docs-only main delta.

## Non-claims

- No staging or tenant UAT was run for this two-file candidate.
- No feature flag was changed or enabled.
- No backend, workflow, migration, database, branch-protection, dispatch, deployment, or production surface changed.
- This report does not declare the approval product or approval automation program FINAL.
- Terminal CI recorded for the code evidence head does not pre-approve the later report-only child.

## Advancement predicate

The code evidence head completed 21 checks successfully with one intentional Strict E2E skip and no failure or pending context. The report-only child must independently complete exact-head CI with no failure and the base must remain current before the PR may become eligible to request separate Ready/merge authorization. This report itself grants no Ready or merge authority.
