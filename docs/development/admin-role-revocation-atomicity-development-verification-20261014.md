# Admin default-attendance revocation atomicity — R2/R3 candidate

Date: 2026-10-14. Owned worktree: `admin-issues-20261014/metasheet2`.
Starting HEAD: `8e4800ae111bd4f6e9055c6aee696e672793a0d5`.
Baseline reproduction: `ec8d97cc481d3c6835a97c197a93cd00d10151e2`.
Scope: R2/R3 in `artifacts/admin-issues-20261014/sol-first-slice-final-independent-review.md`.

This is an uncommitted implementation candidate, not native qualification or final acceptance.
The baseline JSON proves membership 0 → 1 on next auth with admission still false. It is not
candidate evidence. No runtime, PostgreSQL cluster, install, remote operation or deployment was
started by this slice.

## Contract and implementation

- Explicit default-role removal writes `source = role_unassigned` even when the admission row
  is absent, disabled already, or another attendance role remains. This reuses existing fields;
  there is no migration, flag or substitute role.
- With another namespace role, an existing admission's enabled value is preserved. A missing
  admission becomes a disabled witness; removal never enables admission. Other roles, direct
  grants and legacy permission values are not deleted. Namespace inspection/filter semantics
  are unchanged.
- Bootstrap and both admin unassign entry points acquire the same transaction-scoped,
  per-user PostgreSQL advisory lock (`namespace-admission:<subject>`). The bootstrap holds it
  through admission read and membership INSERT. Revocation holds it through DELETE, the
  remaining-role read and the witness UPSERT. The explicit admission setter also uses it.
- These are separate statements on the same transaction client. Assumption: connections use
  PostgreSQL's default READ COMMITTED isolation; the existing pool uses plain BEGIN, and the
  new native gate asserts that isolation setting. A waiting bootstrap reads the committed witness after
  acquiring the lock. A bootstrap already holding the lock may commit first; revoke waits,
  then removes its role and records the witness. A completed revoke cannot be followed by an
  insertion based on the earlier eligibility read.
- A recovery-authority `40001` rolls back the whole bootstrap transaction. Every bounded retry
  reacquires the lock and re-reads eligibility. Failed writes and unread eligibility cannot
  merge fabricated attendance codes. Cache invalidation occurs after successful commit.
- Eligible never-revoked bootstrap and the registration transaction remain supported.
  Registration's existing whole-transaction retry and delegated-role guards were retained.
  General authorization-cache races remain the separately owned R1 work.

## Exact changed files

All code paths below are relative to `packages/core-backend/`:

| File | Change |
| --- | --- |
| `src/auth/AuthService.ts` | Replace the detached check/INSERT with a locked, retryable bootstrap transaction; merge only after success. |
| `src/auth/attendanceSelfServiceBackfill.ts` | Document the shared-lock prerequisite for interpreting an absent row. Policy semantics retained. |
| `src/rbac/namespace-admission.ts` | Shared writer lock; optional transaction executors for writer reads; required transaction executor for revoke witness; absent-row UPSERT; explicit setter transaction. |
| `src/routes/admin-users.ts` | Platform and delegated unassign DELETE/witness in the same transaction. Existing delegation guards and post-commit audit/readback retained. |
| `tests/unit/AuthService.test.ts` | Lock/read/INSERT ordering and non-recovery write-failure negative. Existing register/recovery negatives retained. |
| `tests/unit/admin-users-routes.test.ts` | Both entry points must use the same transaction client through lock, DELETE and witness before commit/invalidation. |
| `tests/integration/attendance-self-service-revocation-atomicity.db.test.ts` | New isolated-schema, deferred-schedule PostgreSQL qualification suite. |

This report is the sole documentation addition. `role-assignment.ts`, its boundary suite,
`rbac-namespace-admission.test.ts`, `service.ts`, `permissions.ts`, frontend files and other
owners' reports were not edited by this slice.

## Executed local checks

1. `git diff --check`: PASS.
2. Node 24 stdlib `stripTypeScriptTypes(..., { mode: 'transform' })`: all seven changed/new
   TypeScript files parsed. This is syntax checking, not a TypeScript type check.
3. Actual current TypeScript modules loaded in Node's stdlib VM, with deterministic
   transaction/SQL-state doubles: **8/8 PASS**. Cases: eligible bootstrap; missing-row revoke
   followed by verifyToken and login; completed revoke before pending eligibility; revoke
   waiting for an in-flight INSERT; recovery retry re-reading the witness; another role's
   enabled admission retained while opt-out blocks bootstrap; exhausted recovery contained;
   transient recovery succeeding on retry. These probes did not use native PostgreSQL.

## Parent Mac qualification gates

The new DB suite requires DATABASE_URL and fails without it; it does not skip-green. It creates
and drops only its own UUID-namespaced schema, without applying a production migration. It uses
the real AuthService, role-assignment boundary and namespace writers. Session/alias infrastructure
and RBAC profile collection are controlled; HTTP transaction composition is checked separately
by the route unit tests. It is not a replacement for native full-stack endpoint verification.

