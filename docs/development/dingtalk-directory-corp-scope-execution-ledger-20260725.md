# DingTalk directory corp-scope execution ledger

Status: IMPLEMENTED / REVIEW PENDING

Date: 2026-07-25

## 1. Authorized scope

Authorized:

- implement corp-scoped directory keys and identity matching in isolated worktrees;
- run unit, real-database, migration, and mutation tests;
- create review PRs.

Not authorized:

- merge;
- staging or production deployment;
- runtime flag changes;
- automatic directory sync or deprovision;
- creation of a new MetaSheet user.

## 2. Expand/contract split

| Phase | PR/branch | Contents | Deployment gate |
| --- | --- | --- | --- |
| A | `codex/dingtalk-directory-corp-scope-20260725` / PR #4602 | matcher ambiguity, injective scope key, in-transaction bind/unbind authority, serialized identity snapshot, sync child-corp repair, immutable generic update, callback corp equality | review and merge first |
| B | `codex/dingtalk-directory-corp-scope-migration-20260725` / Draft PR #4605 | canonicalization, CHECK constraints, account/union/open scoped uniqueness, structural drift checks, bounded migration waits, rollback contract | Phase A deployed and every old worker drained |

The original combined shape was rejected after adversarial review: dropping global uniqueness
while an old unscoped worker remained could turn a visible collision into a cross-corp mislink.

## 3. Phase A execution

Completed:

1. removed the schema relaxation from Phase A;
2. changed in-memory corp/provider keys to an injective JSON tuple;
3. added ambiguity sets for external key, unionId, and openId;
4. normalized bind/unbind corp comparisons;
5. made sync refresh account corp from its immutable integration;
6. blocked empty/set, set/change, and set/clear generic integration edits;
7. required callback account corp to agree with its pinned integration;
8. added replacement staging UAT instructions and marked the old runbook historical.

Local verification at the final Phase A implementation worktree:

- focused unit: 43/43;
- focused PostgreSQL 15: 55/55;
- required attendance directory/user-org real-DB regressions: 14/14;
- CI placement/values-free contracts: 82/82;
- nine discriminating mutations killed;
- TypeScript and diff checks clean.

The first CI run found five old admission tests whose fake transaction clients did not model the
new authoritative account lock. The fixtures now return a same-corp account; a separate negative
control proves a NULL-corp authoritative account rolls back the admission savepoint. Required CI
on the replacement pushed head remains a separate gate.

## 4. Phase B execution

Completed:

1. canonicalize the parent integration corp, then copy that exact authoritative value to every
   account;
2. reject blank/non-printable/whitespace-containing corp tokens and account/provider drift;
3. normalize legacy identity whitespace corp to canonical text/NULL, then reject any remaining
   non-canonical value;
4. enforce canonical corp CHECKs on integrations, accounts, and identities;
5. add scoped account, unionId, and openId partial unique indexes;
6. verify index uniqueness, validity, table, ordered key count, total attribute count, absence of
   expressions, and predicate;
7. refuse same-name drift, expression/include-key disguises, and partial no-legacy replay states;
8. remove the global account key only after every replacement verifies;
9. recreate and verify the global guard before down removes scoped protection;
10. preserve scoped protection when down is data-incompatible;
11. bound migration lock waiting to 5 seconds and statements to 5 minutes, restoring the caller's
    prior settings after successful up/down.

Kysely 0.28 supplies one transaction for all pending PostgreSQL migrations; this migration does
not open a nested transaction. The scoped settings are transaction-local. Failure rolls back the
data normalization, constraints, indexes, and settings together. A compatible down removes
constraints/indexes but intentionally does not reverse already-canonicalized data.

Local PostgreSQL 15 evidence:

- pre-Phase-B and fully migrated Phase-B public-schema runs of the combined compatibility plus
  isolated migration suite: 32/32 in each state;
- fresh full Migrator reaches `zzzz20260725130000_expand_directory_identity_corp_scope`, and replay
  has no pending migration;
- lock contention aborts after about 5.2 seconds while retaining the legacy guard;
- synthetic scale sample (10 integrations, 100,000 accounts, 200,000 identities): 3,158 ms in one
  transaction, nine resulting indexes, three CHECKs, zero NULL account corp values;
- ten Phase B mutations killed, including expression/`INCLUDE` index disguises, weaker same-name
  CHECK acceptance, phase-detection drift, parent-provider drift, and Unicode-whitespace acceptance;
- TypeScript and diff checks clean.

The scale sample is a local engineering bound, not a production latency or availability promise.
PostgreSQL 14 remains unclaimed until the stacked PR is retargeted and required CI executes after
Phase A lands.

## 5. Incident and correction ledger

| Finding | Correction |
| --- | --- |
| combined deploy left mixed-version wrong-match window | split Phase A and Phase B |
| duplicate identity test initially stayed green when ambiguity was neutered | added direct outcome golden; mutation now reds |
| isolated migration test used plain Kysely and missed runner behavior | ran full fresh-DB Migrator; removed unsupported nested transaction |
| `IF NOT EXISTS` could accept wrong same-name index | explicit catalog shape verification |
| legacy blank/whitespace corp could compare differently in JS and SQL | normalized runtime comparison plus Phase B canonical CHECK |
| expression key disappeared from the catalog column list | reject expressions and require exact key/total attribute counts |
| child provider could drift from its parent integration | fail the migration before any backfill |
| BTRIM and JavaScript trim accepted different whitespace sets | printable-ASCII token grammar in runtime and database |
| Phase A compatibility fixtures became illegal after Phase B | keep one two-stage suite: runtime repair before Phase B, stronger DB rejection after Phase B, zero skips |
| key-column catalog projection also included `INCLUDE` attributes | restrict the projection to `indnkeyatts` and pin total attributes with an independent mutation |
| ordinary index creation could wait without bound | transaction-local 5-second lock timeout plus real contention test |
| down appeared to imply data restoration | explicitly document and test irreversible canonicalization |

## 6. Remaining owner gates

1. review Phase A;
2. review Phase B as a stacked contract;
3. merge/deploy Phase A;
4. prove old-worker count is zero;
5. merge/deploy Phase B in a controlled migration window;
6. execute the staging UAT;
7. bind only the authorized account to the existing MetaSheet user;
8. verify the same-corp approval callback;
9. decide any later automatic-sync/deprovision/flag changes separately.
