# PLM Workbench Refresh Selection And Management Permissions Verification

Date: 2026-03-24

## Parallel review

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
/Users/huazhou/.local/bin/claude -p "Inspect apps/web/src/views/plm/usePlmTeamViews.ts after commit 90bb1d9a8. Look for remaining real canApply/actionability mismatches around applyView(...) call sites (save/duplicate/rename/transfer/restore/default refresh). Identify only concrete user-visible bugs, cite exact lines, and propose the smallest correct fix."
```

Result:

- `Claude Code` 明确指出 refresh 还会保留 stale non-applyable selection
- `Claude Code` 也指出 `restore / rename / set-default / clear-default` 这些 handler 仍在看原始 `view.canManage`

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

Result:

- `1` file passed
- `26` tests passed

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
- `337` tests passed

## Assertions locked by this round

- refresh 不会再把 stale non-applyable `teamViewKey` 留在本地，阻断 default 接管
- refresh 后 surviving target 一旦失去 applyability，会先清 key，再走现有 default auto-apply
- `permissions.canManage` override legacy `canManage` 时，管理按钮和 handler 语义一致
- `rename / set-default / clear-default / restore` 不再出现“按钮可点但 handler 仍提示仅创建者可操作”的错位
