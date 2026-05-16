# Data Factory issue #651 C1/C3 UI fix - verification - 2026-05-16

## Expected behavior

| Check | Expected |
| --- | --- |
| C1 staging entry | Workbench staging cards show either `打开多维表（新建记录入口）` or `生成打开链接`. Operators do not need to guess `/grid` or `/spreadsheets/<objectId>`. |
| C1 true route | The generated route remains `/multitable/<sheetId>/<viewId>?baseId=...`; after opening it, `+ New Record` is the toolbar path that exercises required-field toast wiring from #1590. |
| C3 Workbench | Plain Project ID shows warning + normalize button and normalizes to `:integration-core`. |
| C3 K3 setup | Same warning + normalize behavior is available on `/integrations/k3-wise`. |
| Package gate | Package verify fails if the web bundle does not include the C1 entry copy or K3 setup normalize test id. |

## Local test plan

Commands run in `/tmp/ms2-issue651-c1-c3-fix`:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/IntegrationWorkbenchView.spec.ts \
  tests/IntegrationK3WiseSetupView.spec.ts \
  tests/integrationWorkbench.spec.ts \
  tests/k3WiseSetup.spec.ts \
  --watch=false

pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
bash -n scripts/ops/multitable-onprem-package-verify.sh
git diff --check origin/main...HEAD
```

## Local results

| Command | Result |
| --- | --- |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts tests/IntegrationK3WiseSetupView.spec.ts tests/integrationWorkbench.spec.ts tests/k3WiseSetup.spec.ts --watch=false` | 4 files / 72 tests PASS |
| `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | PASS |
| `pnpm --filter @metasheet/web build` | PASS; Vite chunk-size warnings only |
| `pnpm --filter @metasheet/web exec eslint src/views/IntegrationK3WiseSetupView.vue src/views/IntegrationWorkbenchView.vue tests/IntegrationK3WiseSetupView.spec.ts tests/IntegrationWorkbenchView.spec.ts` | 0 errors; 20 existing router-link test-stub warnings |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| `git diff --check origin/main...HEAD` | PASS |
| `rg "新建记录入口|normalize-k3-setup-project-id|不要手写 /grid|打开多维表（新建记录入口）" apps/web/dist` | PASS after web build |

Browser note: a local Vite page was opened, but without a local backend the app
redirected to login and proxied auth calls to an unavailable backend. The
browser pass was therefore limited to confirming the auth guard behavior; the
actual UI behavior is covered by focused Vue tests plus the production build
string check.

## On-prem retest notes

After packaging from a main that includes this PR:

1. Run package verify first. It should pass the new `新建记录入口` and
   `normalize-k3-setup-project-id` assertions.
2. Open `/integrations/workbench`.
3. If staging cards do not show open links, click `生成打开链接`.
4. Open `打开多维表（新建记录入口）`.
5. Click `+ New Record` in the multitable toolbar and confirm the required
   field toast appears.
6. Test Project ID warning/normalize in both `/integrations/workbench` and
   `/integrations/k3-wise`.

## Deployment impact

No migration, backend route, plugin runtime, or K3 API behavior changes.
Rollback is a frontend/docs/ops revert.
