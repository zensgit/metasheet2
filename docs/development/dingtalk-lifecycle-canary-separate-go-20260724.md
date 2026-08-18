# DingTalk lifecycle canary — separate ops GO (not auto-enabled)

**Date:** 2026-07-24
**Updated:** 2026-08-12 (alias, server-side pending, and server-side deprovision apply/restore canaries completed with required terminal OFF proof at exact SHA `2bf058c2a4fd5abed76df347b3bfdb74dba148ee`; browser and production GO remain separate)
**Related locks:**
- `dingtalk-directory-admission-activation-lifecycle-design-20260723.md` Rev 4.2
- `dingtalk-deprovision-reactivation-and-evidence-chain-design-20260723.md` Rev 4.5
- Closeout execution: `dingtalk-lifecycle-six-step-closeout-execution-20260810.md`

## What is NOT enabled by merge

| Flag / action | Default after code land | Executable in this lane? |
|---------------|-------------------------|--------------------------|
| `DIRECTORY_PENDING_ACTIVATION_ENABLED` ON | **OFF** | **Executable only as a transient canary** on an explicit owned account. Default phase admits to pending and proves OFF rollback; optional SSO activation still records browser OAuth as `NOT_EXECUTED` until a human observes it. |
| `AUTH_LOGIN_USE_ALIASES` ON (T2b cutover) | **OFF** | **Executable only as a transient canary** (`action=alias`). Success requires/proves OFF in the same run; failure restores the OFF override before failing. Runtime OFF cannot be proven if rollback recreate itself fails (override restored on disk). Requires secret-backed password login; short-lived admin JWT is minted from that login (never `secrets.ATTENDANCE_ADMIN_JWT`). |
| `DIRECTORY_DEPROVISION_ENABLED` ON | **OFF** | **Executable only as a two-phase transient canary** on an explicit owned account in a dedicated exact target-plus-sentinel integration. Apply and restore are separate confirmed operations; every exit restores/proves the flags OFF or reports that runtime OFF is unproven. |
| Env-gate clear (`action=off`) | n/a | Executable emergency only (after migrations true + exact SHA) |
| Dedicated canary admin (`action=bootstrap`) | n/a | Executable staging-only create/repair of the **fixed** owned row only (no lifecycle env write) |

Presence of canary subject/integration/owner tokens is **not** a real canary and is **not** accepted as an ON enabler. There is **no** auto-selection of login identities, **no** password reset path, and **no** production fallback.

## Staging operator lane (minimal safe)

| Piece | Path |
|-------|------|
| Workflow | `.github/workflows/dingtalk-lifecycle-staging-canary.yml` |
| Remote script | `scripts/ops/dingtalk-lifecycle-staging-canary-remote.sh` |
| Contract suite | `scripts/ops/dingtalk-lifecycle-staging-canary-contract.test.mjs` |

| Action | Executable? | Behavior |
|--------|-------------|----------|
| `status` | yes | values-free snapshot; multi-on fail-closed after report |
| `preflight` | yes | readiness only; `migrations_pending_zero` must be exactly `true` (unknown fails) |
| `off` | yes | emergency clear of the three env gates; previous-override restore on failure; health true after restart required |
| `bootstrap` | yes (manual) | staging-only create/repair of fixed canary admin; see below; **no lifecycle env write** |
| `alias` | yes (transient) | secret-backed cutover canary; see sequence below; success requires/proves OFF |
| `pending` | yes (transient, **SERVER-SIDE PASS**) | explicit owned account admitted and activated through SSO intent; required OFF rollback passed; browser OAuth remains a human checkpoint |
| `deprovision` | yes (two-phase, **SERVER-SIDE PASS**) | explicit target + sentinel apply wrote one event/three effects; restore reversed the exact set, restored the access graph, cleared the journal, and kept all lifecycle flags OFF; browser checkpoints remain separate |

Shared concurrency with `attendance-staging-window-runner`. Status artifacts stay values-free (booleans / counts / reason enums / SHA only).

### Alias OFF vs design lock (no OR-column fallback)

`action=off` is an **emergency operational rollback of the env gate only**. Design lock Rev 4.2 §4.2 / §4.4 forbids reintroducing OR-column fallback on `users.email` / `username` / `mobile` as a long-term design after T2b. OFF is not canary completion and is not product permission to restore pre-T2b OR login.

