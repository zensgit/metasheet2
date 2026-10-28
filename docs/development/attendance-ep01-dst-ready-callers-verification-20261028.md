# Explicit punch-detail import verification — Draft

Refs #4556. Contract: [design-lock](attendance-ep01-dst-ready-callers-design-lock-20261028.md).

## Result and scope

The approved `inputKind: "punch_events_v1"` path accepts ordered physical punches without collapsing multiple segments into one daily first/last pair. Synchronous/asynchronous preview and commit preserve all event ordinals. Durable preview records and commit plans retain frozen identity, current authorization, restart/replay and transaction boundaries. The daily V1 parser remains unchanged; the named format has explicit dispatch and cannot silently fall through to it.

The initial finite local delivery audit covered 111 implementation/test/contract/document paths plus this verification note. Subsequent CI repairs add the precisely listed guard and regression sources; the current publication manifest is authoritative for the final path count. Local evidence was executed on base `929315933ecef4c815d3d98ce38db2719a204611`, with source-hash applicability across focused phases. Publication preflight fetched main `66a45e9a3b4817940fcaf91956efc1de3368b580`: its 23 changed frontend paths do not overlap this candidate, and it has no named punch implementation. No upstream changes were overlaid. Current-head CI remains a separate post-publication gate.

## Gate table

| Gate | Actual evidence | Boundary |
|---|---|---|
| Closed input and event ordinals | 25 input, 8 evidence and 30 public-discriminator cases | Unit/adapter proof; runtime separately below |
| Four public paths | Sync full chains; async commit with 4 events/2 segments/165 minutes; durable async preview; both review families across all 4 routes | Phase-scoped, not a Cartesian product |
| Complete fold-start/end chains | L0→I0→R0→O1→R1, literal 165/195 minutes and 4 physical events each | Two affected rechecks passed after I0 admission changed; token OFF fixture |
| Gap/shared-fold review | 2 public cases retain exact typed review reason, null projection, hidden retired parent, no active pointer/segments; exact409 recompute refusal | Eight named organization business tables; auth-bypass fixture |
| Current identity/authority | Real password/session admission, scoped/full authorization, foreign-org refusal, namespace/membership/permission/session controls; native worker-time checks | No universal auth/security claim |
| Frozen identity/replay | Digest-bound command/preview, trusted row identity, current-admission retry, no mutable job-payload authority | Matching unit and native evidence, separately scoped |
| Queue failure/startup recovery | Actual fresh-server startup discovers durable job IDs; preview and commit retries preserve reservation state; commit has 4 distinct permission/namespace/subject/healthy cases | Controlled queue, not Redis |
| Contention and required token | Native preview transaction contention; PSP02 required-mode single-consumer race and caller rollback | Token OFF compatibility preserved |
| Storage/rollback | Native immutable storage/apply/guarded-down; SQL abort recovery; kernel final-seal rollback | Retained history is never dropped |
| Old V1 preservation | Original raw/plan parser bytes, no-payload assertion, absent-discriminator dispatch and disabled/token-OFF branches retained | Whole plugin index is intentionally changed |
| Counterfactuals | Fold/evidence, command, preview, authorization, queue, token and typed-review guards have matching failures followed by exact restore | Harness/setup failures excluded |
| OpenAPI | All four request/response variants, generated artifacts, 20 distinct contract cases across phases; build/SDK/guard/security checks passed | Runtime validates formats/order/timezones |
| Quality/review | Affected types and validate:all passed; later test-only changes have exact source applicability; lint introduced0; independent finite audit found no remaining local implementation gate | Existing diagnostics retained; not a fresh whole-suite run |
| Draft/current-head CI | Draft #6630 published; inventory and subsequent core-guard/context failures repaired locally; repaired-head CI remains required | Local green is not CI green |

## Latest review-family phases

- Initial new cases: 2 failed/49 filtered because the recompute request omitted required nullable version fields. Explicit nulls corrected the request; the original409 assertion was retained.
- Corrected phase: 4 passed/47 filtered, comprising the two review families and two affected full fold chains.
- Fixture-lifetime correction: 3 passed/49 filtered, comprising two review families and one late-seed-failure cleanup case.
- Wrong public reason counterfactual: 1 matching failure/51 filtered; exact restoration: 1 passed/51 filtered.
- Final helper lint: 0 diagnostics. Shared registration baseline/current: 3/3 prior diagnostics, introduced0.
- Source restored; owned PostgreSQL stopped; data retained. Filtered, skipped and TODO assertions are not passes. Repeated phases are not additional unique cases.

New fixture identities are allocated before seeding; cleanup removes their authority and deactivates their user/membership rows while preserving referenced business history. The late-seed fault occurs after native seed completion and before callback entry, not at every internal await. Historical unjournaled fixtures are retained. Business-history retention is established by cleanup source, not an extra post-cleanup snapshot.

