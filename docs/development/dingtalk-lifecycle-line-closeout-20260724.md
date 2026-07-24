# DingTalk lifecycle line closeout (T1–T3 · D1–D7)

**Date:** 2026-07-24  
**Main tip at closeout write:** see merge table below (refresh with `git log origin/main`).

## Merge SHAs (durable)

| Slice | PR | Merge commit on `main` | Notes |
|-------|-----|------------------------|--------|
| **T1** dual-axis + gates | [#4559](https://github.com/zensgit/metasheet2/pull/4559) | `27178ef4423dcc06446aef0d7d206687ff8ff55d` | `activation_status` / `local_password_set`; pending create **default OFF**; invite accept real-DB concurrency goldens |
| **T2+T3+D1–D6 backend** | [#4574](https://github.com/zensgit/metasheet2/pull/4574) | `014fc23acb58feb1863f79a1c4151b0313fb654b` | aliases, activate, planner/ledger/restore eligibility; flags default-off |
| **D7 UI + alias env contract** | *(this PR)* | *(fill after merge)* | `AUTH_LOGIN_USE_ALIASES` templates + closeout contract; admin deprovision evidence panel |

## Verification evidence

### T1
- Unit: `user-activation`, auth invite/login, api-token creator gate, pending-admit default-off
- Real-DB: `tests/integration/invite-accept-concurrency-rollback.db.test.ts` **4/4** (two distinct waiters + ledger rollback)
- CI: exact-head required checks green before merge of #4559

### T2
- Unit: `login-identifier`, `login-alias-service` (backfill collision + cutover gate)
- Auth: OR-column login until `AUTH_LOGIN_USE_ALIASES=true`
- Deploy: `docker/app.env.example` + `docker/app.staging.env.example` ship `AUTH_LOGIN_USE_ALIASES=false` with comment; pinned by `scripts/ops/dingtalk-closeout-env-contract.test.mjs`

### T3
- Unit: `user-activate` (temp password promote; reject non-pending; reject inactive directory source)
- Admin: `POST /api/admin/users/:id/activate`

### D1–D6 (backend)
- Unit: `deprovision-planner` (pending → zero effects), `deprovision-restore` (drift / rehire / force)
- Migrations: ledger tables + immutability triggers + `users.access_generation`
- **Do not** enable `DIRECTORY_DEPROVISION_ENABLED` without ops GO

### D7 (UI)
- Panel: `apps/web/src/components/directory/DirectoryDeprovisionEvidencePanel.vue` on Directory admin when an integration is selected
- APIs: `/api/admin/directory/deprovision/flags|preview/:userId|events|events/:id/effects|events/:id/restore`
- UI: flags banner, plan preview, event list, rehire vs admin force, `DRIFT_CONFLICT` display
- Front tests: `apps/web/tests/DirectoryDeprovisionEvidencePanel.spec.ts`

## Runtime switches (all default OFF)

| Variable | Safe default | Enable order (canary) |
|----------|--------------|------------------------|
| `AUTH_LOGIN_USE_ALIASES` | `false` | After T2a backfill + admin alias readiness |
| `DIRECTORY_PENDING_ACTIVATION_ENABLED` | `false` | After activate path validated |
| `DIRECTORY_DEPROVISION_ENABLED` | `false` | **Last**; after D7 UI + restore drill — **not recommended until canary GO** |

Suggested canary sequence (separate ops GO, one at a time with rollback):

1. Alias-only (`AUTH_LOGIN_USE_ALIASES`)  
2. Pending admission (`DIRECTORY_PENDING_ACTIVATION_ENABLED`)  
3. Deprovision writer (`DIRECTORY_DEPROVISION_ENABLED`)

See also: `docs/development/dingtalk-lifecycle-canary-separate-go-20260724.md`.

## Explicit non-enablement

Merging the above PRs **does not** authorize production traffic on pending create, alias cutover, or deprovision writers.
