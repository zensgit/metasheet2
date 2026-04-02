# PLM Workbench Refresh Name Draft Cleanup Verification

Date: 2026-03-24

## Parallel review

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
/Users/huazhou/.local/bin/claude -p "Inspect /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts after commit 928ad1494. Find the next concrete user-visible stale-state or permissions mismatch in refresh, selection, name/owner drafts, or lifecycle handlers. Cite exact file:line evidence and the smallest safe fix. Ignore speculative backend-only concerns."
```

Result:

- `Claude Code` 明确确认 `refreshTeamViews()` 在清空 `teamViewKey` 时漏掉了 `teamViewName`
- 它给出的最小修法就是在 refresh 的两条 deselect 分支都同步清空 name draft

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

Result:

- Passed

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

- Passed

## Assertions locked by this round

- refresh 移除 selected team view 时，不再保留 orphaned `teamViewName`
- refresh 发现 selected view 已经不可 apply 时，不再把旧 name draft 带到 default takeover 后
- refresh cleanup 现在和 delete/archive/batch lifecycle 的 name-draft contract 对齐