Representative raw-log SHA-256:
- Corrected four-case phase: `ff4e3e8d47ba485be11c33f954d4b59c11d5ccfe826a4f6a4f2cb534f7a4bf45`
- Cleanup three-case phase: `e2e714c6081c5063481df8770b8797aeb1e2ce21ae883b6fc9886a3e0f636a78`
- Typed-reason matching negative: `0ef17a161899244d6bd4b51fdd4fda41abca1fa622f9237125ea14bb566d0150`
- Exact restore: `4b73c276bbd65e55e6ede6575b3eade56f05c7e216ab205b132fe5819b3d662d`
- Applicable validate:all: `756d9c84eaad2d381600a385299248baf014fdfd61796cd409f4b3867d625840`

## Commands and execution boundary

Native phases use the existing DB configuration and owned test database, without replaying its453 migrations:

```sh
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-w4c3b-request-operation-routes.db.test.ts -t 'PUNCH_REVIEW_PUBLIC_|PUNCH_REVIEW_FIXTURE_PARTIAL_SEED' --retry=0
pnpm exec eslint --no-ignore --parser-options '{"project":null}' packages/core-backend/tests/utils/attendance-punch-review-public-native.ts
pnpm validate:all
```

The last command refers to the earlier applicable production-input phase; it was not repeated for unchanged production inputs. Original120000ms case budgets remain. The detailed remote evidence index is `punch-detail-full-slice-delivery-gate-audit.json`, with17 gates and phase/source bindings; `review-public-main-independent-final-audit.json` records the latest actual assertions and limitations.

## Migration and rollback

`zzzz20261028103000_attendance_punch_preview_records.ts` is a required runtime migration for named async preview classification and immutable preview storage. Apply through the normal Kysely migration runner only on an explicitly selected test database; this Draft does not authorize deployed migration.

Down requires a runner-owned READ COMMITTED transaction, locks both job/preview tables, and refuses when preview history remains. It removes the new schema only when empty. Do not delete history to force rollback or treat down as a lossless rollback after use. Restoring an application image does not erase this schema/history prerequisite.

## Independent boundaries

Draft/HOLD only: no merge, deployment, R71, tag/release, feature enablement or provider writes. Correction/CALC14, real Redis/live transport, owner/manual/business acceptance and the R77 organization package remain independent. The R77 package still waits for its exact target build commit. This finite slice does not claim all EP01 callers, all DingTalk business acceptance, ordinary-reader HTTP list acceptance, every database table/SQL effect, or real-provider delivery.


## CI inventory registration follow-up

The initial published head's backend failed the explicit inventory gate: 67 assertions passed and two failed. The new preview-record table lacked classification, and nine new accesses to existing P25 tables had not entered the closed call-path ledger. Later core/native stages did not execute. Raw failed-job log: 724573 bytes, SHA-256 `6d03d0d35acb56d246481991dd9c801934154abad0e7152b86c97925d2174ba5`.

The repair registers immutable preview records as canonical-boundary storage with non-authority transport semantics. The exact ledger is now 127 sites: the prior112, nine accesses to existing families, and six accesses to the new preview table. Preview enqueue/worker transport paths are exact; existing durable V1 job/plan adapter lists remain unchanged. Reserved transport aliases now receive the same exact-path check, without applying that restriction to ordinary token/staging transport. No runtime, migration, workflow, dependency or flag changed in this follow-up.

Independent review found the second canonical-table closed-set expectation and the reserved transport alias counterexample. Both failed as named before correction. The final affected selection passed10 assertions, with62 filtered; this is not a fresh whole72 run. Earlier new-guard positives passed2, and separate bucket-demotion/path-removal counterfactuals each produced one matching failure. Repeated phases are not additional unique cases.

One intervening local census attempt included13 retained generated worker bundles under a scanned package directory. That attempt was stopped without pass credit. All26 generated bundle/manifest files were preserved byte-for-byte outside the package scan; collector exclusions and source budgets were not relaxed. The final selection used the restored source without those noncommitted execution artifacts.

Explicit same-path/same-config baseline/current lint retained six prior diagnostics and introduced none. Previous production types/validate:all evidence remains source-applicable because only inventory scripts/tests and this note changed; those passing production suites were not repeated.

```sh
node --test --test-reporter=tap --test-name-pattern='^(exact-head HEAD scan:|the three scheduled-run tables are w4_canonical|P25: (the closed import/integration set|generated runtime call-path census|durable legacy V1|non-worker adapters)|P25 mutation: removing the private-worker boundary|P25 punch-preview:)' scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs
```

Evidence receipts: ci-inventory-reviewed-validation-state.json, ci-inventory-quality-state.json, ci-inventory-generated-bundle-relocation.json and the bounded independent inventory review. New-head required CI and actual full target execution remain separate final gates.


## Core CI guards and supported group-context repair

The inventory-repaired parent failed core tests in six guard files (13 failing assertions); its later native/request targets did not execute. The complete failed job log is retained: 8,891,706 bytes, SHA-256 `2a9ccd7e3d704794e7a25a860c8ba2f050c229a0b560bb0cf9d6717fa0e31592`. The later PostgreSQL cleanup failure followed skipped database startup; its cleanup guard is unchanged.

