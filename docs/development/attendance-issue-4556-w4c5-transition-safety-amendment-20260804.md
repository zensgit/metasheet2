# Attendance #4556 W4C-5 Transition Safety Amendment

Date: 2026-08-04
Status: **PROPOSED / staging HOLD**
Decision: `OD-W4C-61`
Baseline: `783eb72fe038083e21d896bc220c7afcaffaf88d`

This amendment was discovered while preparing the owner-authorized W4C-5 tools
and runbook. It authorizes no transition, flag, staging access, deployment,
soak, production/customer data use, external notification, or issue closure.

## 0. Finding

The RATIFIED W4 lock requires each rollout transition to enforce a closed legal
transition matrix and all mutable database preconditions while holding the
exclusive org rollout lock. The current internal command is not yet a safe
operator transition boundary:

1. `packages/core-backend/src/attendance/w4c3a-rollout-control.ts:36-42`
   accepts every rollout state as a target. The command rejects only a no-op;
   it does not enforce the seven legal source/target pairs in the lock.
2. `:261-286` silently creates a missing org row as
   `scope='synthetic_staging'` without proving that the org is the exact named
   allowlisted synthetic org.
3. `:332-363` locks source operation rows, jobs, batches, items, targets, and
   records, but it does not inspect request snapshots, legacy request facts,
   unresolved ingress reviews, all incomplete operations, or the full
   retryable-job posture matrix required by the lock.
4. `:474-509` checks only legacy batch closure/preimage before updating state.
   Its rollout event stores empty evidence and the normalized `correlationId`
   is not persisted.
5. The existing tests prove closure/transition serialization and legacy-batch
   blocking. They do not prove illegal-pair rejection or the complete
   eligibility/authority/suspend/resume gate.

A read-only CLI preflight followed by the current command would not repair this
gap. State can change between those transactions, so that shape contains a
time-of-check/time-of-use window. A direct SQL wrapper would be a larger bypass.

## 1. Closed Transition Matrix

Only these pairs are legal:

| Current | Target | Comparison write posture |
| --- | --- | --- |
| `legacy` | `shadow` | `shadow` |
| `shadow` | `eligible` | `shadow` |
| `eligible` | `shadow` | `shadow` |
| `eligible` | `authoritative` | `authoritative` |
| `shadow` | `legacy` | `legacy_projection_only` |
| `authoritative` | `suspended` | preserved `authoritative` |
| `suspended` | `authoritative` | preserved `authoritative` |

Every other pair fails before rollout-state/event DML. The comparison posture
is obtained from the same canonical posture resolver used by source writers;
the command must not compare persisted rollout values directly with normalized
write postures.

## 2. Safe Command Boundary

The canonical transition function must perform the following in one database
transaction:

1. Validate an exact org ID, actor ID, correlation ID, engine version, expected
   current state/version, target state, and evidence-manifest SHA-256.
2. Acquire the canonical exclusive org rollout advisory lock first.
3. Lock and reload the rollout row. Missing state may be created only for the
   exact allowlisted synthetic org and only as part of `legacy -> shadow`.
4. Reject a stale expected state/version and any pair absent from section 1.
5. Acquire the existing operation/batch/target lock domain in canonical order.
6. Re-evaluate every database-backed transition predicate in section 3 under
   those locks.
7. Insert one event containing the exact manifest hash, correlation ID,
   precondition counters, source/target states, comparison posture, and the
   external evidence references from section 4.
8. Update the rollout state only after the event insert succeeds. Event and
   state update commit or roll back together.

No route or generic plugin service is added. The command stays an internal
core-backend boundary invoked only by a separately authorized operator tool.
The current function is hardened in place or replaced with one private
fail-closed boundary; two competing transition implementations are forbidden.

## 3. Database-Backed Predicates

The transaction returns `BLOCKED` and performs zero rollout DML unless all
predicates required for the requested pair are satisfied:

- exact named org and `scope='synthetic_staging'`;
- no nonterminal null-version legacy async job for entry into
  `shadow|eligible|authoritative`;
- no incomplete operation, operation batch, import batch, or source-bearing
  mismatch required by the pair;