### `action=bootstrap` — fixed dedicated lifecycle canary admin

**Purpose:** create or repair **only** the dedicated staging canary platform admin used by alias login. Does **not** enable lifecycle flags and does **not** touch an arbitrary existing admin.

**Fixed ownership markers (both required):**

- email: `lifecycle-canary@staging.invalid`
- user id: `6c1fe000-ca0a-4000-8000-1ec0c1e00001` (fixed valid UUID)

Any `users` row matching the email **or** the id that does **not** match **both** markers fails closed (`collision_not_owned` / `collision_multiple_rows`). No email/role scan of other admins.

**Required inputs / secrets:**

- `deploy_sha` — full 40-char lowercase staging deploy SHA
- `expected_current_mode=off` (strict)
- `bootstrap_confirmation=CREATE_STAGING_CANARY_ADMIN` (explicit privileged-operation confirmation)
- `secrets.LIFECYCLE_CANARY_LOGIN_IDENTIFIER` — must decode+trim to exact `lifecycle-canary@staging.invalid`
- `secrets.LIFECYCLE_CANARY_LOGIN_PASSWORD` — exact password bytes for that account (no CR/LF strip)

**Gates before mutation:** exact deployed SHA (image tag + health commit agree), live mode `off`, backend health true, `migrations_pending_zero=true`.

**Hard safety for bootstrap credentials + row mutation:**

| Rule | Behavior |
|------|----------|
| Secret transport | Host streams exact identifier/password bytes over `docker exec` **stdin** (uint32be length frames). **No `docker cp`**, no persistent secret files under `/tmp` (or elsewhere) inside the backend container. |
| Non-secret markers only | Container node receives fixed owner email/id + min password length via env only — never secret values in argv/export/logs. |
| Password floor | Exact stored password length must be **≥ 12** (`password_too_short` fail-closed). |
| `users.permissions` | Column **omitted** on insert/repair (054 `TEXT[]` default and later jsonb defaults both work; never `'[]'::jsonb`). |
| Collision | Email **or** id match that is not **both** markers → fail closed; never mutates an arbitrary admin. |
| Create/repair sessions | **Required primary guard** (same transaction, same shape as `session-revocation.ts` `revokeUserSessions`): upsert `user_session_revocations` (`user_id, revoked_after, updated_at, updated_by, reason` with `ON CONFLICT DO UPDATE` of the watermark). Its absence rolls back the mutation. Create also advances it because a previously deleted fixed row may have left orphaned stateless tokens. JWT verification uses `revoked_after` — updating `user_sessions` alone is **not** sufficient. Optional additional belt on repair: revoke live `user_sessions` rows when that table exists. Reasons: `lifecycle_canary_bootstrap_password_create|repair`. Before the new login proof, cross the next JWT `iat` second so the new token is newer than the watermark. |
| Post-proof posture | After password login proof: re-capture and require mode still `off`, health true, migrations still zero, exact SHA unchanged. |
| Env flags | **Never** writes lifecycle override / never enables alias/pending/deprovision. |

**Transaction shape:** `BEGIN` → `SELECT … FOR UPDATE` on id/email → insert or repair owned row as active activated platform admin (`role=admin`, `is_admin=true`, `is_active=true`, `activation_status=activated`, `local_password_set=true`, `must_change_password=false`, `user_roles` admin + needed permissions) → optional session revoke on repair → `COMMIT`. Then prove real `POST /api/auth/login` and reassert OFF/health/SHA. Artifacts report outcome enums only (`created` / `repaired`); never credentials, tokens, or PII. `transition_applied=false` and `lifecycle_env_write=false`.

### `action=alias` — transient secret-backed cutover canary

**Required inputs / secrets (no auto-selection; no `ATTENDANCE_ADMIN_JWT`):**

- `deploy_sha` — full 40-char lowercase staging deploy SHA
- `expected_current_mode=off` (strict; refuse other values)
- `secrets.LIFECYCLE_CANARY_LOGIN_IDENTIFIER` — exact fixed canary email (after trim)
- `secrets.LIFECYCLE_CANARY_LOGIN_PASSWORD` — real password for that identifier (read exactly as stored; no CR/LF strip)

**Admin JWT derivation:** after successful pre-ON password login, the remote script writes the short-lived login token to a **chmod 600** per-run remote secret file (`admin.jwt` beside the password file) and uses that path for `POST /api/admin/login-aliases/backfill` and `GET /api/admin/login-aliases/cutover-status`. The lane **never** consumes or overwrites repo-global `secrets.ATTENDANCE_ADMIN_JWT`.

