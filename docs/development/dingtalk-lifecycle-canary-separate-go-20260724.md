# DingTalk lifecycle canary — separate ops GO (not auto-enabled)

**Date:** 2026-07-24
**Updated:** 2026-08-11 (minimal safe lane; ON transitions **NOT EXECUTABLE**; canary **NOT EXECUTED**)
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

## Current staging blockers (canary NOT EXECUTED)

As of 2026-08-11 this lane remains **NOT EXECUTED** for lifecycle ON canaries. Staging preparation evidence:

1. Attendance staging runner [run 31407444155](https://github.com/zensgit/metasheet2/actions/runs/31407444155) completed backup + clone rehearsal + real apply: migration state `296 applied / 18 pending` -> `314 applied / 0 pending`; rehearsal isolation held and auth round-trip returned 200.
2. **Build provenance conflict remains live:** the running backend image tag is `b55c682748e3010cb70837770c298843a96e1019`, while `/api/health` still reports build commit `59c24a1d21cfc70b76867da7d0ac15590d558c72`. This PR fixes the source by making staging compose derive both build metadata variables from the exact `IMAGE_TAG`; after merge, redeploy/recreate and re-prove agreement before any write action.
3. The existing `DEPLOY_KNOWN_HOSTS` secret is the independently verified deploy-host identity. The lane uses `StrictHostKeyChecking=yes`; missing host identity blocks dispatch rather than producing forgeable evidence.

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
