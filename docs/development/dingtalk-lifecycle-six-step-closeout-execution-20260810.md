# DingTalk lifecycle six-step closeout execution

- Date: 2026-08-10
- Status: **CODE CANDIDATE / OPS AND EXTERNAL GATES NOT EXECUTED**
- Baseline: `origin/main @ 775d537e616e325000c7578d7e2432d838da0801`
- Scope: close the OPS-01 superseded creation-effect residue without enabling lifecycle traffic
- Operator lane (staging only, default-off): `.github/workflows/dingtalk-lifecycle-staging-canary.yml` + `scripts/ops/dingtalk-lifecycle-staging-canary-remote.sh` — **not executed** by this closeout

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

## 3. Lifecycle flags and canary (minimal safe lane)

The repository defaults and closeout contract continue to require all three flags OFF:

```text
AUTH_LOGIN_USE_ALIASES=false
DIRECTORY_PENDING_ACTIVATION_ENABLED=false
DIRECTORY_DEPROVISION_ENABLED=false
```

Merge is not an enablement instruction. **Lifecycle canary is NOT EXECUTED** and must not be implied complete by this PR or by the operator lane landing.

### 3.1 Staging operator lane (what is actually executable)

| Piece | Path |
|---|---|
| Workflow | `.github/workflows/dingtalk-lifecycle-staging-canary.yml` (manual only; default `status`) |
| Remote | `scripts/ops/dingtalk-lifecycle-staging-canary-remote.sh` |
| Contract | `scripts/ops/dingtalk-lifecycle-staging-canary-contract.test.mjs` |

| Action | Executable? | Notes |
|---|---|---|
| `status` | yes | values-free snapshot; multi-on reports then fail-closed |
| `preflight` | yes | readiness only; `migrations_pending_zero` must be **exactly `true`** (`unknown` fails — never treated as success) |
| `off` | yes | **sole env write**: emergency clear of the three gates; previous-override backup + restore on restart/health/mode failure; backend health must be true after restart; exact mode `off` proven |
| `alias` / `pending` / `deprovision` | **NOT EXECUTABLE** | fail-closed preflight-only; `transition_applied=false` always. Env flip alone is not a canary — no secret-backed password-login / admit→activate / sync→deprovision verifier exists in this lane. Presence tokens are not ON enablers. |

`action=off` is an **emergency operational rollback of the env gate only**. Design lock Rev 4.2 §4.2 / §4.4 permanently forbids reintroducing OR-column fallback on `users.email` / `username` / `mobile` as a long-term design after T2b. OFF is not “canary stage 1 complete.”

### 3.2 Current staging blockers (owner review 2026-08-11)

Lifecycle ON canaries remain **NOT EXECUTED**. Current staging preparation evidence and blocker:

1. [Attendance staging runner 31407444155](https://github.com/zensgit/metasheet2/actions/runs/31407444155) completed host backup, clone rehearsal, isolation check, real migration, and auth round-trip. Migration state is now `314 applied / 0 pending` (`migrations_pending_zero=true`).
2. **Exact-build provenance is still blocked live:** the running image tag is `b55c682748e3010cb70837770c298843a96e1019`, but `/api/health` reports old commit `59c24a1d21cfc70b76867da7d0ac15590d558c72`. Image/health disagreement is a hard `build_provenance_conflict`. This PR makes staging compose override stale env-file metadata from the exact `IMAGE_TAG`; merge + redeploy/recreate + agreement proof is still required.
3. The existing `DEPLOY_KNOWN_HOSTS` secret supplies the independently verified host key. SSH and SCP require `StrictHostKeyChecking=yes`; this evidence lane does not accept first-use trust.

Until those clear **and** a real verifier exists, do not claim lifecycle canary progress. Future ON sequence (alias → pending → deprovision) is documentation-only and **NOT EXECUTABLE** here.

### 3.3 Future stages (NOT EXECUTABLE in this lane today)

| Stage | Desired enable | Required real proof (missing today) |
|---|---|---|
| 1 | alias-only | password-login success against aliases + emergency `off` proof without OR-column fallback |
| 2 | pending admission | admit→activate on an explicit canary subject (not a presence token) |
| 3 | deprovision | sync→deprovision on an explicit canary integration; then `off` clears the writer |

## 4. Owner and ops acceptance

Real enterprise evidence is unavailable in this development lane. Therefore these are explicitly **NOT EXECUTED**, not simulated PASS:

- U1-U13 interactive-card acceptance;
- U11-a real callback corp-anchor;
- named owners and final production switch decisions;
- lifecycle canary ON stages (alias/pending/deprovision);
- live staging status/preflight/off dispatches from this development lane (blockers in §3.2).

The interactive-card procedure of record remains `dingtalk-hardening-real-uat-evidence-pack-20260713.md`.

## 5. Transfer decision gate (T2-Gate)

Transfer T3-T5 remains **FROZEN**. The real two-corp T2-Gate has not run in this lane:

| T2-Gate verdict | Consequence |
|---|---|
| CONFIRMED | implement T2.5 tenant-scoped key migration before T3 |
| DISPROVED | T3 may be considered after owner authorization |
| INCONCLUSIVE / NOT EXECUTED | keep T3-T5 frozen |

**Procedure of record (post-fix):** `dingtalk-directory-corp-scope-staging-uat-20260725.md` (and closeout ledger `dingtalk-directory-corp-scope-closeout-verification-20260725.md`). Use that UAT after Phase A + Phase B deployment gates pass.

**Historical provenance only (not the current executable procedure):** `canonical-org-t2-gate-two-corp-staging-runbook-20260717.md` is the pre-fix evidence runbook. It is self-superseded for acceptance after corp-scope Phase B. Steps that described legacy global-key collision preflight against the pre-Phase-B schema **cannot be re-run as executable current steps after Phase B** — they remain **provenance requirements** (what was proven / what SHA and gate outputs must already be on file), not a procedure to re-execute on a post-Phase-B database. Do not point operators at the 20260717 runbook as the live T2-Gate gate.

## 6. Test infrastructure lane

Issue #4820 remains a separate test-infrastructure item. Shared `metasheet_test` can be reset by parallel sessions, so this implementation used the lane-owned scratch database `codex_ops01_comp2_20260810`. The durable follow-up is per-lane scratch DB provisioning and cleanup; it does not change the lifecycle product verdict, but future runtime evidence must not rely on a concurrently shared database.

## 7. Closure rule

This goal is complete only when the held PR has independent review, exact-head required CI, and a reviewable head. It remains unarmed. Canary, U1-U13/corp-anchor, T2-Gate, Transfer T3-T5, and #4820 are deliberately external or separate gates and are not represented as completed by this code PR.
