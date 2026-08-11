# DingTalk lifecycle canary — separate ops GO (not auto-enabled)

**Date:** 2026-07-24
**Updated:** 2026-08-11 (alias lane made executable as a **transient** secret-backed cutover; success requires/proves OFF; failure restores the OFF override before failing; pending/deprovision remain **NOT EXECUTABLE**; no successful ON canary run claimed here)
**Related locks:**
- `dingtalk-directory-admission-activation-lifecycle-design-20260723.md` Rev 4.2
- `dingtalk-deprovision-reactivation-and-evidence-chain-design-20260723.md` Rev 4.2
- Closeout execution: `dingtalk-lifecycle-six-step-closeout-execution-20260810.md`

## What is NOT enabled by merge

| Flag / action | Default after code land | Executable in this lane? |
|---------------|-------------------------|--------------------------|
| `DIRECTORY_PENDING_ACTIVATION_ENABLED` ON | **OFF** | **NOT EXECUTABLE** — no admit→activate verifier |
| `AUTH_LOGIN_USE_ALIASES` ON (T2b cutover) | **OFF** | **Executable only as a transient canary** (`action=alias`). Success requires/proves OFF in the same run; failure restores the OFF override before failing. Runtime OFF cannot be proven if rollback recreate itself fails (override restored on disk). Requires secret-backed password login + admin JWT. |
| `DIRECTORY_DEPROVISION_ENABLED` ON | **OFF** | **NOT EXECUTABLE** — no sync→deprovision verifier |
| Env-gate clear (`action=off`) | n/a | Executable emergency only (after migrations true + exact SHA) |

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
| `alias` | yes (transient) | secret-backed cutover canary; see sequence below; success requires/proves OFF |
| `pending` / `deprovision` | **NOT EXECUTABLE** | fail-closed preflight-only; `transition_applied=false` always |

Shared concurrency with `attendance-staging-window-runner`. Status artifacts stay values-free (booleans / counts / reason enums / SHA only).

### Alias OFF vs design lock (no OR-column fallback)

`action=off` is an **emergency operational rollback of the env gate only**. Design lock Rev 4.2 §4.2 / §4.4 forbids reintroducing OR-column fallback on `users.email` / `username` / `mobile` as a long-term design after T2b. OFF is not canary completion and is not product permission to restore pre-T2b OR login.

### `action=alias` — transient secret-backed cutover canary

**Required inputs / secrets (no auto-selection):**

- `deploy_sha` — full 40-char lowercase staging deploy SHA
- `expected_current_mode=off` (strict; refuse other values)
- `secrets.ATTENDANCE_ADMIN_JWT` — platform-admin JWT for `POST /api/admin/login-aliases/backfill` and `GET /api/admin/login-aliases/cutover-status`
- `secrets.LIFECYCLE_CANARY_LOGIN_IDENTIFIER` — real staging login identifier (email/username/mobile already claimed or claimable)
- `secrets.LIFECYCLE_CANARY_LOGIN_PASSWORD` — real password for that identifier (read exactly as stored; no CR/LF strip)

**Secret transport:** only the **Run remote action** step receives the three alias secrets as step env. Its first lines (builtins only) copy them into **non-exported** shell variables and **unset** the exported names so no external child (`mktemp`, `ssh`, `scp`, `bash`) inherits raw secret env. Then it installs an `EXIT`/`INT`/`TERM` cleanup trap **before** `mktemp`, writes JWT/identifier/password as local `chmod 600` files via `printf '%s'` from the shell variables (exact password bytes), **unsets the shell variables immediately after the writes**, then remote `mkdir`/`scp` path-only into the per-run remote directory, exports **file paths only** (`CANARY_*_FILE`) to the remote script, and deletes local temp + per-run remote secrets/runner paths on every exit path. The **Validate inputs** step does **not** receive or check those secrets (so `bash -n` cannot inherit them). Secrets are **not** materialized in a prior step or passed via a `secrets_dir` output. Values must not appear in shell argv, process listings via exported env, logs, or artifacts. Persistent `~/.metasheet2` overrides are never deleted by this cleanup.

**Remote sequence (fail closed; any post-write failure restores OFF override before failing):**