| Gate | Candidate coverage | Status |
| --- | --- | --- |
| R2 absent-row unassign → verifyToken → fresh password login | Actual SQL membership/admission readback after every step | Native run pending |
| Never-revoked bootstrap and registration | Persisted default-role positive controls | Native run pending |
| R3 revoke completes before pending bootstrap lock | Deferred auth, both missing and enabled initial admission, zero INSERTs/no merged codes | Native run pending |
| R3 bootstrap paused after eligibility / after INSERT | Two clients; `pg_blocking_pids` proves revoke waits; final membership absent | Native run pending |
| Explicit admission disable vs pending bootstrap | Same writer lock, no default-role insertion | Native run pending |
| Recovery retry after newer revoke | Real trigger raises SQLSTATE 40001; rollback releases lock; sequence and admission-read witnesses | Native run pending |
| Witness failure | SQLSTATE 23514 proves DELETE rolls back with failed UPSERT | Native run pending |
| Other role/direct/legacy/admission preservation | SQL row assertions plus existing admission filter | Native run pending |
| Persistent/transient recovery | Bounded real 40001 failures and subsequent successful retry | Native run pending |
| Both HTTP revoke entry points / register and delegation negatives | Focused existing unit files plus added transaction assertions | Vitest run pending |
| Native register/alias atomicity and final independent review | Existing neighboring gates, parent-owned | Pending |

Suggested parent commands, using the already-owned native dependencies and isolated test DB:

```sh
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/AuthService.test.ts tests/unit/attendanceSelfServiceBackfill.test.ts tests/unit/admin-users-routes.test.ts tests/unit/role-assignment-boundary.test.ts
pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/attendance-self-service-revocation-atomicity.db.test.ts
pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/auth-register-atomicity.db.test.ts
```

CI wiring, full type checking, native lock/mutation qualification and independent final review
are still outstanding. No CI/workflow changes, commit, push or final-goal completion are claimed.

## Parent qualification on frozen code e667f9617a

Mac source HEAD/full tree and all changed source/test digests matched local commit e667f9617aaf29ea7d0abb22fcd13bf555c71f1d. No production/customer access or deployment.

- Targeted backend eight files:295 passed,0failed.
- Real PostgreSQL isolated-schema atomicity gate:11 passed,0failed,0skipped.
- Existing native registration atomicity neighbor:3 passed,0failed,0skipped.
- Full442-migration synthetic API with real login/token verification: absent admission-row revoke persisted its witness; immediate, old-token verification and fresh-password-login membership counts remained0; no fabricated attendance codes. Explicitly disabled subject stayedunassigned, never-revoked subject retained bootstrap. Health/source identity matched e667f9617a. Four synthetic accounts/two organizations only.

Receipts under artifacts/admin-issues-20261014: e667f9617a-backend-receipt.json, e667f9617a-atomic-db-receipt.json, e667f9617a-register-db-receipt.json, role-api-e667f9617a.json. The DB suite's controlled session/alias/RBAC infrastructure does not replace the full-stack API proof; both are separately attributed.

Independent targeted Sol review and post-run full445-table restoration are pending at this entry. Overall items4/5 remain HOLD until separate R1/R4-R6 corrections, frontend tests/browser, mutation, quality and final review pass. The earlier8e frontend run was123passed/3failed; it is not a final frontend PASS. CI registration was added in1ea63964ef without removing any existing line. Code qualification retains e667 identity; later documentation/CI-only changes do not relabel execution.

## Parent follow-up qualification — d7be3a83a2

Frozen source `d7be3a83a217875187fd6edcebe3b9a1177da5ff` matched the Mac full tree and changed-path digests. Targeted backend10files331tests, frontend4files137tests, native revocation11tests and registration3tests passed with zero failures/skips. The earlier frontend fixture timing failures were corrected by waiting for rendered selected-subject detail, without changing the product behavior.

Sol independent bounded A1 review passed source inspection at this SHA. Full442-migration synthetic real-auth API exercised attendance-admin single and batch unassign: absent-row witness persisted, old-token verification and fresh login did not re-add membership, non-admin other-subject write returned403 without mutation. A real PostgreSQL trigger failed the last sorted batch witness with23514; both membership deletes and the earlier witness rolled back physically. After removing this synthetic-only trigger, batch success and both subjects' next-auth/fresh-login checks passed. See `artifacts/admin-issues-20261014/sol-attendance-unassign-a1-review.md` and source-specific receipt `attendance-admin-api-d7be3a83a2.json`.

E667 validate:all passed after correcting only owned runtime PATH; this does not qualify later source. R1 second-invalidation mutation at a6e84bf754 failed the matching assertion and restored exact original bytes. UI review at a6 still HOLD for five readback/selection/copy-state corrections; that separate Grok task remains active. Full first-slice browser/quality/mutation/final review remain pending. Overall DOCX goal not complete. No public push, PR or deployment.

Post-run d7 cleanup completed: owned backend stopped and all445 table counts/content hashes equal the restored4-user/0-session baseline. Three additional route mutations (single lock, batch locks, revoke witness) each failed matching assertions; every original source byte was restored. The source SHA remains d7, not this later documentation commit.