The repair registers fourteen actual connection providers, fifteen calculation-path files under both existing W6 bans, three holders that do not write meta_records.data, one hour-free IANA validity probe and one exact native test fixture. Walkers, closed-set checks, runtime scope, original assertions and case budgets remain. The release guard includes one test with seven parsed-source counterexamples; each removes only that provider\'s error forwarding and observes exactly one violation. These are seven variants inside one executed test, not seven production mutation runs.

Source review rejected the initial proposed HOLDS_BY_POLARITY exemption. The shared issuer can return a legitimate V2/group_effective context, but preparation and stored named-plan validation rejected it. A new focused regression first produced three matching failures with eight passing controls. Both gates now use the existing supported V1/V2 router, and both ledger entries remain MUST_WIDEN. The ordinary daily-parser body is byte-identical. Existing identity, organization, timezone, shift, schema and selector/group-id checks remain. The calculator change is a single input-type member; compiled JavaScript is byte-identical (SHA-256 `fcf25868eccf278d4a481b2cac0bc2b5f588fa5e9deadd8740c4b9dc2a686800`).

Actual phases:

- Six guard files: 116 passed, zero skipped. This precedes the semantic correction; the four unchanged guard adaptations retain source applicability.
- Fixed affected set: 85 passed, zero skipped: new group regression11, preparation12, preview-record39, W7 shape10 and W6-R5 preservation13. Repeated assertions across phases are not additional unique cases.
- The persisted group probe reaches the unchanged registry identity gate without SQL; it does not establish full worker/native execution. The preview and preparation probes preserve four physical events, exact165 minutes, V1 optional policy and reject seven invalid contexts.
- Explicit lint on all ten changed source files: zero diagnostics, introduced0. Initial validate:all completed plugin validation and root lint, then exposed three type assignments. After the type-only fix, only the previously incomplete workspace type-check and the changed type-file lint were run; both passed. This closes all validation phases, not a claimed fresh whole validate:all invocation.
- Independent bounded source review has no remaining confirmed finding. No native/business suite was repeated for unchanged source.

Commands: `pnpm --filter @metasheet/core-backend exec vitest run <affected files> --retry=0 --maxWorkers=1 --minWorkers=1`, explicit same-path/config ESLint, then `pnpm -r type-check`. Actual per-file assertions, source pins, raw report hashes and phase limitations are recorded in `ci-core-guard-main-independent-final-audit.json`. Current-head required CI and actual target execution remain mandatory before final evidence closure; no parent success substitutes for them.

## CI closure-boundary follow-up after 7178

The next exact-head backend run failed four assertions in three structural guard files: the production resolver-importer census, issuance op(i) importer census, and two context-shape checks. Repeated retry/reporting lines are not extra unique failures. Full failed-job log: 8,858,176 bytes, SHA-256 96c4dbabb9dc4259de58c2e72338ef5688b000c6777d8dfa7153102046e8edb5. Later native/request52 targets did not execute. PostgreSQL cleanup failed after startup was skipped; its guard is unchanged.

The preparation input now derives its existing V1/V2 union from RoutedFrozenAttendanceContextV1, excluding the explicit invalid/null arm. This removes the direct private-issuer type import without changing accepted types or runtime JavaScript. The new group regression moves from the production-source census tree to the existing tests/unit/attendance-w4c3a-punch-detail-group-context.test.ts location. Seven relative imports change; all helper/test bodies and eleven expanded cases remain byte-identical. Existing default core CI discovers this standard unit-test path. No scanner root/exclusion, allowlist, assertion, budget or workflow changes.

Actual focused validation, with the final candidate paths staged so index-based scanners see them:

- Four affected files: 55 passed, zero skipped/filtered/TODO: moved group-context11, inertness25, context-shape10 and issuance-seam9. These are executed assertion statuses, not reporter header counts.
- Explicit lint on the preparation and moved regression paths: baseline/current both zero diagnostics.
- Backend type-check completed successfully. Preparation compiled JavaScript is byte-identical: SHA-256 5b263fffab689529722eae9775e0c8d865e8f3890495a2dfff97b8803715e7bd.
- Independent bounded source review found no confirmed finding; the main audit checked source pins, retained test bodies, unchanged guards, actual assertions and the prior validation phases. This is not a fresh whole validate:all, full native execution or current-head CI pass.

Commands: pnpm --filter @metasheet/core-backend exec vitest run <the four affected files> --retry=0 --maxWorkers=1 --minWorkers=1; explicit baseline/current ESLint; pnpm --filter @metasheet/core-backend type-check. Evidence: ci-7178-boundary-repair-validation-state.json, ci-7178-boundary-repair-independent-source-review.json and ci-7178-boundary-repair-main-independent-final-audit.json. No previously green unchanged business/native suite was rerun. New-head required CI and actual target execution remain mandatory; the parent's other twelve successful checks are historical only.
