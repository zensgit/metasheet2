# Data Factory issue #1542 closeout verification - 2026-05-17

Companion to
`docs/development/data-factory-issue1542-closeout-development-20260517.md`.

## Verification matrix

| Check | Evidence | Result |
| --- | --- | --- |
| Issue still open before closeout | `gh issue view 1542 --repo zensgit/metasheet2 --json number,title,state,updatedAt,url` returned `state=OPEN`. | PASS |
| Workbench is branded as Data Factory | `IntegrationWorkbenchView.vue` renders `Data Factory`, `数据工厂`, and the 4-step flow. | PASS |
| New-connection entry exists | Workbench renders `连接新系统`, `使用 K3 WISE 预设`, and `查看 SQL / 高级连接`. | PASS |
| Inventory overview exists | Workbench summary expands into configured systems, available adapters, and staging multitables. | PASS |
| SQL is advanced and guarded | SQL/high connections are hidden by default; when shown, missing executor state renders `SQLSERVER_EXECUTOR_MISSING`. | PASS |
| Staging source entry exists | Empty-source state offers `创建 staging 多维表作为来源`; staging cards offer `作为 Dry-run 来源`. | PASS |
| Correct multitable open path is documented in UI | Staging cards use `打开多维表（新建记录入口）` and warn not to hand-write `/grid` or `/spreadsheets/<id>`. | PASS |
| Project scope hint remains connected | Existing Workbench tests assert blank scope resolves to `default:integration-core` and plain project id can be normalized. | PASS |
| Postdeploy smoke covers the prior P0 blockers | Workflow evidence records `issue1542-staging-install`, `issue1542-staging-source-schema`, `issue1542-k3-material-schema`, and `issue1542-pipeline-save` passing. | PASS |

## Local code evidence

Targeted static inspection was run with:

```bash
rg -n "数据工厂|new connection|SQL|staging-project-id|创建 staging|使用 K3 WISE|打开多维表|use-staging-source|use-multitable-target|sqlChannelDisabledHint" \
  apps/web/src/views/IntegrationWorkbenchView.vue \
  apps/web/tests/IntegrationWorkbenchView.spec.ts \
  apps/web/tests/integrationWorkbench.spec.ts \
  docs/development/data-factory-issue1542-* \
  -S
```

Key source findings:

- `IntegrationWorkbenchView.vue` renders the Data Factory header, connection
  onboarding, inventory overview, staging cards, and SQL executor-missing hint.
- `IntegrationWorkbenchView.spec.ts` covers the Data Factory title/flow,
  inventory overview, hidden advanced SQL default, disabled SQL source option,
  staging CTA, `/multitable` open-link guidance, and Project ID scope
  normalization.
- The existing #1542 docs record the P1/P2 UI fixes, pipeline JSONB save
  repair, package inclusion, install-staging smoke, and postdeploy signoff.

## Existing postdeploy evidence

The merged postdeploy signoff document records GitHub Actions run
`25905364900`:

```text
Workflow: K3 WISE Postdeploy Smoke
Commit: f612a04c00b05baaf7aeb6016a16defc6c72f871
Conclusion: success
Input: issue1542_install_staging=true
Smoke: 17 pass / 0 skipped / 0 fail
Signoff: internalTrial=pass
```

Issue #1542 specific checks passed in that run:

- `issue1542-staging-install`
- `issue1542-system-readiness`
- `issue1542-staging-source-schema`
- `issue1542-k3-material-schema`
- `issue1542-pipeline-save`

The same verification explicitly states that SQL Server executor availability
is out of scope for this staging-as-source signoff.

## Commands for this closeout PR

Because this PR adds closeout documentation only, the relevant gates are doc and
frontend-regression focused:

```bash
git diff --check origin/main...HEAD
pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts tests/integrationWorkbench.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts --watch=false
rg -n "AdminPass|eyJ[A-Za-z0-9_-]+\\.|Bearer [A-Za-z0-9_-]{20,}|postgres://[^[:space:]]+:[^[:space:]@]+@" \
  docs/development/data-factory-issue1542-closeout-development-20260517.md \
  docs/development/data-factory-issue1542-closeout-verification-20260517.md \
  | rg -v "^docs/development/data-factory-issue1542-closeout-verification-20260517\\.md:[0-9]+:rg -n "
```

Expected secret-check behavior: no matches. The closeout docs contain no K3
authority code, token, password, JDBC URL, SQL connection string, or bearer
header.

## This PR verification result

| Command | Result |
| --- | --- |
| `git diff --check origin/main...HEAD` | PASS |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts tests/integrationWorkbench.spec.ts --watch=false` | PASS: 2 files / 27 tests |
| `pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts --watch=false` | PASS: 1 file / 41 tests |
| Secret-shape check above | PASS: no matches after filtering the command-line self-reference |

The temporary verification worktree reused the existing local `node_modules`
via symlinks to avoid mutating package metadata. The symlinks were removed after
the test run and are not part of the PR.

## Close criteria

Issue #1542 should be considered closed when:

1. this closeout PR is merged;
2. the issue is updated with the closeout summary;
3. any future SQL executor/read-list/relationship work is tracked under its own
   issue or PR, not as a continuation of the new-connection onboarding bug.

## Residual risk

The closeout relies on existing automated and postdeploy evidence rather than
rerunning a physical 142 deployment during this PR. That is acceptable because
this PR changes no runtime code. If a new deployment package is generated, run
the existing postdeploy smoke with `issue1542_install_staging=true` to refresh
the machine-level evidence.
