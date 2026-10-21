# Attendance ACP-1B Canonical Anchor Ratification Record

Status: **RATIFIED — DESIGN LOCK / DRAFT-HOLD; RUNTIME AUTHORITY REQUIRES THIS EXACT RECORD TO BE MERGED**

Date: 2026-09-06 (Asia/Taipei)
Parent product lock: `docs/development/attendance-multitable-cleaning-acp1-owner-decision-20260831.md`

## Exact authority

The owner ratified this exact option in the Codex task that owns ACP-1B:

> RATIFY ACP-1B OD-ATC-11R(a)

The ratification applies prospectively to the immutable proposed anchor packet
below. It does not authorize Ready, merge, flag enablement, dispatch,
deployment, staging, production, or real customer data.

| Item | Exact value |
| --- | --- |
| Proposed authority commit | `8251897188875573c7892d694779e20899f94943` |
| Proposed authority tree | `5889dd32c70ef1b32070934162e074d6df0b41f5` |
| Proposed authority file | `docs/development/attendance-multitable-cleaning-acp1-anchor-authority-amendment-20260901.md` |
| Proposed authority blob | `1769a2d4f0caa751a3fae2663abab2d9a247e29e` |
| Selected option | `OD-ATC-11R(a)` — durable server-owned anchor ledger |
| Unselected options | `OD-ATC-11R(b)` server-keyed proof; `OD-ATC-11R(c)` public anchors |

The cited object is the normative detailed contract. This record neither
rewrites nor broadens it. If its commit, tree, file, or blob differs, runtime
work must stop for owner clarification.

## Locked implementation meaning

The daily-report projection remains an untrusted proposal. `row_key`,
organization/user/date fields, and `source_fingerprint` are not canonical
identity and can never select a target record at apply time.

The selected contract permits exactly one attendance-owned anchor ledger that:

- binds one projection record ID to one same-organization canonical attendance
  record, a posture-selected calculation ID/version, a closed canonical-source
  digest, and a managed source fingerprint;
- keeps projection-record, organization, canonical-record, and creation
  identity immutable; forbids rebinding; has no generic multitable, Yjs,
  token, automation, or end-user writer;
- withholds or removes every anchor for a duplicate public row key and leaves
  legacy rows without an eligible calculation unanchored;
- is refreshed only by the existing daily-report sync from DB-fresh canonical
  data, including its create, patch, repair, and fingerprint-match-skip paths.

Before any canonical DML, W4 `manual_edit` must retain its global lock order
and lock/re-read actor authorization, sheet/record/field access, projection
version, anchor, canonical record, and posture-selected calculation. It must
verify the anchor binding, recomputed managed fingerprint, canonical digest,
calculation revision, proposal digest, and both CAS preconditions. Any mismatch
is values-free and creates zero calculation, result-edit, audit, operation,
outbox, notification, or cleanup DML.

The canonical sink remains the existing W4 `manual_edit`. Notifications remain
forced off. ACP creates neither an independent proposal lifecycle nor a
projection/external outbox. Post-commit cleanup may change only
`cleaning_requested` and `cleaning_reason`; a cleanup conflict remains
`applied_pending_cleanup` and must never repeat or roll back the canonical
effect.

## Bounded implementation window

After this record is merged, implementation must start in a fresh worktree at
then-current `origin/main`, with a fresh OPEN-PR/path-conflict audit. It may
touch only the following additional authority surface, alongside the already
ratified attendance-owned ACP product files:

1. one collision-free Kysely migration in `packages/core-backend/src/db/migrations/`;
2. `packages/core-backend/src/db/types.ts`;
3. `packages/core-backend/src/types/plugin.ts`;
4. `packages/core-backend/src/index.ts`;
5. `packages/core-backend/src/attendance/attendance-multitable-cleaning-authority.ts`;
6. `plugins/plugin-attendance/index.cjs`;
7. dedicated ACP unit/real-DB tests and the existing W4 route neighbor.

The window excludes OpenAPI, new public endpoints, shared workflow or selector
changes, generic automation authority, global flags or flag enablement,
dispatch, deployment, staging, production, and real customer data. It does not
authorize reusing, committing, replaying, or merging the historical dirty
ACP runtime worktree.

## Required refutation evidence

The implementation PR must prove, with `RBAC_BYPASS=false` real-DB coverage:

- two-anomaly tampering against any editable projection identity/fingerprint,
  canonical-source revision, or calculation returns zero writes;
- proposal and calculation CAS races, permission revokes, sheet/field/row
  denies, deleted sheets, duplicate row keys, missing anchors, rebind attempts,
  and true legacy rows fail closed;
- post-commit cleanup replay is idempotent without a second canonical edit;
- notification/external fan-out and ACP lifecycle/projection outboxes remain
  absent; and
- migration replay/down/reapply and task-owned database/process residue checks
  pass, with named mutations made RED for anchor uniqueness, rebinding,
  revision checks, CAS, lock order, notification suppression, and outbox scope.

The resulting implementation may be published only as Draft/HOLD until its
separate verification and release gates are satisfied.
