# DingTalk directory corp-scope closeout verification

Status: ENGINEERING COMPLETE / EXACT-HEAD REVIEW AND CI PENDING / NOT DEPLOYED / UAT NOT RUN

Date: 2026-07-25

## 1. Delivery claim

The code delivery is split into two reviewable PRs:

- Phase A makes every worker safe before schema expansion.
- Phase B expands database uniqueness only after the Phase A drain gate.

This document does not claim merge, deployment, staging success, account binding, callback UAT,
automatic sync, deprovision, or runtime enablement.

## 2. Verification matrix

| Contract | Evidence |
| --- | --- |
| cross-corp raw identity cannot auto-link | real sync negative plus same-corp positive |
| delimiter-containing identifiers do not collide | pure helper negative and mutation |
| duplicate same-corp provider identity fails closed | direct ambiguity outcome plus real-DB no-link |
| generic tenant mutation remains closed | unit and real-DB empty/set, set/change; same-corp positive |
| historical child corp repairs during sync | real-DB blank-to-parent assertion and mutation |
| callback account/integration corp drift cannot act | real approval callback, zero engine write, card remains sent |
| legacy whitespace corp cannot bypass bind conflict | real bind negative and mutation |
| migration canonicalizes data | isolated old-schema assertions |
| all replacement indexes are structurally valid | catalog inspection plus wrong-definition negative |
| expression/include keys cannot masquerade as ordinary columns | key/attribute counts plus expression catalog flag; up/down negatives |
| partial replay cannot pass | no-legacy/incomplete-replacement negative |
| duplicate scoped union cannot migrate | real unique-index build failure; legacy guard retained |
| parent provider/corp is authoritative | integration canonicalization plus provider-drift rollback negative |
| DB/runtime corp grammar agrees | tab/newline/NBSP/EM SPACE/BOM negatives |
| up failure is atomic | constraints and new indexes absent after failure |
| compatible down and replay work | real DB |
| incompatible down retains scoped protection | real DB |
| compatible down does not invent pre-migration text | canonical corp remains canonical after down |
| lock wait is bounded | real second-connection ACCESS EXCLUSIVE blocker; abort around 5.2 seconds |
| timeout scope is contained | prior lock/statement settings restored after up/down |
| migration runner integration works | fresh database migrated through the new migration |
| PostgreSQL 14 compatibility | pending: required CI after Phase B retargets to main |

## 3. Local results

Phase A:

- unit 43/43;
- real PostgreSQL 15 55/55;
- required attendance directory/user-org real-DB regressions 14/14;
- CI contracts 82/82;
- TypeScript clean;
- nine mutations killed.

Phase B:

- isolated migration and inherited Phase A real-DB suite 30/30 on PostgreSQL 15;
- full fresh-database migration reaches
  `zzzz20260725130000_expand_directory_identity_corp_scope`;
- a second Migrator run has no pending migration;
- 10-integration / 100,000-account / 200,000-identity scale sample completes in 3,158 ms;
- a real lock blocker fails closed after about 5.2 seconds;
- TypeScript clean.

Seven Phase B mutations are load-bearing:

1. trusting an existing replacement index without shape verification makes the wrong-definition
   upgrade test red;
2. treating any no-legacy state as a replay makes the partial-replay test red;
3. removing the authoritative-parent-corp preflight changes the values-free refusal and reds its
   dedicated test;
4. trusting an existing legacy index during down makes the wrong-definition rollback test red.
5. ignoring expression/extra key attributes lets a same-name replacement index pass;
6. removing parent-provider equality lets a drifted account adopt the parent corp;
7. restoring the BTRIM-only CHECK lets Unicode whitespace corp tokens persist.

Required CI is recorded only after the final pushed head settles.

## 4. Operational risks

The scoped indexes are built with ordinary `CREATE UNIQUE INDEX` inside the migration transaction.
This is intentionally PostgreSQL 14-compatible and atomic, but it can hold locks and scan large
tables. A local 100,000-account / 200,000-identity sample completed in 3,158 ms, while a real lock
blocker was cut off at about 5.2 seconds. Before deployment, ops must still measure real
account/identity row counts and choose a controlled migration window. No claim is made that the
local sample predicts production lock acquisition, I/O, replicas, or WAL behavior.

Kysely 0.28 executes all pending migrations in one transaction. The 5-second lock timeout therefore
also protects this migration from waiting indefinitely, but a timeout aborts the whole pending
migration batch. Run Phase B only after Phase A is on every worker and the old-worker count is zero.

A compatible down restores the old global uniqueness shape but does not restore whitespace or NULL
corp values rewritten by up. That data canonicalization is deliberately irreversible.

The persisted DingTalk external identity key keeps its existing OAuth-compatible encoding. The
runtime tuple collision that could cause a wrong match is fixed. Versioning the persisted key is
not part of this delivery.

## 5. Final disposition

Engineering status: implementation and local evidence complete; exact-head adversarial re-review
and CI remain required.

Operational status: blocked by explicit owner gates, not by unfinished code.

Required order:

```text
Phase A review/merge/deploy
  -> prove all old workers drained
  -> Phase B review/merge/deploy
  -> post-fix two-corp staging UAT
  -> authorized existing-user bind
  -> same-corp approval callback proof
```

Flags, schedules, and deprovision remain unchanged throughout.
