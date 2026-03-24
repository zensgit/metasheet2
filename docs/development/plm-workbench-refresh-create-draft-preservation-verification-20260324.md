# PLM Workbench Refresh Create Draft Preservation Verification

Date: 2026-03-24

## Parallel review

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
/Users/huazhou/.local/bin/claude -p "Inspect /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts after commit 928ad1494. Find the next concrete user-visible stale-state or permissions mismatch in refresh, selection, name/owner drafts, or lifecycle handlers. Cite exact file:line evidence and the smallest safe fix. Ignore speculative backend-only concerns."
```

Result:

- `Claude Code` 明确指出上一刀需要补一个 `teamViewKey.value` guard
- 它给出的最小修法就是：只有在存在 active selection 时，refresh 才清 `teamViewName`

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

Result:

- `1` file passed
- `29` tests passed

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
- `340` tests passed

## Assertions locked by this round

- create-mode `teamViewName` 草稿不会再被普通 refresh 误清
- refresh 只有在真实 deselect 时才会清空 name draft
- `missing-view` cleanup 与 `non-applyable-view` cleanup 仍然保留
