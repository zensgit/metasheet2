# Multitable Time Machine exact-anchor recovery - development and verification

Date: 2026-07-21

## 1. Status and authority

Status: **IMPLEMENTED AND LOCALLY VERIFIED, DRAFT-ONLY**.

This document records the exact-anchor recovery wiring built on the only current
authority chain:

1. PR #4472, L6-b exact-anchor resolution, head `8ced2ef50`;
2. PR #4474, L7 recovery planning, head
   `5190c455ec01c13b290352037edd419888750b64`;
3. PR #4478, L8 atomic apply, head
   `a54718d22d078ff486dc8b02dcfa11036bcab6af`;
4. branch `codex/timemachine-exact-anchor-route-wiring-20260721`, which wires
   the authority chain into the backend routes and frontend.

The older #4417/#4445/#4446 token-contract stack is superseded for this work.
It is not an implementation input and must not be merged into this chain.

This delivery does **not** claim any merge, staging or production deployment,
flag enablement, or customer acceptance. All runtime recovery flags remain
code-default OFF. The local browser run used flags only in an ephemeral local
backend process.

## 2. Scope delivered

### 2.1 Exact recovery authority

- Destructive recovery accepts one server-verifiable committed-history point:
  `historyBatchId` or `anchorOperationId` at preview time.
- A nonblank free-time `asOf` value is rejected. A selected history batch is
  resolved to its terminal sealed operation; execution never treats wall-clock
  time as a commit boundary.
- Execute accepts only the signed preview identity. Request-supplied anchor,
  mode, or alternate authority is rejected.
- The token binds the recovery mode, exact operation/seq, checkpoint, actor,
  authorization scope, schema, live records, and authoritative live links.
- `RECONSTRUCTION_CAUSALITY_LANDED` changes to `true` in the same reviewable
  wiring change. This constant does not enable any runtime feature flag.

### 2.2 Revert and Reset semantics

- `POST /sheets/:sheetId/revert-preview`
- `POST /sheets/:sheetId/revert-execute`
- `POST /sheets/:sheetId/reset-preview`
- `POST /sheets/:sheetId/reset-execute`

Revert restores records that existed at the selected operation and keeps rows
created later. Reset additionally moves rows created after the selected
operation to Trash. Reset requires both the warning acknowledgement and typed
`reset`; Revert does not borrow Reset's typed-confirm contract.

Both execute paths call the same L8 transaction kernel. The transaction takes
the canonical sheet fence, re-resolves database-fresh authority, rebuilds the
plan under the fence, verifies the token-bound identity, writes revisions and
outbox rows, and either commits the whole operation or writes nothing.

### 2.3 Deliberate fail-closed resurrection boundary

An exact-anchor plan that would resurrect a currently deleted record is
disclosed as non-executable with `INBOUND_UNPROVABLE`. It receives no execution
token. The implementation does not infer historical inbound links from a
first-delete-after-time heuristic and does not silently restore a partial
relationship graph.

This is a correctness boundary, not completion of value recovery for records
whose tombstones were never captured or whose retained evidence was purged.

### 2.4 Authorization and oracle resistance

- Preview performs the full-read and sheet-management checks before exposing
  whether a requested exact anchor exists.
- Execute re-runs authorization from the database rather than trusting stale
  request/JWT/cache permissions.
- Actor, role, member-group, direct sheet/field/record grants, and permission
  changes share ordered advisory authority locks with recovery execute.
- User disable/delete, role changes, group changes, and direct grant revocation
  therefore cannot pass between the final authorization decision and commit.
- Refusals preserve the route's no-oracle ordering and values-free response
  posture.

### 2.5 Link, person, and schema integrity

- Preview hydrates links from authoritative `meta_links` rows; stale JSON
  snapshots are not trusted as link authority.
- The live-set HMAC includes authoritative links, so a link-only drift invalidates
  the preview identity.
- Cross-sheet target rows and person users/roles are locked before apply.
- `meta_links.foreign_record_id` gains an `ON DELETE CASCADE`, `NOT VALID`
  foreign key. Historical invalid rows are tolerated for migration safety, but
  new invalid edges cannot commit. Preview filters historical dangling edges.
- Supported field create and field patch routes join the canonical recovery
  fence before schema reads/writes. This closes the schema-change window between
  the final preview check and the recovery commit.
