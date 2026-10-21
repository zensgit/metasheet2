# Manual Source Full-Schema Verification

Status: local relational-source acceptance PASS; manual capture end-to-end OPEN.

Baseline: PR #5849 at `5e712fecf21970f127dec87a02ac10c5fff9847b`,
main `89f1ecdee2c3b70205a318074824c834bc6a5c7e`.
The change accompanying this report adds base liveness to the internal source
query and a repeatable, synthetic-only full-schema acceptance driver. It does not
add a capture route, authorization bypass, attachment proof or publication token.

## Reproduction

The driver is `packages/core-backend/scripts/verify-recovery-manual-source.mts`.
It requires NODE_ENV=test and a dedicated task-owned PostgreSQL 15 cluster with
the exact loopback connection and data-directory identity encoded in the driver.
It does not consume DATABASE_URL, production config or customer storage.
Create that disposable cluster as its own isolated development operation, then:

```sh
NODE_ENV=test pnpm --filter @metasheet/core-backend exec tsx scripts/verify-recovery-manual-source.mts
pnpm --filter @metasheet/core-backend exec tsc -p scripts/tsconfig.recovery-archive-acceptance.json --noEmit
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-recovery-archive-relational-source.test.ts tests/unit/multitable-recovery-archive-section-rows.test.ts
```

## Evidence

- Canonical full migration stream and a second no-op `migrateToLatest()` run on
  the completed Kysely ledger both exited 0. The second run does not re-execute
  migration bodies and is not down/up or migration-body idempotency evidence.
  No mirror tables, migration exclusions or disabled database constraints were used.
- All seven relational sections were populated and admitted from the migrated
  schema. Bigint sequence values retain decimal-string precision; tombstone
  timestamps retain canonical milliseconds.
- Wrong workspace/base, absent sheet, deleted sheet and deleted base refuse;
  a genuinely empty live sheet returns seven empty sections.
- Two independent connections prove uncommitted schema/record changes are not
  visible, a REPEATABLE READ snapshot remains unchanged after the writer commits,
  and a subsequent transaction sees both updated sections.
- Before the source fix, the deleted-base negative failed with missing expected
  rejection. With `b.deleted_at IS NULL`, the complete driver passed.
- Removing that predicate after repair makes the required unit contract fail
  (1 failed / 11 passed); restoration returns unit plus neighbor to 26/26.
- Acceptance TypeScript project, source ESLint and diff-check passed.
- Driver closes both fixture connections, checks zero remaining database
  connections, drops its uniquely named database and checks zero database residue.
  Independent prefix census also returned zero databases and zero connections.
- The task-owned PostgreSQL instance was stopped and its data directory removed.
- Terra independently reviewed the bounded delta without running tests or DB.
  It found no P1 and one P2 evidence-wording issue about the second migration
  invocation. The no-op limitation above closes that wording issue; no full
  capture review verdict is claimed.

## Remaining Boundaries

This driver is local acceptance, not a new required-CI database lane. The existing
unit lane contains the SQL predicate regression check; remote green does not
prove this driver ran. PostgreSQL 15 / local Node 24 evidence is not a Node 18
full-schema acceptance claim.

The transaction test establishes snapshot visibility, not the complete archive
capture concurrency protocol. The seven-section loader still uses one SQL
statement; source seals, attachment/permission evidence, encrypted receipts,
catalog publication, retry/resume and the public restore/UI cycle remain open.
The existing section bootstrap is one-time initialization and must not be reused
as stale authority for a second manual capture. No marker deletion, one-time-only
product restriction or weaker source proof is introduced here.

No flag, dispatch, customer-data/storage, deployment or production action.
