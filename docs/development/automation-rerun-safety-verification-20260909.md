# Automation rerun safety verification

Status: local evidence only; successor publication is Draft/HOLD. Remote CI,
Ready/merge, deployment, and runtime acceptance are separate gates.

## Exact content

- Base: `6624cd74056a09d25958d2fda2768f5022bc313d`.
- Production blob: `52f61643c38619b273b3e71422dd3c1846b9021f`.
- Test blob: `3f3c577f15ceff0e40c433e76581ff329a3f0987`.
- The final commit/PR head consists of these two blobs plus the two delivery MDs.
  Remote PR metadata is the exact-head record; no previous-branch CI is reused.
- Runtime: local Node 24.14.1 with existing workspace dependencies. No dependency
  installation or lockfile/config change. Node 18/20 CI is not inferred from this.

## Gates

| Gate | Result |
| --- | --- |
| Two baseline probes on unmodified current-main source | 2 expected failures: missing child-action label; unexpected retry after unmount |
| Target rerun spec | 51 passed; original 22 retained, 29 additional cases |
| Target plus AutomationExecutionsView, parallelBranchRunsView, multitable-client | 4 files / 105 passed |
| Exact targeted step from multitable-web-guard.yml | 275 files / 3,209 passed; target 51 included |
| Complete run-required-web-tests.sh | PASS, exit 0: 14 batches / 530 file executions / 7,755 test executions; target 51 included |
| vue-tsc --noEmit -p tsconfig.app.json | PASS |
| type-check:verification-approval | PASS |
| ESLint for the two changed source/test files | PASS |
| git diff --check | PASS |

The existing spec is wired in both `multitable-web-guard.yml` and
`run-required-web-tests.sh`; neither selector was edited. The script includes the
approval neighbors as well. Only the named domain test step was run locally, not
every job in its workflow. Vue stub warnings in these suites are retained in the
logs, not silently removed. An initial YAML-command extraction failed before any
tests because `yaml` was unavailable; using the existing `js-yaml` parser allowed
the exact workflow command to run, with no installation or source/config change.

## Discriminating mutations

All 11 mutations were rerun against the final 51-test blob, individually restored,
and followed by 51/51 GREEN. Production blob equality is checked after each
restoration. These are selected negative runs, so nonselected tests are
skipped by the test-name filter, not represented as a complete green suite.

| Mutation | Matching failures |
| --- | --- |
| M1 omit branch child traversal | 2: condition children and parallel children |
| M2 omit defaultBranch traversal | 4: default effects, unknown/malformed defaults, supported empty branches |
| M3 remove final post-confirm context check | 1: unmount during second acknowledgement |
| M4 remove request-scope equality | 3: principal, tenant, loaded-detail tenant transition |
| M5 disable synchronous generation invalidation | 2: auth A-B-A and execution A-B-A |
| M6 omit shared principal/explicit epoch key | 1: same-token, same-header explicit org A-B-A |
| M7 omit same-row request generation | 1: older detail response after collapse/reopen |
| M8 accept unknown leaf action types | 3: unknown root, unknown default, prototype property |
| M9 omit context check before second dialog | 1: no second dialog after unmount |
| M10 omit success-return context check | 1: late success after principal change |
| M11 omit error-return context check | 1: late error after principal change |

## Reproduction and review boundary

From `apps/web`, run `pnpm exec vitest run
tests/automation-rerun-execution.spec.ts tests/AutomationExecutionsView.spec.ts
tests/parallelBranchRunsView.spec.ts tests/multitable-client.spec.ts --reporter=dot`.
From the repository root, run `bash apps/web/scripts/run-required-web-tests.sh`.
For the domain gate, execute the unchanged `Run multitable web guard specs
(targeted)` step from `.github/workflows/multitable-web-guard.yml`.

Codex refute-first self-review covers child/default enumeration, malformed and
unknown shapes, explicit and ordinary session changes, same-row response races,
duplicate clicks, both confirmation awaits, and stale success/error returns.
No known P1/P2 remains in this bounded rerun delta. No independent external-model
verdict is claimed. Mounted client spies are not evidence of real server retries
or real-browser/staging UAT; none were executed. Separate per-step resume and
server authorization behavior are outside this patch.