- Database deadlock/serialization conflicts are mapped to retry/re-preview
  responses instead of leaking a raw 500 where the route owns the conflict.

### 2.6 Frontend wire contract

- The picker lists audited Global History points only; manual datetime input is
  absent.
- Revert and Reset are separate commands, each capability-gated.
- A Reset with no post-anchor-created rows is presented as Revert rather than
  manufacturing a destructive confirmation.
- Reset disables submit until both acknowledgement and typed confirmation are
  present.
- Modal-open payload drift, sheet switch, stale preview, and double submit are
  rejected instead of silently executing a different plan.
- Success shows reverted and trashed counts and links directly to Trash.

## 3. Database changes

### 3.1 Live link target constraint

`zzzz20260721120000_guard_meta_links_live_targets.ts` adds:

```text
meta_links.foreign_record_id -> meta_records.id
ON DELETE CASCADE
NOT VALID
```

The `NOT VALID` posture deliberately separates historical cleanup from future
write integrity. It does not weaken enforcement for newly inserted/updated
edges.

### 3.2 Recovery authorization locks

`zzzz20260721121000_add_recovery_authority_locks.ts` adds ordered advisory-lock
functions and nine non-internal triggers across:

- `users` lifecycle and permission-bearing updates;
- `user_permissions`;
- `user_roles`;
- `role_permissions`;
- `platform_member_group_members`;
- `spreadsheet_permissions`;
- `field_permissions`;
- `record_permissions`.

Subject locks are ordered user, then role, then group. Recovery takes the same
keys before the database-fresh authorization read.

## 4. Verification

All commands below ran from the isolated worktree. No canonical dirty checkout
files were modified.

### 4.1 Authority stack

- #4472 exact head: independent adversarial gate CLEAR.
- #4474 exact head: independent adversarial gate CLEAR.
- #4478 exact head: independent adversarial gate CLEAR.
- Manual exact-head CI run `29805252119`: required jobs green.

### 4.2 Backend tests

- Branch-affected real-DB bundle: **24 files, 345 tests, all passed** on a
  migrated PostgreSQL database.
- Exact-anchor/unit bundle: **5 files, 84 tests, all passed**.
- Backend `tsc --noEmit`: passed.

The broad real-DB run was deliberately repeated on a reused database. It found
and corrected two fixture-only assumptions:

1. seven legacy route fixtures had request permissions but no database
   permissions, which the new database-authoritative check correctly refused;
2. the burn-retention test assumed its global sweep owned every expired row.

The fixtures now drive request and database authority consistently. The burn
test checks the reported global deletion delta while still pinning this
fixture's old/mid/fresh token outcomes.

### 4.3 Frontend and ops contracts

- Recovery frontend bundle: **4 files, 43 tests, all passed**.
- Web `vue-tsc -b`: passed.
- Flag manifest, illegal-combination matrix, exact-anchor CI placement, and
  status helper: **46 tests, all passed**.

### 4.4 Migration replay

On a newly created PostgreSQL database:

1. full migration replay passed;
2. a second migrate had no pending work;
3. rollback of the authority-lock migration passed;
4. rollback of the link-target migration passed;
5. re-applying both migrations passed.

Post-replay inspection returned:

```text
meta_links_foreign_record_id_fkey|false|c
recovery authority triggers: 9
```

The FK behavior was also exercised directly: a historical dangling row survives
the migration, a new dangling insert fails with `23503`, and deleting a valid
target cascades its edge.

### 4.5 Mutation evidence

Each probe was restored before the next run:

| Mutated guard | Required red signal |
| --- | --- |
| drop live-link FK | `LINK-FK-COMMIT-ORDERS` fails |
| drop record-permission authority trigger | `AUTHORITY-SUBJECT-LOCKS` fails |
| omit links from live-set hash | `LIVE-LINK-AUTHORITY` accepts stale token and fails |
| remove field-create fence | B3c returns 201 instead of the required blocked 409 |
| remove field-patch fence | B3d returns 200 instead of the required blocked 409 |

### 4.6 Independent review

- Grok Build reviewed the recovery/security delta refute-first. It found the
  remaining schema-writer race; after the field create/patch fence fix and its
  constructed-race goldens, its focused re-review returned CLEAR.
