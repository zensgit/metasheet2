# Imported evidence and immutable attribution restoration

Draft/HOLD follow-up to Draft #6609; refs #4556. No permission/schema/API/dependency/workflow/flag change.

## Defect and minimal change
Actual synthetic HTTP prepare/commit import C1 and bounded overtime approval C2 complete, but subsequent HTTP check-out returns409 ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_INVALID. Read-only retained-database diagnostics confirm real current context/attribution validators, target identity checks and all companion fingerprints are valid.

Generic companion restoration recursively converts every startAt/endAt into Date, including the immutable frozenAttribution snapshot. Canonical fingerprinting normalizes Dates to ISO, so hash equality does not preserve the strict snapshot's types. Core attribution admission requires original ISO strings. A focused unit reproduces exact string-vs-Date mismatch; two operational-window/tamper controls pass.

The runtime fix is2 additions/1 deletion: skip recursive Date revival only at frozenAttribution. Identity and resolution retain their closed frozen snapshots; operational/fullWinner windows still become Date. Existing fingerprint and ownership checks remain. The original module is byte-identical to fresh main2e3aed before repair.

## Gates and actual evidence
| Gate | Actual result |
| --- | --- |
| New restoration unit | Before1 matching failure+2 controls; fixed3pass/0skip. Intentional old-source rollback1 matching failure+2 controls.3 unique cases. |
| Actual HTTP/PG retention | New named import->OT->historical server-clock check-out case1pass/33filtered; original33 whole-file/import/budget bytes remain exact. |
| Retention counterfactuals | Removing imported evidence from the OT reader gives1 exact evidence-equality failure; disabling live preserved evidence gives1 exact later equality failure. Each filters33. Exact runtime restoration passes the same case. One unique native case across phases. |
| Affected neighbors | Two timezone read-context/pre-companion unit files44pass/0skip. |
| Inherited CI fixture compatibility | Shared test-only repair from519f02a by normal cherry-pick c6cc7d6. On this distinct runtime candidate, real producer+historical continuation2pass/73filtered. No unrelated suite repeated. |
| Quality | Runtime node syntax and validate:all exit0. Explicit same-path/config baseline/current lint0introduced errors/warnings; native file keeps1 pre-existing any warning, runtime/newunit0diagnostics. |
| Review | Bounded independent source reviews plus main exact hash/raw reporter audits; no confirmed introducedP1/P2. Initial historical-time oracle gap fixed with explicit21:30 event assertion. Model review is not execution evidence. |
| Current-head required CI | Pending fresh execution after Draft publication; whole native34 and new unit3 must actually run. No sibling/parent green borrowed. |
| Full EP01/product/production acceptance | Remains open. |

The native case uses actual import batch identity and import-source evidence, verifies C1/C2 full calculation rows remain exact, preserves frozen context/approved fact/manual snapshot, matches operation result hashes, and checks check-out response plus calculation-history replay. It proves null-manual preservation only. It does not independently census every child/import metadata/financial table or all replay side effects.

Every actual PG phase uses an owned isolated UTF8 clone, ledger452 without replaying migrations, finally stops only its unchanged owned postmaster and retains data. No real tenant/provider/authentication acceptance. Test-only server clock strips occurredAt before the real HTTP call; no production timestamp bypass.

## Source phases
Quality ran on the final runtime/unit/native code before inheritance of the separate test/doc-only CI fixture repair. All4 tested source pins remain exact through that inheritance; production/runtime/config/workflow/dependency inputs do not change. The2 affected native compatibility cases then run on the composed candidate. This final evidence-only document rewrite does not rerun or relabel earlier tests as fresh final-head runs.

Receipts: frozen-attribution-diagnostic-main-audit.json, restore-unit-before-state.json, restore-unit-fixed-state.json, import-retention-counterfactual-main-independent-audit.json, import-retention-quality-state.json, shared-ci-fixture-inheritance-source-applicability.json, coupled-precompanion-native-validation-state.json, frozen-attribution-runtime-independent-review.json, current-original33-prefix-main-proof.json and main-independent-local-final-audit.json. Raw initial failures, readonly diagnostics, mutations and exact source-restoration evidence are retained.

## Limits and HOLD
Direct rows through prepare/commit and bounded overtime only; not all import transports, correction target semantics, unbounded minute provenance, general missing/mixed/shadow/nonOT/reversal recovery, financial policy universe, all work-date fallback cases, full five-entrypoint EP01, real authentication/DingTalk delivery or UAT. Original-freeze hash and sibling malformed-input branches remain existing guards; the new tamper unit targets identity corruption, not every guard branch.

All PRs Draft/HOLD. No Ready/merge/deploy/R71/tag/release/config/provider writes. Stream/lifecycle/externalwrites OFF. Real UAT/50004 excluded. Historical08 PUT inconclusive. No R76/R77 inclusion or enablement claim.
