# R74 approval relations verification

Base: `f3efc86c0159408ec8531b887d86a157368af666`. All execution below used an isolated synthetic PostgreSQL 16 database and an owned checkout. No test server access or provider requests.

## Commands and results

Environment: Node 20.20.2 / pnpm 9.15.9; empty inherited application environment, external-write/stream/lifecycle switches off. Use the checked-in native workflows for their exact migration exclusions and EXPECT_DB sentinel.

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/local-org-department-head-ci-contract.test.ts tests/unit/local-org-workspace-ci-contract.test.ts`: 7 passes. Later head workflow trigger expansion: affected contract 1 pass, 2 filtered; unchanged siblings retained.
- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/local-org-department-head.db.test.ts --reporter=verbose`: 20 actual passes, no skip. One case creates four existing-member projections through HTTP, sets memberships/primary/manager/head, publishes the two-step graph, and completes two real instances with ordinary requester/approver JWTs. Changing head preserves old instance routing and changes the new instance.
- Same integration command with `local-organization-workspace.db.test.ts`: initial 21 passes/1 failure. The holder's transaction cached pg_stat_activity; observation-only pg_stat_clear_snapshot repaired the observer without changing 3000ms/20ms budgets. Both affected waiting cases passed (20 excluded). Later expanded candidate collision case failed against original filtering and passed after mirroring writer exclusions (21 excluded). Final coverage is 22 distinct cases across phases: 19 unchanged initial passes, 2 observer cases and 1 updated candidate case. It is not a fresh whole-file run.
- Original exact-R74 resolver substituted temporarily: local head baseline failed, original manager control passed, 18 filtered. New resolver restored byte-for-byte. The 20-case positive evidence above is retained, not rerun.
- Applied-history refusal removed: one matching 200-vs-409 failure. Projection admin gate removed: one matching 400-vs-403 failure. Each excluded 21 other cases and restored source exactly.
- Admin mount census: six selected static cases pass, 163 filtered. This is NOT a local 169-case full pass.
- `pnpm --filter @metasheet/core-backend type-check`, `pnpm validate:all`, explicit no-ignore lint of the eight added runtime/test files: final exit 0. Do not infer whole-repository lint from the focused lint.

## Migration and source applicability

Candidate inventory is 447 migrations; six existing workflow exclusions leave 441 applied ledger entries. Fresh isolated schema applied successfully. Actual CLI rollback and reapply tested a nonempty membership: ledger 441→440→441; old manager/primary values remained; newly added head defaults false. Rollback removes head mappings and must not be used blindly after real writes.

R74 query typing required eleven type-only assertions because its transaction client lacks the newer generic signature. Emitted JavaScript remained byte-identical. The later candidate filter only changes listLocalOrganizationMemberCandidates; compiled workspace/tree/member helpers used by the 20-case approval flow remained identical.

All owned PostgreSQL starts ended with the same owned instance stopped, data retained. Historical failures, observer postcheck status-label mismatch, mutations and source-restoration receipts are retained. Filtered/skipped/todo items are never counted as passing.

## Review limits

The earlier requested Astra architecture review identified the archive/source/title boundaries retained here. The new Astra title-unification request exhausted quota; Kimi k3.1 source review ended with APIConnectionError and no verdict. Neither is represented as an independent successful review of this backport. Main-agent source audit and the actual native/negative evidence above support the bounded Draft only.

Remote CI for the newly published backport must be assessed separately. No deployment, production acceptance, UI availability, title unification, real UAT or automatic restoration of old approval instances is claimed.
