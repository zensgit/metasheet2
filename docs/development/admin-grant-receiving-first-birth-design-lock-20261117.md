# Admin grant receiving first-population barrier

This bounded B2 prerequisite adds database enforcement for a landed receiving INSERT against older parent snapshots. Independent design review accepted the three-trigger design with the corrections below. It does not authenticate an evidence producer, enable a purpose, grant login or admit historical rows. Existing S1/S2 migrations, receiving reader and repair migration remain unchanged.

## Enforcement

Add `zzzz20261117193000_admin_grant_receiving_first_birth.ts` with three ordinary AFTER INSERT FOR EACH ROW triggers and one invoker-rights function. Use fixed branches, safely quoted installation schema and bound UUIDs:

- Application pin: update its actual `directory_integrations` parent, `schedule_cron = schedule_cron`.
- Binding pin: update its actual `user_external_identities` parent, `profile = profile`.
- Evidence: update the integration first, then the live identity with those same assignments.

Every landed insert executes its branch, including new evidence when pins already exist. Require exactly one affected parent per update; otherwise values-free SQLSTATE 55000 refusal and whole-statement rollback. Do not update primary keys, timestamps, material configuration or identity slots. S2's unchanged-material early returns preserve revision and evidence state on these no-op logical writes. Actual tuple version changes provide the barrier. No new advisory lock, users SQL, custom GUC authority marker, trigger-depth bypass, SECURITY DEFINER, autonomous transaction or repair suppression.

Bind the function's search path at installation to `pg_catalog, <quoted verified installation schema>, pg_temp`. The unchanged real DingTalk repair trigger contains unqualified relation references and inherits this path. S3's own references remain explicitly qualified. Caller paths and temporary shadows are not authority. Reject trigger attachment outside the three fixed schema-owned receiving relations. Do not implement a generic per-row FK catalogue router.

Install validates the exact four S1 FK source/target relation OIDs, schema, columns, id targets and delete actions. Require validated immediate constraints. Validate the two writable non-key columns and both enabled S2 AFTER UPDATE row triggers with their expected functions. Perform definitive validation after obtaining receiving-table locks. Ordinary schema/DDL authority and migration dependency order remain the boundary; no arbitrary later privileged DDL guarantee.

An INSERT conflict DO NOTHING creates no parent version. In ON CONFLICT DO UPDATE, only the conflict update arm lacks an AFTER INSERT event; its actual insert arm runs the barrier. Preserve native FK trigger ordering: missing parents ordinarily fail 23503 before S3, not an invented 55000. Do not rename triggers to bypass native checks.

## Migration boundary

Up and down require an actual same-connection open transaction and exactly READ COMMITTED, using the existing S2 transaction-proof convention. Save bounded local timeouts, acquire ACCESS EXCLUSIVE on application pins, binding pins, then evidence; definitively validate prerequisites and require all three receiving tables empty before creating or dropping any S3 object. No backfill or installation parent bump. Restore timeouts on controlled refusals; propagate native SQL errors with whole-transaction rollback. No parent ACCESS EXCLUSIVE locks.

Nonempty up/down refuse with fixed `ADMIN_GRANT_FIRST_BIRTH_UP_BLOCKED` / `ADMIN_GRANT_FIRST_BIRTH_DOWN_BLOCKED`; autocommit/isolation/prerequisite refusals use fixed direction-specific codes. Down removes only the three S3 triggers and their function, preserving all S1/S2 objects and data. Successful down removes this admission barrier and cannot imply continued protection.

## Real PostgreSQL acceptance

Use a distinct owned synthetic schema and the actual S1/S2/S3 migrations. Never replace the existing S1+S2 old-snapshot counterexample. Required cases:

1. An unlocked old RR snapshot predates a committed birth; subsequent material/slot UPDATE raises native 40001, whole writer rollback, committed parent tuple changed, inserted revisions/evidence preserved.
2. Four separate intermediate-write orders: application pin → integration mutation → evidence; evidence → integration mutation → application pin; binding pin → identity mutation → evidence; evidence → identity mutation → binding pin. Attempt stale mutation after the first commit and before the second insert, so the second barrier cannot conceal a missing first one.
3. Fresh evidence after a pin-visible RR snapshot rejects later integration and identity mutation independently. Respect the one-live-evidence unique index with pin-only or legally revoked predecessor fixtures.
4. RC material/slot UPDATE actually blocks behind an uncommitted birth; after birth COMMIT, writer resumes, steps the newly committed pin once and revokes new evidence once. Failure of native trigger snapshot refresh is a design failure, not an acceptable live-evidence outcome.
5. Parent SHARE holder blocks birth; after holder ends, birth succeeds. Do not assume a deadlock from this single wait edge. Birth linearized after the writer's final A may be legitimate; producer freshness is separate.
6. A real repair cycle uses A holding users FOR UPDATE, B holding identity no-key update while the real repair users SHARE waits, then A requesting the identity. Observe both native edges, accept either actual 40P01 victim, rollback it whole and verify all victim receiving/parent effects disappear. No cancel, savepoint or retry.
7. Install the real DingTalk repair migration with its needed small fixtures. Under hostile caller paths and conflicting temp users/repair shadows, healthy birth resolves real tables, retains slot/profile/timestamps and holds real identity/user locks. Prove locks with conflicting native probes and blocker PIDs, then prove probes complete after release; uncontended pg_locks tuple entries alone are insufficient.
8. Duplicate DO NOTHING leaves ctid unchanged; RR snapshot must precede that duplicate and later material UPDATE still performs normal S2 invalidation. Healthy all-three birth, dormant writes, already-visible S2 writes, explicit rollback, missing-parent23503 and safe schema qualification retain exact row/value/count assertions.
9. Empty-check races both orders: an earlier committed row blocks up/down; a later insert blocks on migration's receiving locks and after successful up executes the new trigger. Migration rollback leaves the prior schema. Verify timeouts and no partial S3 objects.

Source-fault checks are distinct: zero-row update must refuse55000 with no birth; bypassing a complete selected update-and-count branch must permit actual birth then the corresponding stale ABA commit. Mutate application, binding and both evidence-parent branches independently; assert persisted rows, restore exact source bytes and rerun green. Do not fabricate SQLSTATE or count a refusal as the stale-state counterexample.

## Scope and costs

Every new evidence row writes its integration and identity tuples. This serializes births sharing a connection and may abort old RR display-only parent writers. That conservative availability cost does not justify dropping evidence bumps. No blanket HOT or universal ABA claim.

Author write set is only the new migration and `tests/integration/admin-grant-receiving-first-birth.db.test.ts`. Main owns required approval-db registration, default-test exclusion and workflow ownership/relocation guard, taking the union with concurrent additions. Missing required DB fails; whole-file runtime evidence has zero skips. Native review and source-fault qualification precede local slice acceptance. Production availability, first-population producer admission, universal ABA closure and login propagation remain unearned.
