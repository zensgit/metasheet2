# Multitable Time Machine exact-anchor recovery - development and verification

Date: 2026-07-28

## 1. Status and authority

Status: **IMPLEMENTED AND LOCALLY VERIFIED, DRAFT-ONLY; CODE DEFAULTS OFF AND
AUTHORITY TRIGGERS DEFAULT DISABLED**.

This document is the stable closeout ledger for the consolidated exact-anchor
Revert/Reset implementation. It supersedes the volatile PR-head inventory that
previously occupied this file.

The delivery includes:

- exact committed-operation preview identity and one-time execute token;
- Revert and Reset through one fenced transaction kernel;
- database-fresh final authorization over the true write set;
- deterministic multi-sheet/multi-record lock ordering;
- a fail-fast authority lease for RBAC and permission changes;
- exact-anchor route and frontend wiring;
- migration, containment, CI-placement, real-DB, unit, frontend, and mutation
  evidence.

It does **not** claim merge, staging acceptance, production deployment, feature
flag enablement, authority-trigger activation, or customer acceptance. The
operator boundary is deliberately separate.

## 2. Delivered design

### 2.1 Exact recovery authority

- Preview accepts `historyBatchId` or `anchorOperationId`. A free-form `asOf`
  timestamp cannot become a destructive authority.
- A batch resolves to its terminal sealed operation. Execution is anchored to
  the exact causal sequence, not a wall-clock approximation.
- The signed token binds mode, operation/sequence, checkpoint, actor,
  authorization scope, schema, live records, and authoritative live links.
- Apply reads the destructive mode only from verified claims. A request cannot
  reuse a Revert token to drive Reset.
- Token burn, plan reconstruction, validation, writes, revisions, endpoint
  sealing, and mutation hooks share one transaction. Any later refusal rolls
  the burn back.

### 2.2 Revert and Reset

The wired routes are:

- `POST /sheets/:sheetId/revert-preview`
- `POST /sheets/:sheetId/revert-execute`
- `POST /sheets/:sheetId/reset-preview`
- `POST /sheets/:sheetId/reset-execute`

Revert restores changed values on records that are live both at the anchor and
now. It keeps records created later. Reset additionally moves records created
after the anchor to Trash. Reset requires acknowledgement plus typed `reset`;
Revert does not borrow that destructive confirmation contract.

Both execute routes call the same L8 kernel. The kernel proves a real
transaction, takes the canonical writer fence, checks the trusted-history
flags, repeats authorization under commit-held authority leases, re-resolves
the checkpoint, reconstructs the anchor, verifies schema/live/link hashes, and
either commits the entire plan or writes nothing.

### 2.3 Global lock order

The apply path uses one global order:

1. canonical source-sheet fence;
2. all involved `meta_sheets`, sorted by id, `FOR NO KEY UPDATE NOWAIT`;
3. the complete source live set plus discovered foreign records, sorted by
   `(sheet_id, record_id)`, `FOR UPDATE NOWAIT`;
4. user, role, then member-group authority leases;
5. final full-read and per-write authorization;
6. mutation.

`FOR NO KEY UPDATE` on sheet rows is intentional. It preserves compatibility
with the FK `KEY SHARE` acquired by an ordinary insert into `meta_records`;
strengthening it to `FOR UPDATE` recreates a real 40P01 cycle. `NOWAIT`
prevents lock acquisition order from becoming another blocking edge: a
competing recovery or writer receives a values-free retry refusal.

`NOWAIT` on record rows is also load-bearing. A normal link writer locks its
source record before inserting a foreign-key-checked edge. If recovery waited
while holding another record, the writer and recovery could form
`writer(B -> A) / recovery(A -> B)` ABBA. Recovery instead returns a
values-free retry refusal and rolls back the whole transaction immediately.
Because this is a deliberately conservative whole-relation lock surface, a hot
sheet or popular foreign target can require re-preview with bounded jittered
backoff; staging acceptance must measure refusal rate as well as latency.

