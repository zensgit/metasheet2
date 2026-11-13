# Rule editor draft preview fidelity - 2026-10-26

Status: Draft/HOLD; local gates qualified, public current-head required CI pending.

The current editor says it previews the current builder draft. On fresh main9bc,
AttendanceView.previewRuleSet sends both config and ruleSetId while editing.
The existing API intentionally uses a supplied saved ID to reload stored config.
Actual registered route over local HTTP, injected synthetic principal and SQL mocks
confirmed two controls (config-only and ID-only) plus saved-ID shadowing of the
simultaneously supplied draft. No provider, PG or business writes were executed.

## Scope

- The current editor's draft-preview request carries its displayed builder config
  and any existing valid sample events. It does not ask the API to reload a saved ID.
- Editing metadata and explicit Save/Update behavior stay unchanged.
- Existing API saved-ID preview, server organization/permission resolution, parser,
  writer and calculation behavior remain unchanged.
- The exported, currently unused-at-runtime composable's optional saved-ID preview
  interface is outside this narrow AttendanceView call-site correction.
- No new API, flag, domain, configuration, migration or rollout.

## Required gates

| Gate | State |
| --- | --- |
| Original actual route config-only / ID-only controls and shadowed draft | Observed on unchanged main function/route |
| Mounted new-unsaved positive control plus existing-edit failures | Qualified: original2 matching red +1control |
| Exact request config equals visible draft, optional events preserved, zero Save/Update | Qualified across phases:3unique cases; current parser unchanged |
| Editing context survives preview | Update mode/source retained; edit/save bytes unchanged; no fresh writer proof |
| Restore saved-ID payload mutation yields matching red |2matching red +1control; exact candidate restored |
| Scoped lint, existing preview/template neighbors, validate:all and web build | New-spec lint0;36guards/146admin neighbors;quality/build0. Full AV baseline17/current17, introduced0 |
| Actual main-entry saved-edit native preview, source-aware response | Enter and Space qualified across2phases;2readonly POSTs/0writers. Synthetic, not humanAT |
| Independent review, source hashes, Draft publication and exact-head CI | Sol/high source review accepted; hashes recorded; Draft publication/current CI pending |

All evidence stays synthetic and source/phase-bound. This is not human AT, full parent
acceptance, production, customer UAT, merge or deploy permission. All PRs stay Draft/HOLD.
R71/tag/release unchanged; Stream/lifecycle OFF; real UAT and business50004 excluded.
Historical08am PUT remains INCONCLUSIVE.

## Verification receipts

See [phase-bound verification](../../artifacts/attendance-rule-draft-preview-20261026/verification.json) and the [verification report](attendance-rule-draft-preview-verification-20261026.md). Earlier failed harness observations remain recorded rather than reclassified as successful whole runs.
