# Attendance durable shift-delete evidence — DB08 finite native proof

Draft / HOLD. Refs #4556, parent W3 safety erratum and `7.1 database delete/evidence bullet. Source base `5193da4c5667418a8bd9fa40a9a80021cdcac077`.

## Scope and locked behavior

Add18 named cases to the existing registered writer-matrix file, plus this lock and its verification report. Original45 cases/hooks/helpers/auth/assertions/budgets reconstruct byte-for-byte after removing the additive block. Whole file has63 cases. New cases alone use120000ms. No runtime/schema/workflow/dep/config/flag change.

Twelve isolated blocker states:
- assignment active/published, active/draft, ended/inactive;
- rotation ID/name references, each active/inactive;
- pending swap requester-only and counterparty-only snapshots, with assignment FKs pointing to a surviving shift;
- pending and published dispatch targets without a target assignment;
- desired fixed-schedule configuration.

Each actual HTTP DELETE must return the exact typed409/code/message/single blocker class and count1. The native target/segment and full rows of every public BASE TABLE with org_id are compared before/after. Preconditions require only the intended target blocker, preventing an assignment from masking a missing snapshot check. This is zero committed scoped-row change, not a zero-SQL-attempt or whole-database assertion.

Four nonblocking historical cases: rejected swap on each side, cancelled dispatch, auto-write candidate. HTTP DELETE200 removes only target/segments; full evidence remains exact, except the existing ratified dispatch FK may set only target_shift_id to null. Actual swap and dispatch list/detail plus generic request reads omit the unresolved UUID and expose exact neutral labels/statuses while the surviving swap side stays available. Existing auto-write aggregate GET exposes no candidate field: assert complete run summary/reasons/pagination and raw UUID absence; never invent a candidate detail route or label guarantee.

One foreign-org pending snapshot must not block local delete and remains exact. One free-target200 case is the independent mutation control.

## Gates and actual evidence

| Gate | State |
|---|---|
| Original45 inverse bytes / exactly3 paths | PASS |
| New native actual cases | PASS18/18, old45 filtered excluded |
| Matching semantic mutants | PASS15 groups; each1 named red/1 actual free-target control/61 excluded |
| Runtime restoration | Exact to base and saved bytes after each fault |
| Explicit same-path test lint | Introduced0 errors/warnings; both baseline/current exit1 with same4 existing errors/11 warnings |
| Applicable production quality | Actual same-base DST validate:all0 retained by14117 identical other tracked inputs and test exclusions; not a new run |
| Independent source review | No confirmed introduced P1/P2; source only |
| Current-head required CI / whole registered63 /18 receipts | PENDING after publication |
| Full parent / owner / real-auth / UAT / production | OPEN or excluded |

Full-row predicates use unique synthetic orgs and schema-legal isolated snapshot fixtures. These prove persisted-reference/delete/read behavior, not that every fixture is reachable through public approval/publish producers. Original RBAC_BYPASS posture is unchanged; no real-auth acceptance claim.

## Containment

Owned migrated UTF8 PG ledger458 reused without remigration; services stopped/data retained after each controller. Public receipts contain only arm/enums/counts/booleans. Temporary source faults are not product fixes, and all original budgets/assertions remain unchanged.

All Draft/HOLD. No merge/deploy/R71/tag/release/business-config/persistent-flag changes. Stream/lifecycle OFF; realUAT/business50004 excluded; historical08PUT INCONCLUSIVE. Other parent calculation/mutation/owner/manual gates are not discharged by this finite DB08 proof.
