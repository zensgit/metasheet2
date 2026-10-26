# Attendance durable shift-delete evidence — verification

Draft / HOLD. Refs #4556 DB08. Base `5193da4c5667418a8bd9fa40a9a80021cdcac077`. Test/docs only, exactly3 paths.

## Native execution

One selected native HTTP/PG run actually executed18 new cases, all passed, exit0;45 original cases were filtered out, not counted as passed. Per-assertion JSON and18 distinct value-free DB08_DURABLE receipt arms were independently audited by main. This is not a local whole63 green claim.

- 12 independently isolated durable states returned exact409 with one expected class/count and complete org-row equality.
- 4 historical cases returned200, preserved full evidence and checked actual list/detail redaction or aggregate shape.
- 1 foreign-snapshot org discriminator and1 free-target control returned200.

Each scope snapshot discovers public BASE TABLEs with org_id and compares ordered complete to_jsonb rows, not counts alone. It explicitly includes shifts/segments, assignments/rotations, request parents/swap/dispatch, fixed desired config, auto-write runs/items. Expected successful delta removes only target shift/segments; cancelled dispatch additionally clears its FK target only. No SQL-statement tracing or org-less/global/auth-table guarantee is claimed.

Swaps use legal persisted snapshot facts with assignment FKs on the survivor. Published dispatch with no target assignment is schema-legal. These isolate durable row semantics, not public approval/publication reachability. Original authentication/fixture posture and setup/teardown remain byte-identical.

## Fifteen causal fault groups

Each group executed1 matching named red +1 actual free-target positive +61 filtered excluded. The15 controls are executions of one unique control, not15 extra unique cases.

| Fault | Matching observation |
|---|---|
| Ignore inactive assignment | HTTP200 instead of409 |
| Ignore rotation ID | HTTP200 instead of409 |
| Ignore rotation name | HTTP200 instead of409 |
| Ignore inactive rotation | HTTP200 instead of409 |
| Ignore pending swap requester side | HTTP200 instead of409 |
| Ignore pending swap counterparty side | HTTP200 instead of409 |
| Ignore pending dispatch | HTTP200 instead of409 |
| Ignore published dispatch | HTTP200 instead of409 |
| Ignore desired fixed config | HTTP500 instead of409; real restrictive FK does not replace typed guard |
| Remove swap org scope | Foreign snapshot incorrectly causes409 instead of200 |
| Treat rejected swap as live |409 instead of200 |
| Treat cancelled dispatch as live |409 instead of200 |
| Erase auto-write candidate history during delete | Full-row equality detects actual missing immutable item |
| Stop clearing missing swap reference IDs | Actual raw read leaks deleted UUID |
| Stop clearing dispatch nested metadata IDs | Raw nested aliases leak UUID despite neutral top-level label |

Main read raw status/FK/row-diff/raw-response failures and checked individual assertion statuses, log hashes, patch identities and exact restoration against both saved bytes and frozen base. Temporary mutants never enter the product diff. No unchanged positive suite was replayed to repair receipts.

Private evidence: `native-eighteen-first-state.json` / `native-eighteen-first.vitest.json` / `native-eighteen-main-positive-audit.json`; `native-durable-mutations-state.json` and15 raw logs/reports/patches; `native-durable-mutations-main-independent-audit.json`.

The first mutation controller stopped during static preflight because its anchor occurrence estimate was2 but actual source had1. No PG/mutant/test started. A corrected occurrence check preceded the actual15 successful groups. Initial offline-setup validator also assumed a prior receipt pid key; it failed before install/process launch and was corrected. Both harness failures retained; no runtime bug or test-pass claim is inferred from them.

## Lint / quality / review

Explicit ESLint baseline/current uses the same absolute filename and config with `--no-ignore --parser-options '{"project":null}' --stdin --format json`. Both exit1: the same4 existing errors and11 warnings. Counter(rule/message/severity) comparison introduces0. This is not full-file lint0 and no pre-existing diagnostic was suppressed or deleted.

Root validate:all actually passed on the same-base DST quality input. Every14117 other tracked file is byte-identical; only this test and that independently qualified DST test differ, both excluded by production TS. All scripts/manifests/deps/config/runtime inputs match. The prior production quality result is applicable; it was not rerun or relabelled as fresh candidate quality. Explicit changed-test lint was separately performed.

Independent source review found no confirmed introduced P1/P2. Main read the whole387-line addition, checked exact inverse to original45, schema/route sources, actual native assertions and all mutation failures. Reviewer ran no tests/mutations and did not certify publication/business acceptance.

Owned Node20.20.2/pnpm9.15.9 dependencies installed offline once. Existing UTF8 PG ledger458/migration-tree qualification reused, no migrations rerun. Controllers stopped their own cluster with PID ownership checks; data retained. No external provider IO.

## Reproduce / CI

In the isolated synthetic migrated PG fixture:
```sh
pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/attendance-shift-segments-writer-matrix.db.test.ts -t DB08_DURABLE
```

Existing backend file is registered in plugin-tests.yml/package script. No new workflow chain or frontend spec was introduced. Final current-head CI must actually execute the whole file63 with no skips and all18 unique DB08_DURABLE receipt arms; parent/base/shared web greens do not substitute. Exact-head required CI is PENDING.

## Boundaries

No runtime fixes were necessary for these finite existing safeguards. No concurrency/whole-parent/W7/canonical-calculation/real-auth/public-producer/owner/UAT/production closure is claimed. Scope is the specified DB08 durable blocker/history-read evidence; a future candidate-detail API is not invented.

All PRs Draft/HOLD. No merge/deploy/R71/tag/release/business-config/flags, Stream/lifecycle OFF; realUAT50004 excluded,08PUT INCONCLUSIVE. Other engineering and owner/manual/frozen/live requirements remain separate.
