# Managed authority expiry after PostgreSQL lock waits

Source `1895fbe2b0ff424ad1fd765f83ca449b5cac639b` fixes a reproduced stale-session admission in the shared `lockManagedBomAuthority` function. The change adds one database-clock freshness query after all link, binding, session, source, user and membership locks have been acquired. Existing identity, generation, registration, permission and purpose checks remain intact. Session duration and other gates are unchanged.

## Reproduced failure and correction

PostgreSQL `now()` remains the transaction's start time. A request can begin with a valid Meta managed session, wait for a link lock until the session expires, then pass the original `expires_at > now()` condition. In the development managed Discussion chain, this reached the actual Native API and created a synthetic thread after Meta-session expiry. The independent focused reproduction captured expiry `2026-10-20T04:28:52.466Z`, database check `2026-10-20T04:28:52.544Z`, accepted=true, and one Native exchange/thread. No production or customer data was involved.

Moving only the earlier timestamp predicate would not cover later user or membership lock waits. The fix therefore checks `expires_at > clock_timestamp()` after all authority locks, immediately before returning the admitted scope. The session tuple remains protected by the existing lock; an expired/revoked session is refused with the existing session-required error.

Actual PostgreSQL16.15 tests hold a conflicting lock on either the link or Meta membership, observe a distinct waiting backend in `pg_stat_activity`, wait until the session is expired according to the database clock, then release the writer. Both cases now return403 before any Native exchange. Real Native identity/business PostgreSQL and a separate Node/Meta PostgreSQL process are used by the new managed-flow proof; no Native response is mocked in that proof. Its Meta session rows are explicitly fixture-provisioned, so this does not claim global JWT/cookie or installed UI acceptance.

## Verification and source separation

- New managed-flow integration: **12 actual PostgreSQL/Redis/Native HTTP tests pass**. These cover a real Native author/read positive, current stored identity/member/source refusal, database immutability positive controls, an unlink-state writer blocked through the Native operation, and both expiry waits. The larger managed Discussion implementation remains uncommitted and is not part of this source commit.
- Affected existing personal change-read suite: **48 passed, zero excluded/failed** in an owned PostgreSQL cluster.
- Existing snapshot suite plus the two independent expiry regressions: **16 passed, zero excluded/failed**. CI's exact expected count is strengthened from14 to16; its existing no-skip checker remains unchanged.
- A separate clean detached worktree at this exact source independently passes the **two new expiry cases**. Its14 older cases were intentionally excluded, not rerun or counted as passed. Individual assertion statuses are authoritative: Vitest's top-level aggregate counters misleadingly count the excluded cases. The existing CI checker correctly rejects that focused report and accepts the actual full16 report.
- Full backend TypeScript no-emit checking and diff checks pass. Source Git blobs for all three committed files match the working/tested bytes and the clean review worktree. No frontend or installation qualification is inferred from these checks.

All successful owned PostgreSQL/Redis/Native children and runtime directories are stopped/removed. Failed-run roots are retained and their processes are stopped; raw reports, capture JSON and logs are privately retained with hashes. The initial zero-test run used a malformed local Node DSN; two subsequent fixture expectations tried updates that real database immutability triggers correctly reject. They were corrected to prove database refusal and a subsequent legitimate positive, without dropping triggers or changing gates. The actual expiry failure was reproduced separately before repair.

The committed repository CI entrypoint is `PG_BIN=/absolute/verified/postgres/bin node scripts/verification/plm-managed-companion-ci/snapshot-share.mjs`, with Node20 and frozen dependencies installed. It provisions its own socket cluster and checks the exact16/no-skip report. The remote workflow and complete CI coordinator are not claimed executed by the local report-checker call.

Compact receipt: `plm-managed-authority-expiry-verification-20261020.json`. Commands are preserved in the owned local drivers `/tmp/plm-managed-discussion-pg-fourth-driver-20261020.py`, `/tmp/plm-managed-discussion-authority-regressions-20261020.py` and `/tmp/plm-managed-authority-expiry-clean-driver-20261020.py`. They require explicit owned Unix sockets, existing pinned PostgreSQL/Redis/Node/Python tools and strict cleanup; they do not operate on production services.

## Remaining delivery

This is a shared-authority security fix, not completion of the managed Discussion feature or full W01–W23. Previously qualified f0ee packages/images retain their original scoped evidence but do not contain this fix; replacement source/distribution qualification remains required. Grok quota/Kimi availability failures remain recorded; no independent model review is claimed. Codex independently reproduced the failure and checked actual source blobs and a clean source worktree.

Draft #363 exact `74fcf61f8669a9cd3af91457347d09bc647a97f6` still retains valuable queued job `118040891880`. This source/doc candidate remains local until that work is terminal; then publish dependencies serially and verify actual remote heads. All PRs remain Draft. No merge, deployment, production enablement or business notification.