No foreign record is first discovered and locked after authorization starts.
Missing targets are reported only after final authorization, preserving the
no-oracle boundary.

### 2.4 Authority stability

The authority substrate consists of six functions and exactly nine triggers on
eight platform tables:

- `users` (two triggers);
- `user_permissions`;
- `user_roles`;
- `role_permissions`;
- `platform_member_group_members`;
- `spreadsheet_permissions`;
- `field_permissions`;
- `record_permissions`.

Ordinary authority writers take compatible shared transaction try-locks.
Recovery takes exclusive transaction try-locks for only the actor/person users
and their assigned roles/groups. Neither side waits on this advisory layer:

- a writer colliding with recovery raises SQLSTATE `40001` with
  `METASHEET_RECOVERY_AUTHORITY_BUSY`;
- owned multitable permission routes map it to typed HTTP 409;
- transient authority-table DDL contention returns the same retryable `busy`
  class rather than masquerading as a missing substrate;
- recovery returns a values-free retry/refusal and rolls back.

This removes both the recovery/writer advisory ABBA and the writer/writer
serialization imposed by the earlier blocking design.

All nine triggers are installed **DISABLED**. Recovery obtains a
`ROW EXCLUSIVE NOWAIT` schema lease, which remains compatible with ordinary
DML and another recovery while blocking trigger DDL, and verifies the
canonical enabled substrate before it can acquire authority keys: table,
trigger name/type, update-column set, function identity, trigger arguments,
function signature/language/security mode/volatility, and normalized
executable-body fingerprint. Missing, partial, wrong-table, wrong-argument,
wrong-function, body-drifted, or disabled posture fails closed as
`recovery-trust-required`.
The table lease cannot freeze a privileged concurrent
`CREATE OR REPLACE FUNCTION`; deployment of these functions while recovery is
running is therefore an explicit operator boundary, not a property claimed by
the runtime fingerprint check. The canonical deployment schema is `public`;
installations that relocate these tables/functions to another schema refuse
closed until an explicitly reviewed schema-aware contract exists. Any reviewed
function-body change must update the runtime fingerprint constants and make the
real-DB positive-control suite green in the same change.
Trigger activation is a separate operator action and is not performed by this
delivery.

### 2.5 Link integrity

`meta_links.foreign_record_id` is protected by:

```text
FOREIGN KEY (foreign_record_id) REFERENCES meta_records(id)
ON DELETE NO ACTION
DEFERRABLE INITIALLY IMMEDIATE
NOT VALID
```

`NOT VALID` preserves historical dangling rows for the existing filtered-read
and repair paths while PostgreSQL enforces every new or changed edge.
`NO ACTION` is the safety property: target deletion must explicitly capture
and remove authoritative inbound links in the same transaction. The database
must never silently cascade them before tombstone capture.

The corrective migration replaces only the known historical CASCADE shape. A
same-name constraint with another source column, target, action, or
deferrability fails loudly.

### 2.6 Automation lock markers

Automation lock/unlock now performs:

```text
mint operation -> version marker(operation_id) -> seal operation
```

inside one transaction. Seal failure rolls back the version bump, marker, and
endpoint. With the operation-ledger flag off, the prior marker shape remains
and no endpoint is minted.

During a rolling deploy before `meta_record_version_markers` exists, the marker
helper deliberately skips the marker rather than poison an older transaction
with `42P01`. That is not a trusted chain: strict recovery later refuses the
resulting hole. The atomic marker guarantee applies once the marker migration
is present.

### 2.7 Deliberate resurrection boundary

An anchor plan containing a currently deleted record is presentation-only and
cannot mint an execute token. Apply independently refuses any such plan as
`INBOUND_UNPROVABLE`.

This is not a claim that deleted records can never be restored. Record-level
Trash restore exists. It is a narrower statement: exact whole-sheet recovery
does not yet have an authoritative reconstruction of all historical inbound
edges, so it refuses to synthesize a partial graph.

