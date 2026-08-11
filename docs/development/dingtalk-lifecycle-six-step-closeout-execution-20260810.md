# DingTalk lifecycle six-step closeout execution

- Date: 2026-08-10
- Updated: 2026-08-12
- Status: **CODE + STAGING ALIAS CANARY COMPLETE / PENDING + DEPROVISION + EXTERNAL GATES NOT EXECUTED**
- Baseline: `origin/main @ 24794811b1c800402006b30d6e4fa9df670e124e`
- Scope: close the OPS-01 superseded creation-effect residue without enabling lifecycle traffic
- Operator lane (staging only, default-off): `.github/workflows/dingtalk-lifecycle-staging-canary.yml` + `scripts/ops/dingtalk-lifecycle-staging-canary-remote.sh` — `status` and transient `alias -> off` executed; pending/deprovision not executed

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
| Exact-head required CI | PASS at `9d84c3f70130f5fa38d26247d45fa922e0f830db` |

Landed as [#4850](https://github.com/zensgit/metasheet2/pull/4850), merge commit `b55c682748e3010cb70837770c298843a96e1019`.

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

Merge is not an enablement instruction. The staging alias canary was later executed and returned to OFF; pending admission and deprovision remain **NOT EXECUTED**. See `dingtalk-staging-lifecycle-canary-and-uat-execution-20260811.md`.

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
| `alias` | yes (transient) | secret-backed password login before ON, during alias-only, and after required OFF rollback |
| `pending` | yes (transient, **NOT EXECUTED**) | explicit owned directory-account subject; admit-only or optional SSO activation; success requires OFF rollback; unobserved browser OAuth stays `NOT_EXECUTED` |
| `deprovision` | yes (two-phase, **NOT EXECUTED**) | explicit owned subject in a dedicated one-account manual integration; exact preview/planner radius; pre-request reserved run UUID; exact ledger/restore; success requires OFF rollback |

`action=off` is an **emergency operational rollback of the env gate only**. Design lock Rev 4.2 §4.2 / §4.4 permanently forbids reintroducing OR-column fallback on `users.email` / `username` / `mobile` as a long-term design after T2b. OFF is not “canary stage 1 complete.”

### 3.2 Staging preparation and alias result (2026-08-11)

The safe OFF baseline and transient alias canary are proven:

1. [Attendance staging runner 31407444155](https://github.com/zensgit/metasheet2/actions/runs/31407444155) completed host backup, clone rehearsal, isolation check, real migration, and auth round-trip. Migration state moved from `296 applied / 18 pending` to `314 applied / 0 pending`. The backup is retained on the deploy host; only its values-free metadata and SHA-256 entered the artifact.
2. [#4853](https://github.com/zensgit/metasheet2/pull/4853), merge commit `ddec28b12ebff97fae33af45553d77c149d816e1`, made the staging runner install and validate the checked-out staging Compose file before deploy. It also pins Compose project-directory and exact `IMAGE_TAG` metadata. Exact-head CI passed 15/15.
3. [Attendance staging deploy 31418871030](https://github.com/zensgit/metasheet2/actions/runs/31418871030) force-recreated only backend/web from exact SHA `ddec28b12ebff97fae33af45553d77c149d816e1`, with `set_window_env=none`. Backend and web health both reported that exact commit and image tag; migrations were `314/0`; auth and settings returned HTTP 200; Postgres and Redis container IDs were unchanged.
4. [Lifecycle status 31418997337](https://github.com/zensgit/metasheet2/actions/runs/31418997337) reported `mode=off`, all three lifecycle flags `false`, exact build SHA, zero pending migrations, healthy backend, and `transition_applied=false`.
5. [Lifecycle preflight 31419066036](https://github.com/zensgit/metasheet2/actions/runs/31419066036) reported `preflight_target_mode=off`, `preflight_ok=true`, all flags still OFF, and `transition_applied=false`.
6. The existing `DEPLOY_KNOWN_HOSTS` secret supplies the independently verified host key. SSH and SCP require `StrictHostKeyChecking=yes`; this evidence lane does not accept first-use trust.
7. [Lifecycle status 31504862038](https://github.com/zensgit/metasheet2/actions/runs/31504862038) re-proved the exact staging SHA, healthy backend, zero pending migrations, mode `off`, and all three flags `false`.
8. [Lifecycle alias 31504979575](https://github.com/zensgit/metasheet2/actions/runs/31504979575) proved real password login before ON, while alias-only was live, and after rollback. It reported zero collisions and finished in exact mode `off` with all three flags `false`.
9. [#4873](https://github.com/zensgit/metasheet2/pull/4873), merge commit `24794811b1c800402006b30d6e4fa9df670e124e`, hardened deprovision execution with a caller-reserved exact run id, recovery journal, exact ledger binding, and dedicated one-account/exclusive-window gates.
10. [Attendance staging deploy 31528635839](https://github.com/zensgit/metasheet2/actions/runs/31528635839), [lifecycle status 31528753683](https://github.com/zensgit/metasheet2/actions/runs/31528753683), and [OFF preflight 31528911914](https://github.com/zensgit/metasheet2/actions/runs/31528911914) jointly proved the exact hardened deploy, healthy backend, zero pending migrations, and all three lifecycle flags OFF.
11. [Lifecycle alias 31529335625](https://github.com/zensgit/metasheet2/actions/runs/31529335625) re-ran the three password-login legs against the hardened deploy, reported zero collisions, and finished in exact mode `off`. This supersedes the older deploy as the current alias proof.

The former image-tag/health-commit conflict is resolved. Alias production enablement remains a separate owner GO. Pending and deprovision operators are implemented but remain blocked by the absence of an explicitly owned real test subject and, for deprovision, a dedicated one-account integration. The existing shared employee integration is not eligible.

### 3.3 Canary stages

| Stage | Result | Required real proof |
|---|---|---|
| 1 | alias-only **PASS, rolled back** | password-login success against aliases + required `off` proof without OR-column fallback |
| 2 | pending admission **NOT EXECUTED** | transient admit→activate on an explicit canary subject (not a presence token), then prove OFF |
| 3 | deprovision **NOT EXECUTED** | dedicated one-account integration; reserved exact run UUID; sync→ledger→restore on the same subject, then prove OFF |

## 4. Owner and ops acceptance

Real enterprise evidence is unavailable in this development lane. Therefore these are explicitly **NOT EXECUTED**, not simulated PASS:

- U1-U13 interactive-card acceptance;
- U11-a real callback corp-anchor;
- named owners and final production switch decisions;
- lifecycle pending/deprovision stages (alias staging canary passed and rolled back; production alias remains a separate decision);

Staging `status` and alias `off -> alias -> off` are complete per §3.2. The alias run's success condition included runtime OFF and a post-rollback password login.

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

Issue #4820 remains open for recurrence observation. [#4852](https://github.com/zensgit/metasheet2/pull/4852), merge commit `f0745831fe5385ccacf8fe6d6e5fd51174c02117`, added per-lane scratch DB provisioning and cleanup for the affected startup fail-closed real-DB suite. This closeout also used the lane-owned database `codex_ops01_comp2_20260810`. The mitigation does not change the lifecycle product verdict; future runtime evidence must not rely on a concurrently shared database.

## 7. Closure rule

The code and safe staging OFF-preflight portions of this six-step closeout are complete:

| Delivery | Merge commit |
|---|---|
| OPS-01 explicit compensation, #4850 | `b55c682748e3010cb70837770c298843a96e1019` |
| Staging operator lane, #4851 | `0083621f5dd1fd6dbeb0a5b71815156804e20a3b` |
| Per-lane scratch DB mitigation, #4852 | `f0745831fe5385ccacf8fe6d6e5fd51174c02117` |
| Exact staging Compose/provenance sync, #4853 | `ddec28b12ebff97fae33af45553d77c149d816e1` |
| Canary exact-run recovery and dedicated-integration hardening, #4873 | `24794811b1c800402006b30d6e4fa9df670e124e` |

The staging alias canary is complete and rolled back. Pending/deprovision canaries, U1-U13/corp-anchor, named production decisions, and the real two-corp T2-Gate are deliberately **NOT EXECUTED**. Transfer T3-T5 remains frozen. Issue #4820 remains open for recurrence observation. None of those remaining gates is represented as PASS by this closeout.
