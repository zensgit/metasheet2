# DingTalk lifecycle canary — separate ops GO (not auto-enabled)

**Date:** 2026-07-24
**Updated:** 2026-08-11 (OFF baseline verified; ON transitions **NOT EXECUTABLE**; ON canary **NOT EXECUTED**)
**Related locks:**
- `dingtalk-directory-admission-activation-lifecycle-design-20260723.md` Rev 4.2
- `dingtalk-deprovision-reactivation-and-evidence-chain-design-20260723.md` Rev 4.2
- Closeout execution: `dingtalk-lifecycle-six-step-closeout-execution-20260810.md`

## What is NOT enabled by merge

| Flag / action | Default after code land | Executable in this lane? |
|---------------|-------------------------|--------------------------|
| `DIRECTORY_PENDING_ACTIVATION_ENABLED` ON | **OFF** | **NOT EXECUTABLE** — no admit→activate verifier |
| `AUTH_LOGIN_USE_ALIASES` ON (T2b cutover) | **OFF** | **NOT EXECUTABLE** — no password-login success/rollback proof |
| `DIRECTORY_DEPROVISION_ENABLED` ON | **OFF** | **NOT EXECUTABLE** — no sync→deprovision verifier |
| Env-gate clear (`action=off`) | n/a | Executable emergency only (after migrations true + exact SHA) |

Presence of canary subject/integration/owner tokens is **not** a real canary and is **not** accepted as an ON enabler.

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
| `alias` / `pending` / `deprovision` | **NOT EXECUTABLE** | fail-closed preflight-only; `transition_applied=false` always |

Shared concurrency with `attendance-staging-window-runner`. Status artifacts stay values-free.

### Alias OFF vs design lock (no OR-column fallback)

`action=off` is an **emergency operational rollback of the env gate only**. Design lock Rev 4.2 §4.2 / §4.4 forbids reintroducing OR-column fallback on `users.email` / `username` / `mobile` as a long-term design after T2b. OFF is not canary completion and is not product permission to restore pre-T2b OR login.

## Current staging baseline (ON canary NOT EXECUTED)

As of 2026-08-11 this lane remains **NOT EXECUTED** for lifecycle ON canaries. Safe preparation evidence:

1. Attendance staging runner [run 31407444155](https://github.com/zensgit/metasheet2/actions/runs/31407444155) completed backup + clone rehearsal + real apply: migration state `296 applied / 18 pending` -> `314 applied / 0 pending`; rehearsal isolation held and auth round-trip returned 200.
2. [#4853](https://github.com/zensgit/metasheet2/pull/4853), merge commit `ddec28b12ebff97fae33af45553d77c149d816e1`, installs and validates the checked-out staging Compose file, pins Compose project-directory, and derives build metadata from the exact `IMAGE_TAG`.
3. Attendance staging [deploy 31418871030](https://github.com/zensgit/metasheet2/actions/runs/31418871030) force-recreated backend/web at exact SHA `ddec28b12ebff97fae33af45553d77c149d816e1` with no env flip. Backend and web health both reported that commit and image tag; migrations were `314/0`; auth/settings returned 200; Postgres/Redis IDs were unchanged.
4. Lifecycle [status 31418997337](https://github.com/zensgit/metasheet2/actions/runs/31418997337) proved exact build SHA, healthy backend, zero pending migrations, `mode=off`, and all three flags `false`.
5. Lifecycle [preflight 31419066036](https://github.com/zensgit/metasheet2/actions/runs/31419066036) proved `preflight_target_mode=off`, `preflight_ok=true`, and `transition_applied=false`. No env write occurred.
6. The existing `DEPLOY_KNOWN_HOSTS` secret is the independently verified deploy-host identity. The lane uses `StrictHostKeyChecking=yes`; missing host identity blocks dispatch rather than producing forgeable evidence.

The former image-tag/health-commit provenance conflict is resolved. This establishes only the safe OFF baseline, not an ON canary.

Until a **secret-backed real verifier** exists for:

- alias: real password-login success + documented emergency off proof (without OR fallback),
- pending: real admit→activate on an explicit canary subject,
- deprovision: real sync→deprovision on an explicit canary integration,

the ON actions stay **NOT EXECUTABLE**. Do not treat env flips or presence tokens as canary completion.

## Future canary sequence (when a real verifier + ops GO exist)

1. Staging: deploy exact SHA; image and health provenance agree; migrations pending=0 via backup/clone-rehearsal.
2. T2a backfill + collision report.
3. Real alias login proof → only then an executable alias ON (not this lane today).
4. Real admit→activate on explicit ids → only then pending ON.
5. Real deprovision proof → only then deprovision ON.
6. Production = separate GO.

## Owner note

Landing this lane ≠ authorizing traffic. **Canary NOT EXECUTED.** Merging code does not complete lifecycle canary.