1. Prove exact SHA (image tag + health commit agree), backend health true, `migrations_pending_zero=true`, live mode `off`.
2. Real `POST /api/auth/login` with secret identifier/password (**pre-ON**).
3. Authenticated `POST /api/admin/login-aliases/backfill` (admin JWT) — require success; **exact nonnegative integer counts** with **`collisions==0`** (nonzero collisions refuse env write; alias-only would lock collided users out).
4. Authenticated `GET /api/admin/login-aliases/cutover-status` — require `ready=true` and `canEnableCutover=true`.
5. Establish a **compose-validated explicit OFF** rollback baseline on disk (all three flags false) and snapshot it — **never** restore an arbitrary prior on-disk file (a stale unapplied `alias=true` override would re-enable alias after recreate). Arm the remote `EXIT`/`HUP`/`INT`/`TERM`/`PIPE` rollback guard **before** the persistent ON write; it remains armed until runtime OFF and the post-rollback login are proven. Emergency recovery logs to the remote per-run output file rather than the possibly broken SSH stream. Then write `AUTH_LOGIN_USE_ALIASES=true` with pending/deprovision false; recreate **backend only** (Postgres/Redis container IDs unchanged).
6. Prove exact SHA, mode `alias`, health true, and real password login (**post-ON**).
7. Restore the **explicit OFF baseline** (success and post-write failure paths); recreate backend only; prove exact mode `off`, health, SHA, and real password login (**post-rollback**). **Success requires/proves OFF.** The canary leaves the persistent lifecycle override **explicitly OFF**. If rollback recreate fails, **runtime OFF cannot be proven** (OFF baseline restored on disk; operator must inspect).

Backfill alias rows **may persist** after the run. Artifacts report only booleans / counts / reason enums / SHA — never credentials, identifiers, tokens, or PII.

**Repo state note:** `ATTENDANCE_ADMIN_JWT` may already exist; `LIFECYCLE_CANARY_LOGIN_IDENTIFIER` / `LIFECYCLE_CANARY_LOGIN_PASSWORD` are new secrets that must be configured before a real alias dispatch. Landing this code does **not** configure those secrets and does **not** claim a successful canary execution.

## Current staging baseline (ON canary NOT EXECUTED)

As of 2026-08-11 this lane remains **NOT EXECUTED** for a completed alias cutover canary run (secrets for identifier/password may be absent; no invented success). Safe preparation evidence for the OFF baseline:

1. Attendance staging runner [run 31407444155](https://github.com/zensgit/metasheet2/actions/runs/31407444155) completed backup + clone rehearsal + real apply: migration state `296 applied / 18 pending` -> `314 applied / 0 pending`; rehearsal isolation held and auth round-trip returned 200.
2. [#4853](https://github.com/zensgit/metasheet2/pull/4853), merge commit `ddec28b12ebff97fae33af45553d77c149d816e1`, installs and validates the checked-out staging Compose file, pins Compose project-directory, and derives build metadata from the exact `IMAGE_TAG`.
3. Attendance staging [deploy 31418871030](https://github.com/zensgit/metasheet2/actions/runs/31418871030) force-recreated backend/web at exact SHA `ddec28b12ebff97fae33af45553d77c149d816e1` with no env flip. Backend and web health both reported that commit and image tag; migrations were `314/0`; auth/settings returned 200; Postgres/Redis IDs were unchanged.
4. Lifecycle [status 31418997337](https://github.com/zensgit/metasheet2/actions/runs/31418997337) proved exact build SHA, healthy backend, zero pending migrations, `mode=off`, and all three flags `false`.
5. Lifecycle [preflight 31419066036](https://github.com/zensgit/metasheet2/actions/runs/31419066036) proved `preflight_target_mode=off`, `preflight_ok=true`, and `transition_applied=false`. No env write occurred.
6. The existing `DEPLOY_KNOWN_HOSTS` secret is the independently verified deploy-host identity. The lane uses `StrictHostKeyChecking=yes`; missing host identity blocks dispatch rather than producing forgeable evidence.

The former image-tag/health-commit provenance conflict is resolved. This establishes only the safe OFF baseline, not an executed alias canary.

Until a **secret-backed real verifier** exists for:

- pending: real admit→activate on an explicit canary subject,
- deprovision: real sync→deprovision on an explicit canary integration,

those ON actions stay **NOT EXECUTABLE**. Alias now has a verifier path in this lane, but a successful run still requires configured secrets + operator dispatch and is **NOT EXECUTED** by this documentation alone.

## Future canary sequence (when secrets + ops GO exist)

1. Staging: deploy exact SHA; image and health provenance agree; migrations pending=0 via backup/clone-rehearsal.
2. Configure `LIFECYCLE_CANARY_LOGIN_IDENTIFIER` / `LIFECYCLE_CANARY_LOGIN_PASSWORD` (plus existing `ATTENDANCE_ADMIN_JWT`).
3. Dispatch `action=alias` with full `deploy_sha` and `expected_current_mode=off` — transient ON proof + OFF success proof (or OFF override restore on failure).
4. Real admit→activate on explicit ids → only then pending ON (still not this lane today).
5. Real deprovision proof → only then deprovision ON.
6. Production = separate GO.

## Owner note

Landing this lane ≠ authorizing traffic and ≠ completing canary. **Alias cutover canary NOT EXECUTED** until a real dispatch with secrets succeeds. Merging code does not leave `AUTH_LOGIN_USE_ALIASES` enabled and does not complete lifecycle canary.
