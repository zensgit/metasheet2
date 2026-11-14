# EP01 two non-UTC ready-caller verification — 2026-10-28

## Source and boundaries
Fresh fetched main2e3aed2540659cd7a133f7b8c3f888b01115c7f8; input Draft6619 ed16fefe7905dd88716212de84cb445ea91d56ee as its48-path source-concern diff, not merge/Git ancestry. Total50paths; own delta only two test/helper files plus design-lock/verification. Own runtime delta0; inherited input contains its independently tracked runtime concerns. No deps/lock/schema/OpenAPI/flag/config/UI change.

Fixtures use existing synthetic auth posture and real HTTP/plugin/PostgreSQL writers. This is not new real-JWT/RBAC proof, provider delivery, R77 compatibility, owner/manual acceptance or full five-caller EP01 closure.

## Literal scenarios
| Case | Local window | UTC window | Offsets/folds | Result |
|---|---|---|---|---|
| D02_TAIPEI |2026-02-04 21:00→next06:00 Asia/Taipei|02-04T13:00Z→22:00Z|+480/+480, unique|540min|
| D02_NEW_YORK |2026-02-04 21:00→next06:00 America/New_York|02-05T02:00Z→11:00Z|−300/−300, unique|540min|

Each complete chain executes L0 live→I0 direct-row import→R0 frozen_prior→O1 bounded approved OT→R1 frozen_prior. Literal parent/segment instants, workDate/timezone, complete attribution/context/evidence/facts/manual/results, source-build clock, immutable history, pointer/version, independent actual terminal binding, operation fingerprints and replay remain asserted. Local23:00→next01:00 bounded OT is inside the existing window: no extra minutes/window expansion. Explicit declared historical fixtures do not choose unresolved historical-policy semantics.

Two additional checkout-only import probes require origin local day, partial/missing_check_in, zero minutes, exact evidence and no calendar-day parent. They are not full540 parity. Full import firstIn is on local origin day, so LOCAL first-available calendar fallback is non-discriminating there; checkout-only provides the discriminator. Taipei checkout UTC date is still origin day: UTC and LOCAL fault models must not be conflated.

## Actual gates
| Gate | Actual result |
|---|---|
| Aligned fixture |2new full+2new partial passed/29filtered; prior C01 passed, unchangedUTCdefault not repeated here|
| Live LOCAL calendar fault |2matching D02full failures+3controls passed/28filtered;409 ATTENDANCE_TIMEZONE_CONTEXT_CHANGED|
| Import first-available LOCAL calendar fault |2matching D02checkout-only failures+3controls passed/28filtered;422 WORK_DATE_ATTRIBUTION_MISMATCH|
| Final bounded OT LOCAL calendar fault |2matching D02approval-status failures+3controls passed/28filtered;actual422|
| Frozen-prior copied LOCAL calendar fault |2matching D02recompute-status failures+3controls passed/28filtered;actual409|
| Final exact restoration |same final phase5passed/28filtered:four new unique cases+existingC01, notwhole33passed|
| Explicit lint |same-path/config baseline/current introduced0;3old any warnings retained|
| Quality |validate:all exit0;49source pins stable|
| Preservation |explicit inverse restores entire original helper/spec;original assertions and budgets retained|
| Ownership |ledger452 reused,no migration replay;own unchanged-PID PG finally stopped,port closed,data retained|
| Review |two bounded source reviews;fixture P1/plan P2 corrected;review does not substitute for execution|

Four caller-local mutations have exact runtime byte restoration between phases and at final exit. No shared resolver mutation substitutes for four callers. Only necessary changed-source controls/restoration run, not unchanged green suites.

## Commands and receipts
With an owned prepared synthetic DB/test environment:

    EXPECT_DB=1 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-w4c3b-request-operation-routes.db.test.ts -t 'EP01_READY_.*(D02_TAIPEI|D02_NEW_YORK|C01)|EP01_IMPORT_CHECKOUT_ONLY_.*(D02_TAIPEI|D02_NEW_YORK)' --retry=0 --reporter=verbose --reporter=json
    pnpm validate:all

Raw outputs remain remote artifacts, not committed: non-utc-org-aligned-native-state.json, non-utc-calendar-mutations-v2-state.json, non-utc-main-independent-native-and-mutation-audit.json, non-utc-original-source-preservation.json, non-utc-final-quality-state.json. Counts use assertionResults.status; filtered/skip/todo and Vitest headline totals are not passes. Repeated phases are not unique cases.

## Failed attempts retained
The first selector missed quoted Vitest string-placeholder names:0executed/33filtered, invalid—not pass/negative. The next real phase had3passed/2failed/28filtered: C01 and two partial probes passed; two full live cases returned ATTENDANCE_TIMEZONE_CLIENT_ZONE_CONFLICT because synthetic org default remainedUTC. Its harness wrongly expected four failures; original failed state/report retained and actual counts independently audited.

Only the synthetic initial default-rule timezone is now passed through seedCanonicalDay→seedOrg, old defaultUTC preserved. Online authority under policyOFF remains organization-default context; shift/client agree. Import keeps its existing declared row-timezone contract. No production authority/guard relaxation.

The first mutation-controller launch failed before slot/PG/tests/source mutation due to a generated manifest filename. The prepared OT recipe used SQL context_snapshot on a mapped snapshot object; main read mapSnapshotRow and direct forwarding, correcting to contextSnapshot before runtime execution. Invalid plan/controller/log remain; neither counts as a matching negative. Import's obsolete ROW_SUCCESS label was removed; actual named status failures were verified.

## Remaining delivery gates
New head needs its own required CI and actualwhole33 target execution, fresh hashes/clean/Draft and final body/readback; input CI/local5 do not substitute. Fifth approved correction, other finite families, correction-target/CALC14 remain OPEN. DG-OT-01 minute-only source is separate, not included.

Draft/HOLD only:no Ready/merge/deploy/R71/tag/release/business config/provider/live writes. Stream/lifecycle/externalwritesOFF;realUAT50004 excluded;08PUT INCONCLUSIVE. R77 org source kit remains independent,target commit pending. Owner4556/4844/6512,humanAT/nativeOSmenus/SR/TRANSFER,W8PQA/manual24hsoak/performance/reconciliation/liveprovider/2000user/Redis/secrets are not closed.
