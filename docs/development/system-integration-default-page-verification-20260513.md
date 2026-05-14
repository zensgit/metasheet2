# System Integration Default Page Verification - 2026-05-13

## Local Checks

```bash
pnpm --filter @metasheet/web exec vitest run tests/platform-shell-nav.spec.ts tests/IntegrationWorkbenchView.spec.ts tests/IntegrationK3WiseSetupView.spec.ts tests/k3WiseSetup.spec.ts --watch=false
```

Result: PASS, 4 files / 37 tests.

```bash
pnpm --filter @metasheet/web build
```

Result: PASS (`vue-tsc -b` + Vite build). Existing large-chunk warning only.

```bash
git diff --check
```

Result: PASS.

## Install Side Effects

The temporary worktree did not have a usable workspace bin at first, so `pnpm install --frozen-lockfile` was run before tests. It marked several tracked plugin/tool `node_modules` symlinks as modified; those install side effects were restored before staging. Final tracked diff contains only frontend source, frontend tests, and these docs.

## Coverage Matrix

| Area | Expected | Evidence |
| --- | --- | --- |
| Platform nav | `系统对接` links to `/integrations/workbench` | `platform-shell-nav.spec.ts` |
| Generic workbench | Header says `系统对接` and describes the default generic system integration page | `IntegrationWorkbenchView.spec.ts` |
| K3 preset route | K3 page stays protected by `integration:write` and is titled `K3 WISE 预设向导` | `k3WiseSetup.spec.ts` |
| K3 preset bridge | K3 page still links back to `/integrations/workbench` | `IntegrationK3WiseSetupView.spec.ts` |
| Runtime behavior | No backend or adapter behavior changed | frontend-only diff review |

## Deployment Impact

Frontend-only copy and route-target change. Existing deep links keep working:

- `/integrations/workbench` is now the default nav entry.
- `/integrations/k3-wise` remains available for K3 WISE setup.
