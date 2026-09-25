# Time Machine V1 Residual Verification

Status: DRAFT/HOLD. Baseline: main
`1aaffe3f9fd9df20ea878aaaa0662d38bb09e7c3` (#6052 merge).
This report is an evidence index, not a replacement for
[the full attachment restore verification](timemachine-attachment-restore-verification-20260919.md).

## Verified Synthetic And CI Evidence

| Gate | Evidence | Verdict |
| --- | --- | --- |
| Product checkpoint | `3d01f8209897d07eebe0880c846be9d061fbb9db` used owned PostgreSQL, authenticated Workbench/browser at 1440/390, original binary and PNG readback, migration replay and historical neighbors. The full report records zero owned DB/backend residue. | PASS for the recorded synthetic checkpoint only. |
| Current-main acceptance refresh | #6050 merged at `e046a21c0a0110fbe22ca765852f1e053d90c0cb`. Its one-file harness fix changed post-stop pool inspection, not recovery product behavior. All nine exact-SHA `event=push` workflows succeeded; build-and-push and deploy jobs were skipped. | PASS for the harness and merged-main CI. |
| Evidence merge | #6052 head `9d64eb8a6dd17a5034b5d095f96927574ffa02b1` merged at this report's baseline. All six workflows with `event=push` and the exact merge SHA `1aaffe3f9fd9df20ea878aaaa0662d38bb09e7c3` completed SUCCESS. The Deploy to Production workflow's test job succeeded; `build-and-push` and `deploy` were SKIPPED. | PASS for documentation merge CI; no deployment. |
| Post-baseline synthetic checkpoint cleanup | On main `4189aa096a8a8054315bb97db79dfbac1823954e`, [Plugin System Tests run 36161617263](https://github.com/zensgit/metasheet2/actions/runs/36161617263) attempt 1 failed Node 20 after the product tests passed: immediate owned-DB activity was 1, expected 0. Attempt 2 succeeded, which does not erase the first failure. [#6059](https://github.com/zensgit/metasheet2/pull/6059) changes only `verify-recovery-manual-checkpoint.mts` to allow a bounded two-second drain while still rejecting persistent residue. Follow-up removes caller-controlled `application_name` from failure diagnostics. Exact head `974b945210cf1856b7bc1bba8335401f182abc7e` has 25 SUCCESS and 1 intentional SKIP; Node 18/20 both passed isolated manual checkpoint acceptance. Local isolated PostgreSQL, core type-check, wiring 41/41 and a values-free query mutation also passed. | Test-only fix verified on the Draft head; merged-main gate NOT RUN. No recovery product behavior change or production evidence is claimed. |
| Browser failure attribution | The earlier `/private/tmp/tm-cd42-replay-browser.log` contains only generic `API_REQUEST_FAILED` after a 1440 gallery check. The later verifier records method, pathname and aborted/transport class; two full repeats passed. | UNATTRIBUTED. Passing repeats are not a root-cause fix. |
| Phase 5 nightly | [Scheduled run 36084559186](https://github.com/zensgit/metasheet2/actions/runs/36084559186), on this exact main SHA, recorded 5 PASS, 0 measured threshold FAIL and 6 N/A because relevant legacy histograms had no samples. | Separate fail-closed operations gap, not TM archive push CI; [#6054](https://github.com/zensgit/metasheet2/issues/6054). |

## Not Yet Verified

| Gate | State | Required evidence before claiming completion |
| --- | --- | --- |
| Selected local or test-NAS storage | NOT RUN | Owner-approved isolated target and synthetic-only execution; exact storage configuration, capture/restore/download bytes, restart, backup-set fault cases, permission negatives, and residue accounting. |
| Real-tenant/customer UAT | NOT RUN | Separate owner authorization, tenant-scoped plan and witnessed result. Synthetic login and owned DB do not substitute. |
| Flag enablement, staging or production | NOT RUN | Separate exact authorization, rollout/rollback evidence and post-enable observation. Current merged-main checks did not execute publication or deployment jobs. |

No new DB, browser, real-storage or production run is claimed by this
documentation-only report. The [development report](timemachine-v1-residual-development-20260925.md)
defines the bounded V1 capability and deferred contracts.