## 3. Database and containment posture

Migrations:

- `zzzz20260721120000_guard_meta_links_live_targets.ts`
- `zzzz20260721121000_add_recovery_authority_locks.ts`
- `zzzz20260728120000_correct_recovery_authority_locks.ts`
- `zzzz20260728121000_correct_meta_links_live_target_fk.ts`

The containment helper verifies:

- all Global History flags are off;
- exactly nine authority triggers exist and are disabled;
- all six authority function definitions match their expected fingerprints;
- the target FK has the exact NO ACTION/NOT VALID shape;
- every expected backend container reports the same PASS posture.

The helper is source-hash pinned in the workflow. A missing container result,
schema read failure, trigger/function drift, unexpected enabled trigger, or FK
drift is a non-PASS.

## 4. Verification

All commands ran in the isolated worktree
`/private/tmp/metasheet2-tm-closeout-20260728`. The canonical dirty checkout was
not modified.

### 4.1 Fresh migration and replay

A new PostgreSQL 15.17 database was created with the same
`MIGRATION_EXCLUDE` list used by `plugin-tests.yml`.

1. full migration to latest: passed;
2. the two 2026-07-28 corrective migrations were reported as executed;
3. second migration run: passed with no new work;
4. containment schema inspection: PASS.

This evidence does not reuse a database where the new constraints or triggers
were hand-applied.

### 4.2 Real-DB behavior

One migrated database ran:

| Suite | Result |
| --- | ---: |
| exact-anchor apply | 53/53 |
| exact-anchor route wiring | 29/29 |
| exact-anchor reconstruction | 17/17 |
| exact-anchor plan | 10/10 |
| L6-a sealed operation endpoint | 24/24 |
| live-link target FK migration | 14/14 |
| recovery authority stability | 13/13 |
| **Total** | **160/160** |

The suites include two-connection barriers, `pg_locks` witnesses, actual
HTTP route writes, migration drift, rollback residue checks, and a real
PostgreSQL deadlock discriminator.

### 4.3 Static, unit, frontend, and ops gates

- backend `tsc --noEmit`: passed;
- backend unit suite: 6487/6487;
- frontend Revert/Reset/history matrix: 64/64;
- frontend `vue-tsc -b`: passed;
- flag manifest, exact CI placement, status helper, and schema containment:
  59/59.

The six DB-only files are excluded from the default no-DB Vitest job and
whole-file wired into the required PostgreSQL job. The placement contract
rejects comment-only and wrong-step decoys.

### 4.4 Discriminating mutations

Each mutation was isolated and restored before the positive rerun:

| Mutation | Required red |
| --- | --- |
| sheet lock `FOR NO KEY UPDATE` -> `FOR UPDATE` | `SHEET-LOCK-FK-COMPAT` produces a real 40P01 |
| sheet lock `NOWAIT` removed | `GLOBAL-LOCK-ORDER` times out with `57014` instead of refusing immediately with `55P03` |
| record lock `FOR UPDATE NOWAIT` -> blocking `FOR UPDATE` | `RECORD-NOWAIT-LINK-WRITER` produces a real 40P01 |
| authority table lease `ROW EXCLUSIVE` -> `ACCESS SHARE` | trigger DDL succeeds while recovery owns the lease; ordinary DML remains the positive control |
| authority table lease `ROW EXCLUSIVE` -> self-conflicting `SHARE UPDATE EXCLUSIVE` | a second recovery for a disjoint subject returns `busy` |
| authority-table `55P03` -> substrate-unavailable | transient DDL contention golden receives `unavailable` instead of `busy` |
| exact trigger table/name check -> name-only | wrong-table same-name trigger is incorrectly accepted |
| canonical authority schema decision ignored | wrong-table, wrong-argument, wrong-function, and drifted-body goldens all accept an unsafe lease |
| busy-error classifier -> always false | multitable permission write returns 500 instead of typed 409 |
| target FK `NO ACTION` -> `CASCADE` | FK migration shape golden reds |
| automation marker drops operation ledger | W4 endpoint anchor golden reds |

