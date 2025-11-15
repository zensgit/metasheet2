# PR #155 Reviewer Checklist

- Metrics
  - [ ] `/metrics/prom` includes: config_reload_total, config_sampling_rate
  - [ ] `/metrics/prom` includes: view_data_latency_seconds, view_data_requests_total
  - [ ] No duplicate/renamed conflicts with existing Phase 3 metrics

- Admin Endpoints
  - [ ] GET /api/admin/config returns sanitized config (secrets masked)
  - [ ] POST /api/admin/config/reload increments `config_reload_total{result}`
  - [ ] GET /api/admin/db/health returns `{ ok:true, healthy:true, tables: {...} }`
  - [ ] All admin endpoints require Authorization and enforce RBAC

- Index Wiring
  - [ ] `adminRouter()` and `observabilityRouter()` mounted once
  - [ ] `/api/plugins?verbose=1` uses `sanitizeConfig(getConfig())`
  - [ ] Flags read via ConfigService (kanbanAuthRequired, ws.redisEnabled)

- Views & RBAC
  - [ ] `POST /api/views` requires `tableId` and checks `canWriteTable`
  - [ ] `GET/PUT /api/views/:id/config` checks table-level RBAC
  - [ ] `GET /api/views/:id/data` checks RBAC and returns 404/403 appropriately
  - [ ] View state persists to `view_states.state` (JSONB) with upsert
  - [ ] Gallery/Form create aligns to `views` with `tableId`

- Migrations/Schema
  - [ ] Env has `view_states.state` column (or migration plan exists)

- Security & Config
  - [ ] No `process.env` reads in routes/middleware except via ConfigService
  - [ ] JWT secret read via ConfigService

- Docs & Scripts
  - [ ] CHANGELOG v2.1.3 entry present and accurate
  - [ ] Token generator available: `pnpm -F @metasheet/core-backend gen:token`
  - [ ] Pre-merge check works: `pnpm -F @metasheet/core-backend pre-merge:check`
