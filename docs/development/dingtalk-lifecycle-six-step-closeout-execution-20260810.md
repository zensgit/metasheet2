# DingTalk lifecycle six-step closeout execution

- Date: 2026-08-10
- Status: **CODE CANDIDATE / OPS AND EXTERNAL GATES NOT EXECUTED**
- Baseline: `origin/main @ 775d537e616e325000c7578d7e2432d838da0801`
- Scope: close the OPS-01 superseded creation-effect residue without enabling lifecycle traffic

## 1. OPS-01 explicit compensation

Owner decision: do not delete deny rows automatically when evidence is superseded. A platform administrator uses a dedicated endpoint with `confirm=true` and a reason of at least eight characters.

The write transaction:

1. Resolves the event owner, then takes the canonical per-user access-graph mutex.
2. Locks the event and all effects.
3. Accepts exactly one superseded `grant_changed` creation effect.
4. Rechecks active/activated user, the exact active integration/account/linked source, active event-org membership, and absence of any live applied deprovision evidence. Source rows use `NOWAIT`: sync owns account rows before it reaches the user mutex, so compensation returns a values-free 409 busy response instead of waiting in the reverse lock order.
5. Deletes only a disabled DingTalk grant whose provenance is exactly `system:directory-deprovision`.
6. Marks the effect `compensated`, records actor/time/immutable compensation note, and advances `access_generation` by CAS in the same transaction.

The event remains `superseded`; this operation is not a full restore. Missing, enabled, differently attributed, or concurrently changed state returns 409 and rolls back. A retry after committed compensation is idempotent only while the grant remains absent.

API:

```text
POST /api/admin/directory/deprovision-events/:eventId/compensate-orphan-deny
```

The route is platform-admin-only. Unexpected backend failures return a fixed message rather than PostgreSQL details. The general audit record is values-free; durable evidence lives on the compensated effect.

## 2. Verification ledger

| Gate | Current evidence |
|---|---|
| Fresh DB migration | PASS on isolated `codex_ops01_comp2_20260810` |
| Migration replay | PASS; second migrate is a no-op |
| Down safety | PASS; refuses downgrade while compensated evidence exists |
| Real DB lifecycle | PASS: deprovision → supersede → compensate → OAuth ensureGrant |
| Drift matrix | PASS: enabled grant, wrong provenance, inactive source, busy source, inactive membership, and live evidence all reject without partial write |
| Concurrency | PASS: two callers queue behind the user-row holder with one transition/increment; a separately locked source row yields fail-fast 409 rather than a user/source deadlock |
| Regression | PASS: 66/66 across seven neighboring real-DB files |
| Backend route | PASS: 110/110, including malformed-ID preflight, source-busy 409, SQLSTATE-safe fixed 500, and values-free audit |
| D7 UI | PASS: 5/5 |
| TypeScript | PASS: core-backend `tsc --noEmit` |
| CI wiring | PASS: suite excluded from no-DB Vitest and run as a whole file in approval real-DB step |
| Independent review | APPROVE after delta re-review; no remaining P1/P2 |
| Exact-head required CI | PENDING until the held PR is pushed |

Load-bearing mutations reproduced before restoration:

- remove grant provenance predicate → wrong-provenance test fails;
- remove live event/effect veto → live-evidence test fails;
- remove exact source gate → inactive-source test fails;
- remove active membership gate → membership test fails;
- remove canonical `FOR UPDATE` mutex → two-waiter barrier times out;
- remove source `NOWAIT` → the holder test waits, mutates after release, and fails instead of returning busy;
- remove compensated-evidence immutability → raw note tampering succeeds and the schema test fails;
- pass an unknown PostgreSQL SQLSTATE through as the response code → the HTTP error-surface test fails;
- remove the `COALESCE` fail-closed terms from compensation evidence checks → raw NULL actor/note inserts succeed.

## 3. Lifecycle flags and canary

The repository defaults and closeout contract continue to require all three flags OFF:

```text
AUTH_LOGIN_USE_ALIASES=false
DIRECTORY_PENDING_ACTIVATION_ENABLED=false
DIRECTORY_DEPROVISION_ENABLED=false
```

Merge is not an enablement instruction. Canary execution is **NOT EXECUTED** and remains a separate ops GO. When authorized, execute only one stage at a time:

| Stage | Enable | Required rollback proof before proceeding |
|---|---|---|
| 1 | alias-only | turn alias read path off and prove the pre-cutover login path is restored |
| 2 | pending admission | turn pending admission off and prove new admissions return to activated baseline behavior |
| 3 | deprovision | turn writer off and prove a new sync cannot create an event/effect or mutate access state |

Deprovision is last. Do not overlap flag changes.

## 4. Owner and ops acceptance

Real enterprise evidence is unavailable in this development lane. Therefore these are explicitly **NOT EXECUTED**, not simulated PASS:

- U1-U13 interactive-card acceptance;
- U11-a real callback corp-anchor;
- named owners and final production switch decisions;
- actual staged rollback exercises from section 3.

The procedure of record remains `dingtalk-hardening-real-uat-evidence-pack-20260713.md`.

## 5. Transfer decision gate

Transfer T3-T5 remains **FROZEN**. The real two-corp T2-Gate has not run in this lane:

| T2-Gate verdict | Consequence |
|---|---|
| CONFIRMED | implement T2.5 tenant-scoped key migration before T3 |
| DISPROVED | T3 may be considered after owner authorization |
| INCONCLUSIVE / NOT EXECUTED | keep T3-T5 frozen |

The runbook of record is `canonical-org-t2-gate-two-corp-staging-runbook-20260717.md`.

## 6. Test infrastructure lane

Issue #4820 remains a separate test-infrastructure item. Shared `metasheet_test` can be reset by parallel sessions, so this implementation used the lane-owned scratch database `codex_ops01_comp2_20260810`. The durable follow-up is per-lane scratch DB provisioning and cleanup; it does not change the lifecycle product verdict, but future runtime evidence must not rely on a concurrently shared database.

## 7. Closure rule

This goal is complete only when the held PR has independent review, exact-head required CI, and a reviewable head. It remains unarmed. Canary, U1-U13/corp-anchor, T2-Gate, Transfer T3-T5, and #4820 are deliberately external or separate gates and are not represented as completed by this code PR.
