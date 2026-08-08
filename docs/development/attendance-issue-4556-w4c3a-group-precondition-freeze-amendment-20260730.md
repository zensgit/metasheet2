# Attendance issue #4556 W4C-3a group-precondition freeze amendment

Status: **RATIFIED** (W4C-3a remediation and a fresh exact-head gate only)

Date: 2026-07-30

Ratified: 2026-07-31, merged SHA
`1326f2d9f8b8b5149b837673d3b6ec8949e53b76` — the commit that landed this
document on `main` (PR 4685) — with `OD-W4C-58=(a)`. Durable owner record
(relayed from the owner's explicit instruction): PR 4685 comment `5137577915`,
<https://github.com/zensgit/metasheet2/pull/4685#issuecomment-5137577915>.

Scope of what the ratification authorizes: exactly what this amendment states
— W4C-3a remediation and a fresh exact-head independent gate, and nothing
downstream. It does **not** authorize the W4C-3a code PR merge or caller
cutover, W4C-3b or later slices, staging or soak, flag changes, deployment,
production/customer data, or issue closure.

**Status reconciliation note (2026-08-09):** this header previously read
`PROPOSED - owner RATIFY required`. That was in-repo status drift, not a
pending decision — the owner record cited above predates this correction and is
unchanged by it. This edit transcribes that existing record and confers no new
authority; the linked owner comment is the authority, not this document and not
the pull request carrying this edit. If any line here misstates that record, it
must not merge.

Authority proposed against:

- RATIFIED durable-plan amendment merge SHA
  `e6c536fe7a201ca0466b2dc776b15fbdb23aa890`;
- RATIFIED byte-parity amendment merge SHA
  `ab752d722327f11887e3884a23ed4f6304faa3c5`,
  with owner decision `OD-W4C-57=(a)`;
- historical unmerged implementation inventory snapshot
  `f7769a707`, originally authored on
  `codex/attendance-4556-w4c3a-durable-plan-20260730` before later rebases;
- the same contradiction independently reverified at Draft PR #4688 exact head
  `7a0d49eb155610078e5a27fab21e5acfa03f905c`. That head is evidence only and
  must be reverified again at the final code gate.

This document is a narrow correction to the W4C-3a group-precondition
contract. It does not authorize W4C-3a merge or caller cutover, W4C-3b or
later slices, staging soak, a flag change, deployment, production/customer
data, or issue closure.

## 1. Blocking contradiction

The RATIFIED durable-plan amendment requires the worker to choose its lock
order from the state frozen at prepare time:

- a frozen-existing group/member business row is locked before the org
  revision row;
- a frozen-missing key is checked only after the org revision row is locked.

The current exact plan union cannot carry that choice:

1. `groupStateFingerprint` contains membership-existence bits, but is a
   one-way SHA-256 digest.
2. `ensure_group` has no prepare-time group-existence field.
3. `ensure_member.memberId` is server-minted whether the membership exists or
   not, so it cannot encode the branch.
4. The raw name/code `groupRef` is resolved during enqueue. Once only the
   resolved group ID remains, the worker cannot reproduce every row returned
   by the raw alias query.
5. Reading current existence before the revision lock cannot repair the
   omission: it would let concurrent state choose the lock order that the
   contract says must be frozen.

This is not a missing test around an otherwise implementable callback. A
worker that guesses the branch would violate section 4.5 even if all local
tests passed.

W4C-3a group-effect execution therefore remains paused until this amendment is
RATIFIED. Record-target preconditions are unaffected: their frozen branch is
recoverable from
`LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1`.

## 2. Decision `OD-W4C-58`

### Option (a) - freeze explicit group/member branches (recommended)

Amend the exact plan union, enqueue materialization, fingerprint preimage, and
worker lock order as sections 3-6 specify.

This is the smallest correction that keeps group effects in W4C-3a and makes
restart execution independent of process memory and current-state guesses.

### Option (b) - keep group effects out of W4C-3a

Keep W4C-3a paused for any plan with a group effect and open a separate
redesign. No group-effect caller may cut over under the present union.

Option (b) is safe but does not complete the accepted legacy parity scope.

An owner RATIFY must name the merged SHA of this PROPOSED amendment and
`OD-W4C-58=(a|b)`.

## 3. Exact union under option (a)

The two closed variants become:

```text
groupEffect =
  | {
      kind: 'ensure_group',
      groupId,
      normalizedName,
      displayName,
      code,
      timezone,
      ruleSetId,
      groupExistedAtPrepare
    }
  | {
      kind: 'ensure_member',
      memberId,
      groupRef,
      userId,
      membershipExistedAtPrepare
    }
```

Rules:

1. Both new fields are required booleans. Missing fields, unknown fields, and
   non-booleans fail exact parsing.
2. `groupRef` is the resolved group UUID, never a raw name or code. Exact
   parsing requires UUID shape rather than accepting an arbitrary string.
3. `groupExistedAtPrepare=true` means `groupId` is the exact existing row ID.
4. `groupExistedAtPrepare=false` means `groupId` is the server-minted ID for
   the planned insert and the normalized lookup key
   `(org_id, lower(btrim(name)))` was absent.
5. `membershipExistedAtPrepare` is the exact existence bit for
   `(org_id, groupRef, userId)`.
6. A member may reference a prepare-time missing group only when the same plan
   has one `ensure_group` effect with that `groupId` and
   `groupExistedAtPrepare=false`. In that case
   `membershipExistedAtPrepare` must be false.
7. A member whose `groupRef` has no matching `ensure_group` effect requires
   that referenced group to have existed at prepare time.
8. `memberId` remains the server-minted insert ID. It does not encode
   membership existence.

No optional compatibility field or opaque metadata may duplicate these
branches.

## 4. Enqueue freeze

### 4.1 Alias resolution

Enqueue preserves the retained legacy lookup:

1. normalize names and codes with the existing legacy normalizer;
2. install name mappings first;
3. install code mappings only when the normalized key is not already mapped;
4. reject an unresolved member reference;
5. persist only the resolved UUID in `ensure_member.groupRef`.

A name/code collision therefore resolves to the name row. The discarded code
row is not a plan input.

### 4.2 Effective group read-set

The fingerprint's `groups` array is the exact effective row set, not every row
that happened to be returned while resolving aliases.

The effective group-ID set is the unique union of:

- every `ensure_group.groupId`; and
- every resolved `ensure_member.groupRef`.

For each effective group ID:

- include its full existing row in the fingerprint only when it existed at
  prepare time;
- otherwise add no entry to the fingerprint's `groups` array. The corresponding
  `ensure_group` effect preserves the normalized missing lookup key and its
  explicit existence bit for the separate absence recheck.

Rows returned only because a losing code alias collided with a winning name
are excluded. They cannot change the resolved plan and the org revision still
serializes any later mutation.

The canonical fingerprint preimage is exactly
`{ groups: existingEffectiveGroupRows, memberships: intendedMembershipBits }`.
There is no third marker variant. The `memberships` array contains one exact
sorted `(orgId, groupId, userId, exists)` entry for every `ensure_member`
effect. Its `exists` value must equal `membershipExistedAtPrepare`.

### 4.3 Atomicity

The new fields, effective read-set fingerprint, manifest, chunks, and job
digest are derived and inserted in the existing one SERIALIZABLE enqueue
transaction. No field may be backfilled after commit.

## 5. Worker lock and recheck order

The worker uses only the verified plan fields. It never re-runs name/code
mapping and never uses current existence to select a branch.

After all record-target preconditions have been locked and rechecked:

1. derive the effective group IDs and member keys from the verified effects;
2. lock every `groupExistedAtPrepare=true` group row `FOR UPDATE`, ordered by
   UTF-8 bytes of `groupId`;
3. require exactly one row for each such ID and require the same org;
4. lock every `membershipExistedAtPrepare=true` member row `FOR UPDATE`,
   ordered by UTF-8 `(groupRef, userId)`;
5. require exactly one row for each such pair and require the same org;
6. lock the one `attendance_group_effect_revisions` row `FOR UPDATE`;
7. require exactly one row and exact equality with the frozen
   `groupRevision`;
8. re-read the exact effective group IDs and all planned member keys;
9. require every frozen-existing branch still exists and every frozen-missing
   branch is still absent, including absence of
   normalized `(org_id, lower(btrim(name)))` lookup key for a missing planned
   group;
10. reconstruct the exact sorted group/membership preimage and require its
    SHA-256 to equal `groupStateFingerprint`;
11. only then may the fixed effect adapter execute group/member DML.

The cross-table business-row order is explicitly **groups first, members
second**, followed by the org revision row. Input order is never used.

SQLSTATE `40001` and `40P01` propagate to the governing bounded
whole-transaction retry. Contract mismatches return the closed precondition
failure; serialization errors are not relabeled as business mismatches.

If there is no group effect, both manifest fields remain null and the worker
executes none of the SQL above.

## 6. Failure posture

Any missing/extra row, cardinality mismatch, org mismatch, revision mismatch,
existence-bit mismatch, name-key appearance, or fingerprint mismatch selects:

```text
status = 'failed'
w4_execution_reason_code =
  'ATTENDANCE_IMPORT_LEGACY_PLAN_PRECONDITION_CHANGED'
error = null
```

The transition and zero business/terminal/cleanup effect remain in the same
worker transaction. The failed job is not reopened.

## 7. Required evidence

### 7.1 Parser and package gates

- both new fields are required and exact-key checked;
- `ensure_member.groupRef` must pass UUID parsing;
- a missing-group member without a matching `ensure_group` is rejected;
- a membership under a missing same-plan group cannot claim it existed;
- duplicate effective group/member identities are rejected;
- plan/chunk/job digests change when either existence bit changes.

### 7.2 Enqueue real-DB gates

- UUID, name, and code references resolve to the same legacy winner;
- a name/code collision proves name-first precedence;
- a same-plan group code resolves to the minted group UUID;
- persisted member effects contain no raw alias;
- only effective group rows enter the fingerprint;
- existing and missing group/member branches are frozen independently;
- rollback leaves job/manifest/chunk residue zero.

### 7.3 Worker real-DB gates

- existing group update/delete: business row precedes revision lock;
- existing member delete: member row precedes revision lock;
- missing group insert: revision lock precedes name-key absence recheck;
- missing member insert: revision lock precedes pair absence recheck;
- a deterministic fixed-SQL trace proves groups are locked before members and
  both precede the revision; this trace runs before retry behavior can mask an
  order inversion;
- two-connection races cover both commit orders for all four branches;
- process restart proves execution uses only persisted plan values;
- every precondition failure leaves all business, W4, terminal-response, and
  cleanup effects absent.

### 7.4 Required mutations

Each mutation must make its named leg fail exclusively or with an explained
minimal set:

1. derive an existence branch from current DB state;
2. remove either new existence field from the digest;
3. persist the raw member alias instead of the resolved UUID;
4. let a code mapping overwrite a name mapping;
5. include a discarded alias-collision row in the effective fingerprint;
6. lock the org revision before a frozen-existing business row;
7. lock members before groups or use input order; the deterministic SQL-trace
   leg must turn red independently of deadlock retry outcomes;
8. skip revision equality;
9. accept an appeared frozen-missing group/member key;
10. swallow `40001` or `40P01` as a precondition mismatch.

### 7.5 CI and review

- targeted unit and real-DB suites are named in the unconditional attendance
  integration run list on both Node matrix legs;
- a fresh exact-head independent review must report 0 P1 and 0 P2;
- the review must inspect the SQL order and rerun the four two-connection
  races, not rely on static query-string assertions alone.

## 8. Resume boundary

If `OD-W4C-58=(a)` is RATIFIED:

1. rebase the frozen W4C-3a implementation inventory onto current main;
2. implement sections 3-7 before any group-effect worker adapter;
3. rerun all prior W4C-3a tests and mutations;
4. complete the fixed repository, precondition, and effect boundaries;
5. continue caller cutover only after the full W4C-3a exact-head gate.

The RATIFY does not authorize merge of the W4C-3a code PR. The lane must still
stop at its owner merge gate.
