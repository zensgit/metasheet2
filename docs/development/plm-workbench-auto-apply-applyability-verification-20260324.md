# PLM Workbench Auto-Apply Applyability Verification

Date: 2026-03-24

## Parallel review

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
/Users/huazhou/.local/bin/claude -p "Inspect apps/web/src/views/plm/usePlmTeamViews.ts in the current repository. Does maybeAutoApplyDefault still auto-apply requested/default team views that fail permissions.canApply? Cite exact line numbers and propose the smallest correct fix. Keep it concise."
```

Result:

- `Claude Code` 明确指出 `maybeAutoApplyDefault(...)` 的 requested/default 两条分支仍绕过 `canApply`
- 它建议把两条查找条件都对齐到 `canApplyPlmCollaborativeEntry(...)`

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

- refresh/requested/default auto-apply 不再绕过 `permissions.canApply`
- requested team view 不可 apply 时，不会再被自动写成当前 active view
- default team view 不可 apply 时，不会再被自动应用
- 自动应用路径和显式 `Apply` 路径现在共享同一套 applyability 合同
