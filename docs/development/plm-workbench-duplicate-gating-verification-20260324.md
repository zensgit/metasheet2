# PLM Workbench Duplicate Gating Verification

Date: 2026-03-24

## Claude Code status

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
/Users/huazhou/.local/bin/claude auth status
/Users/huazhou/.local/bin/claude -p "Inspect apps/web/src/views/plm/usePlmTeamViews.ts for handler gating gaps around duplicate/share/apply/manage."
```

Result:

- `Claude Code` 仍是登录态
- 本轮进一步 CLI 探测时命中了当日额度上限，没有返回新的可直接采用结论
- 这次 duplicate handler 漏口因此基于本地代码核对完成

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

Result:

- `1` file passed
- `30` tests passed

## Type-check

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Result:

- Passed

## Full PLM frontend regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `48` files passed
- `341` tests passed

## Assertions locked by this round

- `duplicateTeamView()` 不会再绕过 `permissions.canDuplicate = false`
- duplicate handler 现在和 UI 按钮 disabled 合同一致
- duplicate gating 修复不影响已有 duplicate-success route identity 行为