- Kimi independently challenged link-FK equivalence, role/person locking,
  authority fan-out, deadlock handling, and missing-link rollback. Its findings
  were folded into the final production delta; Kimi's output is advisory, not a
  substitute for the exact-head test evidence.
- Claude Code was attempted for a read-only Opus pass, but the local OAuth
  session was expired. No Claude result is counted as verification evidence.

## 5. Browser evidence

The browser smoke used a fresh local database and ephemeral backend/frontend
processes. Runtime flags were enabled only for that local process.

Verified behavior:

1. the picker exposes audited history operations and no free-time input;
2. Revert preview is non-destructive and restored `Gamma` to `Beta`;
3. Reset with no delete set honestly degrades to Revert;
4. after creating a post-anchor row, Reset requires checkbox plus typed
   `reset`;
5. execute moved the new row to Trash and reverted the survivor;
6. Trash displayed the moved row and its Restore action.

Evidence:

- [Revert preview](./assets/multitable-time-machine-exact-anchor-20260721/revert-preview.png)
- [Reset confirmation](./assets/multitable-time-machine-exact-anchor-20260721/reset-confirm.png)
- [Reset success](./assets/multitable-time-machine-exact-anchor-20260721/reset-success.png)
- [Trash after Reset](./assets/multitable-time-machine-exact-anchor-20260721/trash-after-reset.png)

## 6. Flags and rollout boundary

This delivery changes no environment and enables no feature. The relevant code
defaults remain OFF:

- `MULTITABLE_ENABLE_WRITER_FENCE`
- `MULTITABLE_HISTORY_CONTIGUITY_STRICT`
- `MULTITABLE_ENABLE_SHEET_REVERT`
- `MULTITABLE_ENABLE_PIT_RESET`
- `MULTITABLE_ENABLE_PIT_UNDELETE`

The operator ladder remains a separate owner action. A merge is not permission
to enable staging or production. Reset also remains incompatible with active
meta-revision retention under the current manifest rule.

## 7. Remaining work and decisions

### 7.1 Current ratified exact-anchor scope

No additional runtime slice is known inside the ratified exact-anchor
Revert/Reset scope. What remains is process and operations:

1. review and land #4472 -> #4474 -> #4478 -> this wiring PR in order;
2. rerun required CI on each real target base;
3. perform the staging operator ladder and browser acceptance;
4. make production enablement a separate per-flag decision with rollback
   evidence.

### 7.2 Not implemented and not implied by this delivery

The following product capabilities require their own ratification and design
lock. They must not be described as already supported:

1. **Recovery after retention purge.** This needs an immutable, tenant-scoped
   archive of checkpoint plus deltas and a single reconstruction authority. A
   version number cannot recreate payload bytes that were permanently purged.
2. **Recovery of data deleted before tombstone capture.** Application history
   cannot synthesize evidence that was never stored. Only a database backup,
   external archive, or customer-supplied source can recover it.
3. **Executable record resurrection with historical inbound links.** The
   current exact-anchor route intentionally refuses this as
   `INBOUND_UNPROVABLE`. A future design must archive relationship evidence and
   preserve permission/neighbor-consent semantics.
4. **Large-base or whole-base asynchronous recovery.** The current synchronous
   path retains its size ceiling and per-sheet transaction semantics. A future
   job model needs frozen preview/hash, idempotent job identity, retries,
   progress, conflict handling, and explicit partial-completion governance.
5. **Cross-sheet atomic restore.** No current path promises a long transaction
   spanning several sheets.

These are the remaining gaps to a broad, retention-surviving enterprise Time
Machine product. They are not blockers to reviewing the default-OFF
exact-anchor Revert/Reset implementation delivered here.

## 8. Verdict

The current ratified code-development target is complete as a default-OFF Draft:
exact committed history points drive Revert and Reset through one fenced,
database-authorized, token-bound apply path; the frontend exposes the same
authority and destructive distinction; migrations, real-DB behavior,
mutation probes, static checks, ops contracts, and browser flows have passed.

This is **not yet a production-complete Time Machine**. Landing, staging proof,
production flag decisions, retention-surviving archive restore, and large-scale
asynchronous recovery remain separate gates.