These probes establish that the tests protect the specific guards. They do not
by themselves prove production reachability; reachability is separately tied
to the actual route, trigger, and migration call sites above.

## 5. Frontend evidence boundary

The earlier browser evidence remains useful for the unchanged Revert/Reset
interaction:

- [Revert preview](./assets/multitable-time-machine-exact-anchor-20260721/revert-preview.png)
- [Reset confirmation](./assets/multitable-time-machine-exact-anchor-20260721/reset-confirm.png)
- [Reset success](./assets/multitable-time-machine-exact-anchor-20260721/reset-success.png)
- [Trash after Reset](./assets/multitable-time-machine-exact-anchor-20260721/trash-after-reset.png)

It was captured against the 2026-07-21 local branch, not this consolidated
2026-07-28 head, so it is not counted as exact-head runtime proof. The current
frontend contracts and type-check are exact-head evidence.

## 6. Flags and rollout boundary

No environment or host was changed or inspected in this round. The code
defaults remain off:

- `MULTITABLE_ENABLE_WRITER_FENCE`
- `MULTITABLE_HISTORY_CONTIGUITY_STRICT`
- `MULTITABLE_ENABLE_SHEET_REVERT`
- `MULTITABLE_ENABLE_PIT_RESET`
- `MULTITABLE_ENABLE_PIT_UNDELETE`
- operation-endpoint and tombstone/capture flags in the Global History
  manifest.

Authority triggers also remain disabled after migration. Enabling flags without
the complete trigger posture causes recovery to fail closed; enabling only a
subset of triggers is invalid.

Merge is not rollout authorization. Staging must follow the O-2 ladder:
obtain the default-inert containment PASS first, activate the exact trigger set
under a separately reviewed owner/ops procedure, run an activation-aware
catalog/behavior probe, and only then perform browser/real-data acceptance.
The default-inert helper intentionally fails after activation and must not be
misrepresented as the enabled-posture probe. Production remains a separate
owner and operator decision with rollback evidence.

## 7. Remaining product development

The default-OFF exact-anchor live-row Revert/Reset code is built and locally
verified. A broad, retention-surviving enterprise Time Machine still requires
separate design and implementation:

1. **Exact whole-sheet resurrection.** Archive/reconstruct historical inbound
   relationships and preserve neighbor-consent and permission semantics.
2. **Recovery after retention purge.** Store immutable tenant-scoped
   checkpoints plus deltas in an archive tier. A version number alone cannot
   recreate purged bytes.
3. **Recovery of pre-capture physical deletion.** This requires a database
   backup, external archive, or customer source; application history cannot
   synthesize evidence that was never stored.
4. **Large-base asynchronous recovery.** Add frozen preview/hash, idempotent
   job identity, chunking, retries/resume, progress, conflicts, and explicit
   partial-completion governance.
5. **Cross-sheet atomic product semantics.** No current route promises a
   long-lived transaction spanning several sheets.
6. **Operator activation and production acceptance.** Enable the exact
   authority-trigger set and flags only through the separately reviewed O-2
   ladder.

## 8. Verdict

The closeout branch resolves the known merge-time blockers:

- the proven authorization/recovery deadlock;
- recovery/recovery record-vs-sheet lock inversion;
- writer-wide advisory serialization;
- cross-sheet link-writer/recovery record-lock ABBA;
- same-name trigger/function semantic spoofing at runtime;
- fail-open same-name FK acceptance;
- unsafe target-side cascade;
- missing automation operation markers;
- CI and containment blindness to these schema contracts.

The correct claim is therefore:

> Exact-anchor live-row Revert/Reset is implemented and locally verified behind
> default-off flags and default-disabled authority triggers. It is ready for
> exact-head review as a Draft, not ready for staging or production enablement.

It is not yet equivalent to a retention-surviving, large-scale, whole-history
Time Machine product.