**Secret transport:** only the **Run remote action** step receives identifier/password as step env. Its first lines (builtins only) copy them into **non-exported** shell variables and **unset** the exported names so no external child (`mktemp`, `ssh`, `scp`, `bash`) inherits raw secret env. Then it installs an `EXIT`/`INT`/`TERM` cleanup trap **before** `mktemp`, writes identifier/password as local `chmod 600` files via `printf '%s'` from the shell variables (exact password bytes), **unsets the shell variables immediately after the writes**, then remote `mkdir`/`scp` path-only into the per-run remote directory, exports **file paths only** (`CANARY_LOGIN_*_FILE`) to the remote script, and deletes local temp + per-run remote secrets/runner paths on every exit path. The **Validate inputs** step does **not** receive or check those secrets (so `bash -n` cannot inherit them). Secrets are **not** materialized in a prior step or passed via a `secrets_dir` output. Values must not appear in shell argv, process listings via exported env, logs, or artifacts. Persistent `~/.metasheet2` overrides are never deleted by this cleanup. Same transport is shared with `action=bootstrap`.

**Remote sequence (fail closed; any post-write failure restores OFF override before failing):**

1. Prove exact SHA (image tag + health commit agree), backend health true, `migrations_pending_zero=true`, live mode `off`.
2. Real `POST /api/auth/login` with secret identifier/password (**pre-ON**) and mint short-lived admin JWT file from that response.
3. Authenticated `POST /api/admin/login-aliases/backfill` (minted JWT file) — require success; **exact nonnegative integer counts** with **`collisions==0`** (nonzero collisions refuse env write; alias-only would lock collided users out).
4. Authenticated `GET /api/admin/login-aliases/cutover-status` — require `ready=true` and `canEnableCutover=true`.
5. Establish a **compose-validated explicit OFF** rollback baseline on disk (all three flags false) and snapshot it — **never** restore an arbitrary prior on-disk file (a stale unapplied `alias=true` override would re-enable alias after recreate). Arm the remote `EXIT`/`HUP`/`INT`/`TERM`/`PIPE` rollback guard **before** the persistent ON write; it remains armed until runtime OFF and the post-rollback login are proven. Emergency recovery logs to the remote per-run output file rather than the possibly broken SSH stream. Then write `AUTH_LOGIN_USE_ALIASES=true` with pending/deprovision false; recreate **backend only** (Postgres/Redis container IDs unchanged).
6. Prove exact SHA, mode `alias`, health true, and real password login (**post-ON**).
7. Restore the **explicit OFF baseline** (success and post-write failure paths); recreate backend only; prove exact mode `off`, health, SHA, and real password login (**post-rollback**). **Success requires/proves OFF.** The canary leaves the persistent lifecycle override **explicitly OFF**. If rollback recreate fails, **runtime OFF cannot be proven** (OFF baseline restored on disk; operator must inspect).

Backfill alias rows **may persist** after the run. Artifacts report only booleans / counts / reason enums / SHA — never credentials, identifiers, tokens, or PII.

**Repo state note:** `LIFECYCLE_CANARY_LOGIN_IDENTIFIER` / `LIFECYCLE_CANARY_LOGIN_PASSWORD` must be configured before a real bootstrap or alias dispatch. This lane does **not** use `ATTENDANCE_ADMIN_JWT`. Code landing alone configures no secret and proves no runtime result; the successful staging executions are separately bound to the runs below.

## Current staging baseline (three server-side canaries executed and rolled back)

As of 2026-08-12 the alias, server-side pending, and server-side deprovision apply/restore canaries are complete with terminal OFF proof. Browser OAuth/login checkpoints and production enablement remain separate. Safe preparation and execution evidence:

1. Attendance staging runner [run 31407444155](https://github.com/zensgit/metasheet2/actions/runs/31407444155) completed backup + clone rehearsal + real apply: migration state `296 applied / 18 pending` -> `314 applied / 0 pending`; rehearsal isolation held and auth round-trip returned 200.
2. [#4853](https://github.com/zensgit/metasheet2/pull/4853), merge commit `ddec28b12ebff97fae33af45553d77c149d816e1`, installs and validates the checked-out staging Compose file, pins Compose project-directory, and derives build metadata from the exact `IMAGE_TAG`.
3. Attendance staging [deploy 31418871030](https://github.com/zensgit/metasheet2/actions/runs/31418871030) force-recreated backend/web at exact SHA `ddec28b12ebff97fae33af45553d77c149d816e1` with no env flip. Backend and web health both reported that commit and image tag; migrations were `314/0`; auth/settings returned 200; Postgres/Redis IDs were unchanged.
4. Lifecycle [status 31418997337](https://github.com/zensgit/metasheet2/actions/runs/31418997337) proved exact build SHA, healthy backend, zero pending migrations, `mode=off`, and all three flags `false`.
5. Lifecycle [preflight 31419066036](https://github.com/zensgit/metasheet2/actions/runs/31419066036) proved `preflight_target_mode=off`, `preflight_ok=true`, and `transition_applied=false`. No env write occurred.
6. The existing `DEPLOY_KNOWN_HOSTS` secret is the independently verified deploy-host identity. The lane uses `StrictHostKeyChecking=yes`; missing host identity blocks dispatch rather than producing forgeable evidence.
7. Lifecycle [status 31504862038](https://github.com/zensgit/metasheet2/actions/runs/31504862038) re-proved the exact staging SHA, healthy backend, zero pending migrations, mode `off`, and all three flags `false`.
8. Lifecycle [alias 31504979575](https://github.com/zensgit/metasheet2/actions/runs/31504979575) proved password login before ON, during alias-only, and after rollback; it reported zero collisions and finished in exact mode `off` with all three flags `false`.
9. [#4873](https://github.com/zensgit/metasheet2/pull/4873), merge commit `24794811b1c800402006b30d6e4fa9df670e124e`, added caller-reserved sync-run ids, exact-run recovery, a staged recovery journal, and the dedicated one-account/exclusive-window deprovision gates.
10. Attendance staging [deploy 31528635839](https://github.com/zensgit/metasheet2/actions/runs/31528635839) deployed exact SHA `24794811b1c800402006b30d6e4fa9df670e124e`; lifecycle [status 31528753683](https://github.com/zensgit/metasheet2/actions/runs/31528753683) and [OFF preflight 31528911914](https://github.com/zensgit/metasheet2/actions/runs/31528911914) proved healthy backend, zero pending migrations, exact mode `off`, and all three flags `false`.
11. Hardened-deploy lifecycle [alias 31529335625](https://github.com/zensgit/metasheet2/actions/runs/31529335625) again proved password login before ON, during alias-only, and after rollback; zero collisions; exact deployed SHA; and terminal mode `off` with all three flags `false`. This is the current alias proof; run `31504979575` remains historical evidence for the older deploy.
12. Pending [admit 31551343313](https://github.com/zensgit/metasheet2/actions/runs/31551343313) and [SSO activate-intent 31551426867](https://github.com/zensgit/metasheet2/actions/runs/31551426867) used the explicit owned subject and left all lifecycle flags OFF. Browser OAuth checkpoints remain `NOT_EXECUTED`.
13. [#4875](https://github.com/zensgit/metasheet2/pull/4875) and recovery [31555162698](https://github.com/zensgit/metasheet2/actions/runs/31555162698) closed an exact empty-fetch abort with zero ledger and unchanged access graph.
14. [#4877](https://github.com/zensgit/metasheet2/pull/4877), merge `51f23ec7255c3fb0d9abc21bfbe4c3bce8e1c48f`, and runs [31559288370](https://github.com/zensgit/metasheet2/actions/runs/31559288370), [31559371562](https://github.com/zensgit/metasheet2/actions/runs/31559371562), and [31559480395](https://github.com/zensgit/metasheet2/actions/runs/31559480395) prove exact staging deploy, exact sync-failure recovery, cleared journal, unchanged access graph, zero ledger, and terminal mode `off`.
15. [#4879](https://github.com/zensgit/metasheet2/pull/4879), merge `2bf058c2a4fd5abed76df347b3bfdb74dba148ee`, added the explicit distinct sentinel gate. Staging [deploy 31573166502](https://github.com/zensgit/metasheet2/actions/runs/31573166502), [status 31573329397](https://github.com/zensgit/metasheet2/actions/runs/31573329397), and [preflight 31575076447](https://github.com/zensgit/metasheet2/actions/runs/31575076447) proved the exact deployed SHA, `314/0` migrations, health, and OFF baseline.
16. [Apply 31575411459](https://github.com/zensgit/metasheet2/actions/runs/31575411459) proved the exact target-and-sentinel source shape, one deactivation candidate, one event, three effects, generation advance, disabled access graph, retained `ledger_bound` journal, and automatic flag rollback to OFF.
17. [Restore 31575938536](https://github.com/zensgit/metasheet2/actions/runs/31575938536) proved source reactivation, exact three-effect reversal, fully resolved event, restored user/membership/grant graph, cleared journal, and flags remaining OFF. Its browser checkpoints remain `NOT_EXECUTED` and it does not claim browser end-to-end restore.
18. The temporary sentinel was removed from the canary department after restore; the organization member count remained unchanged and the department returned to the target-only source shape.
19. Terminal read-only [status 31576139497](https://github.com/zensgit/metasheet2/actions/runs/31576139497) reports exact SHA `2bf058c2a4fd5abed76df347b3bfdb74dba148ee`, healthy backend, zero pending migrations, mode `off`, all three lifecycle flags `false`, and `transition_applied=false`.
20. Post-restore read-only [production-readiness inventory 31579935836](https://github.com/zensgit/metasheet2/actions/runs/31579935836) reports the same exact deployed SHA, one active corp-anchored DingTalk integration, two active linked local users, and all lifecycle/Stream flags OFF. It also re-confirms that the four Stream/template prerequisites remain absent, so U1-U13 and the real callback corp-anchor remain `NOT_EXECUTED` rather than inferred green.

The former image-tag/health-commit provenance conflict is resolved. This establishes the safe OFF baseline and the three server-side transient staging canaries; it does not authorize production lifecycle traffic.

The secret-backed operators now exist; pending admission/SSO activation and deprovision
apply/restore have run against the explicit owned source employee. Deprovision refuses any integration
that is scheduled, auto-admitting, member-group projecting, or contains anything other than the
explicit selected directory account plus the distinct active unlinked sentinel required for apply
(inactive rows count too). The dedicated integration passed those gates; using an employee already
present in another integration still fails before ledger by design.

Apply also requires the literal confirmation
`DINGTALK_SOURCE_DISABLED_DEDICATED_EXCLUSIVE_CONFIRMED`: the source is disabled, the integration
is dedicated to the one canary account, and no other operator may sync or edit that integration
until the apply window has returned all lifecycle flags to OFF. Preview plus the exact target-plus-sentinel
precondition are strong fail-closed gates, but they are not an atomic scope lock; this explicit
exclusive window is therefore a required operational hold, not an optional note.

For deprovision apply, journal schema v4 persists the subject tuple and a random run UUID **before**
the env write and HTTP request. The async API must claim that UUID; a repeated request returns the
same run without a second provider pull. A lost 202 or runner crash is recovered only from that
exact UUID, then the exact event/effect triple. Restore status is read by exact event/user/integration
tuple rather than a recent-events page. No latest/sole-event inference is permitted.
If the reserved run terminates without a matching ledger event, the journal intentionally blocks
both overwrite and a guessed restore. That state requires an owner-reviewed abandonment procedure;
operators must not delete the journal merely to retry.

The full values-free execution record is `dingtalk-staging-lifecycle-canary-and-uat-execution-20260811.md`.

## Canary sequence

1. **Complete:** staging exact-SHA deployment, migrations, backup/clone rehearsal, and health provenance.
2. **Complete:** configure the fixed alias-canary login secrets without exposing their values.
3. **Complete:** create/repair the dedicated canary administrators and prove password login with all flags OFF.
4. **Complete:** dispatch `action=alias`; prove transient ON login and required OFF rollback login.
5. **Complete server-side; browser OAuth NOT EXECUTED:** real admit→SSO activate intent on the explicitly owned employee, with pending rollback to OFF.
6. **Complete server-side; browser checkpoints NOT EXECUTED:** real source departure, exact event/effect apply, source re-add, exact restore, sentinel removal, cleared journal, and terminal OFF proof.
7. Production remains a separate GO.

## Owner note

Landing this lane does not authorize traffic. Alias, server-side pending, and server-side deprovision canaries succeeded and returned to OFF. Browser checkpoints, U1-U13, real callback evidence, and production GO remain incomplete. Merging code and completing staging canaries do not leave any lifecycle flag enabled or authorize production traffic.