- every retryable job has the comparison posture from section 1;
- every pre-W4 import batch has an immutable closure or frozen preimage;
- eligibility/authority has zero pending or reversible calculation-affecting
  request whose latest snapshot is missing, unsupported, payload-stale, or
  reversal-incomplete;
- eligibility/authority has zero unresolved
  `legacy_time_ingress_not_authoritative` review;
- suspend has serialized every source writer and changes no operation,
  source, result, pointer, or job row;
- resume proves the prior state was authoritative, preserved authoritative jobs
  remain retryable without operation rows, and the referenced offline replay
  artifact reports zero critical/unresolved diffs.

The command returns typed per-predicate counts in its result. It does not accept
a caller-supplied aggregate `ready=true` as a substitute for these queries.

## 4. External Evidence Manifest

Facts outside the database cannot be made transactional. The operator tool
collects them immediately before transition, hashes the canonical manifest,
and passes only the exact manifest plus hash into the command:

- exact deployed backend/web image SHA;
- pending migrations `0` and service health;
- owner authorization reference and authorized target state;
- exact synthetic org ID and explicit `customerData=false`;
- external notifications disabled and zero external destinations;
- every-entrypoint inventory and observation dates;
- seven distinct calendar days for authority promotion;
- zero critical diffs and unresolved reviews;
- suspend/resume, reversal, pointer/hash, and residue evidence references.

The tool fails if a required field is absent, malformed, stale, or names a
different org/image/target. The database event stores the manifest hash and
redacted references, never secrets or raw evidence payloads.

## 5. Tooling Contract

Preparation may add:

- a read-only `status`/`plan` command that emits `PASS|BLOCKED` per predicate;
- a local canonical manifest validator and hasher;
- a transition command that is compiled but refuses execution unless the safe
  boundary from sections 1-4 is present and explicit owner/staging authorization
  inputs are supplied;
- status, shadow-diff, eligibility, authority, suspend, resume, reversal, and
  residue report renderers.

Preparation must not add direct rollout DML, a raw SQL escape hatch, a wildcard
org, an implicit `--yes`, or a default target. The transition command is absent
or hard-blocked until this amendment is RATIFIED and the core hardening has
passed a separate exact-head gate.

## 6. Completion Gates

1. Seven legal pairs pass and every other pair fails with zero rollout DML.
2. Removing one pair guard makes its negative mutation red.
3. Missing state for a non-allowlisted org cannot create a rollout row.
4. A read-only preflight cannot be reused after any locked predicate changes;
   the transition transaction re-evaluates and blocks.
5. Each section 3 predicate has a positive, negative, and remove-the-predicate
   mutation leg on real PostgreSQL.
6. Two-connection races cover request snapshot, review, operation, retryable
   job, legacy batch, suspend, and resume changes while transition waits.
7. A failed event insert leaves state/version unchanged; a failed state update
   leaves no event.
8. Event evidence exact-key tests require manifest hash and correlation ID and
   reject secrets/raw payloads.
9. Repository inventory proves no second transition DML or direct tooling DML.
10. Tool plan mode performs zero DML; apply mode remains hard-blocked without
    exact owner/staging authorization and the expected state/version.

## 7. Owner Decision

`OD-W4C-61` remains **OPEN**.

- **(a) RECOMMENDED:** harden the canonical transition boundary according to
  sections 1-6 before any executable W4C-5 transition tooling is accepted.
- **(b):** keep W4C-5 tooling read-only and defer every transition command. No
  soak can start until a later amendment supplies an equivalent atomic gate.

Option (a) preserves the already RATIFIED W4C-5 goal without accepting the
current TOCTOU gap. Option (b) is safe but leaves W4C-5 operationally blocked.

## 8. Landing Sequence

1. Merge this document as `PROPOSED` after exact-head independent review.
2. Owner RATIFYs the exact merged SHA and selects `OD-W4C-61`.
3. If `(a)`, land the core transition hardening in a Draft/HOLD PR after a real
   PostgreSQL and concurrency gate.
4. Land read-only/tooling and runbook completion in a separate Draft/HOLD PR.
5. Stop. Actual staging access, flag changes, transitions, seven-day soak, and
   issue closure remain separately owner-gated.
