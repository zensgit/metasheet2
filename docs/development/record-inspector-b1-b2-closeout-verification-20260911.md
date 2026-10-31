# Record Inspector B1/B2 Verification Closeout

Evidence date: 2026-09-11. Scope and decision provenance: [development closeout](record-inspector-b1-b2-closeout-development-20260911.md). This report separates local tests, exact-head CI, actual merge trees, post-main replay and release authority. Counts below are executions, not a unique-test census.

## Immutable identities

| Slice | PR | Exact tested head | Actual merge |
| --- | --- | --- | --- |
| B1 | [#5632](https://github.com/zensgit/metasheet2/pull/5632) | `8ae716ed7bf5da17cd911f3366bdb05a62b68ee5` | `182f643f4465ba2556a06166c545d8a84e333281` |
| B2 | [#5635](https://github.com/zensgit/metasheet2/pull/5635) | `3dc64615e5766b759f998a6b467a02bef178900b` | `f68a9377b8c8c7e3c160e728823a3b9106d86b0e` |

Original heads retained: #5494 `c4da29de6146bb07afa65425db20b3c62cab6399`; #5495 `ab91dc94c0348cd9f2938e81b7b783037cd9264d`. Original PR metadata was not changed. The W2 merge #5585 (`a22955f83187602d09f787889c4e433fdc815107`) and subsequent #5488 closure do not substitute for B1/B2 independent decisions.

## Local evidence

| Check | B1 | B2 |
| --- | --- | --- |
| Focused suite | 7 files / 325 tests PASS | Final 8 files / 338 tests PASS |
| Required web | 17 groups / 551 file executions / 8260 tests PASS | 17 / 552 / 8313 PASS on final product code, before the final two test-only context cases |
| App vue-tsc | PASS | PASS |
| Publication guards | 8/8 PASS | No publication workflow delta |
| Scoped ESLint | Not a separately recorded B1 claim | 0 errors / 28 warnings |
| Diff check | PASS | PASS |

B2's final two context cases were included in the 338-test focused run and in remote 8315-test full runs. Do not describe local 8313 as the latest complete suite. Focused B2 files and counts: record-fields-panel 12, grid 62, record-inspector-field-errors 29, record-fields-sections 49, record-inspector-header 36, workbench-sheet-delete 9, workbench-import-create-fields 10, workbench-view 131.

Reproduction entrypoints on the matching candidate:

```sh
bash apps/web/scripts/run-required-web-tests.sh
pnpm --filter @metasheet/web exec vue-tsc --noEmit -p tsconfig.app.json
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/multitable-record-fields-panel.spec.ts \
  tests/multitable-grid.spec.ts \
  tests/multitable-record-inspector-field-errors.spec.ts \
  tests/multitable-record-fields-sections.spec.ts \
  tests/multitable-record-inspector-header.spec.ts \
  tests/multitable-workbench-sheet-delete.spec.ts \
  tests/multitable-workbench-import-create-fields.spec.ts \
  tests/multitable-workbench-view.spec.ts
```

## Adversarial evidence

- B1 N3 mutation removed property-hidden filtering: two ordered/hidden-in-view negatives failed, one property-visible positive passed. Source restored; all 49 section tests passed.
- B2 original combined tests passed 3 files / 197 before intersection fixes. Four collapsed/property-hidden/hide-empty/cross-record late-success regressions were reproduced and fixed.
- Same-field and A-B-A late success/failure probes produced four assertion failures before the ownership fix, while two cross-record controls passed. An earlier A-B-A selector TypeError was a fixture mistake and is excluded from regression evidence; corrected probes use the real grid expand action.
- Real-composable canary verifies two same-field requests reach fetch before either settles; the test does not assume request serialization.
- Mutating ownership to always-current produced 5 RED / 1 positive GREEN. Removing navigation ownership reset produced 1 RED / 1 positive GREEN. Removing the field-error hide-empty exemption produced 1 RED / 2 positives GREEN.
- All mutations restored before the final 338-test run. Positive controls distinguish stale-context rejection from suppressing every response.

These mutation results are local integration evidence, not a claim that all original-design mutations or every asynchronous path were rerun.

## Exact-head CI and actual test execution

| Gate | B1 exact head | B2 exact head |
| --- | --- | --- |
| Complete check rollup | 25 SUCCESS + 1 intentional Strict SKIP, no pending | 24 SUCCESS + 1 intentional Strict SKIP, no pending |
| Required checks | 13/13 SUCCESS | 13/13 SUCCESS |
| Plugin matrices/coverage | [34567944707](https://github.com/zensgit/metasheet2/actions/runs/34567944707), SUCCESS | [34571782813](https://github.com/zensgit/metasheet2/actions/runs/34571782813), SUCCESS |
| Domain | [34567944787](https://github.com/zensgit/metasheet2/actions/runs/34567944787), 3 calls / 289 file executions / 3558 tests | [34571782899](https://github.com/zensgit/metasheet2/actions/runs/34571782899), 3 / 290 / 3613 |
| Required web | [34567944540](https://github.com/zensgit/metasheet2/actions/runs/34567944540), 17 / 551 / 8260 | [34571782852](https://github.com/zensgit/metasheet2/actions/runs/34571782852), 17 / 552 / 8315 |

B1 section spec 49 and B2 field-errors 29 / Workbench 131 were observed in actual job logs. Both test entrypoints preserve per-call UNION: main 17 required groups / 3 domain calls; original child 14 / 2. Parsing included the NODE_OPTIONS-prefixed call that an initial counter omitted. YAML parsing also checked PR and push source/spec triggers.

Attendance-web-guard succeeded by its unrelated-changes short circuit; targeted steps were skipped. That success must not be cited as attendance test execution. Plugin matrix attendance execution is separate. Automated browser checks passed on the candidates, but no new manual viewport sweep, assistive-technology readout or UAT was performed.

## Actual merge-tree verification

B1 actual tree `0d4cf1a1bba767ce8d3018255f74866c136de09d` and B2 actual tree `535bc9a2afe97a366006ba34ea2c8c9fc1a264f9` matched their predictions. For each disjoint main drift, the first-parent binary patch equaled the tested candidate increment and all five intervening main blobs were identical. B2 contains actual B1 merge ancestry. The prediction itself did not have separate CI; candidate CI was reused on the proven disjoint increment, followed by actual-main checks below.

## Post-main replay and publication boundary

B1 merge `182f643f...`:

- [Docker 34570645121](https://github.com/zensgit/metasheet2/actions/runs/34570645121): backend/frontend builds SUCCESS; package identities, login, publication and deployment SKIPPED.
- [Deploy 34570645149](https://github.com/zensgit/metasheet2/actions/runs/34570645149): test SUCCESS; build-and-push and deploy SKIPPED.
- [Domain 34570645167](https://github.com/zensgit/metasheet2/actions/runs/34570645167) and [web 34570645136](https://github.com/zensgit/metasheet2/actions/runs/34570645136): SUCCESS.
- [Plugin 34570645073](https://github.com/zensgit/metasheet2/actions/runs/34570645073): CANCELLED after newer main arrived, not PASS. No manual rerun was initiated. B2 actual-main replay below is a later combined-tree run containing B1, not a retroactive PASS for the cancelled run.

B2 merge `f68a9377b8c8c7e3c160e728823a3b9106d86b0e`:

| Automatic run | Actual result |
| --- | --- |
| [Docker 34574900931](https://github.com/zensgit/metasheet2/actions/runs/34574900931) | SUCCESS; backend/frontend builds SUCCESS; package identity, GHCR login, publication and deploy SKIPPED |
| [Deploy 34574900911](https://github.com/zensgit/metasheet2/actions/runs/34574900911) | SUCCESS; test SUCCESS; build-and-push/deploy SKIPPED |
| [Domain 34574900933](https://github.com/zensgit/metasheet2/actions/runs/34574900933) | SUCCESS; actual logs 3 calls / 290 file executions / 3613 tests |
| [Web 34574900986](https://github.com/zensgit/metasheet2/actions/runs/34574900986) | SUCCESS; actual logs 17 groups / 552 file executions / 8315 tests |
| [Plugin 34574900963](https://github.com/zensgit/metasheet2/actions/runs/34574900963) | SUCCESS; Node 18/20 and four auxiliary jobs SUCCESS; coverage SKIPPED on this push run |

Both post-main web logs contain field-errors 29 and Workbench 131. Workflow names containing "Push" or "Deploy" are not evidence of publication/deployment: the actual publishing and deployment steps were skipped. No manual dispatch, publication, deployment, production operation, real-tenant operation, DB change or flag enablement was performed by this integration.

Final readback after 2026-09-11T08:07Z confirmed main still at `f68a9377b8c8c7e3c160e728823a3b9106d86b0e` and both original PR heads unchanged. These scoped results are not a claim about every repository workflow; independent nightly and monitoring work remains outside this packet.

## Review, process and remaining gates

Independent coordinator review found no P1/P2 blocker in the B1 integration and B2 rendering/lifetime intersections. It verified scope, preserved blobs/patches and entrypoint unions. It was not a new full-product review, and the coordinator did not independently rerun the added local tests. No manual browser/UAT acceptance is claimed.

B1 commit/push preceded its fresh shared-writer acknowledgement, repeating a prior sequencing deviation. This did not alter main/original refs but remains a process defect; later acknowledgement is not a cure. B2 used received ACK, separate successful fresh reads, then writes. Final Ready/merge repeated refs and required checks and used match-head ordinary merge. Network EOFs were read back before uncertain writes were retried. See [B1 comment](https://github.com/zensgit/metasheet2/pull/5632#issuecomment-5630484921) and [B2 comment](https://github.com/zensgit/metasheet2/pull/5635#issuecomment-5631040064).

Original PR closure, B3, wide-screen changes, persistent preferences, flag enablement, staging/production release and full product acceptance are not included. The two nightly tracks and #5598 remain independently unresolved in the coordinator's scope. The docs-only Draft is documentation delivery, not a new capability approval or merge authorization.
