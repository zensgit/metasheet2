## Federation Status Recut Development

Date: 2026-03-19

### Context

PR `#459` (`feat(federation): add integration status visibility`) was no longer mergeable on current `main`. GitHub reported `DIRTY`, and local git showed there was no usable merge base with current `main`, so a normal branch update was not reliable.

### Recut Strategy

- Started from current `origin/main`
- Reapplied only the intended feature delta from original PR head `239eddaa6066cebffba0696c44be16c4e18487eb`
- Avoided full-file rollback of current `main` files
- Added the original federation contract fixtures and unit test coverage

### Delivered Scope

- Frontend integration status visibility in `apps/web/src/views/PluginManagerView.vue`
- Adapter runtime status support in `packages/core-backend/src/di/container.ts`
- Federation integration status route and Athena timestamp compatibility in `packages/core-backend/src/routes/federation.ts`
- Contract fixtures and unit coverage:
  - `packages/core-backend/tests/fixtures/federation/contracts.ts`
  - `packages/core-backend/tests/unit/federation.contract.test.ts`

### Note

The original PR `#459` should be treated as superseded once the recut PR is created, because the recut branch is the one aligned with current `main`.
