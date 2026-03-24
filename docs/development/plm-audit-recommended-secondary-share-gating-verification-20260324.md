# PLM Audit Recommended Secondary Share Gating Verification

Date: 2026-03-24

## Parallel review

Commands:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
/Users/huazhou/.local/bin/claude -p "In /Users/huazhou/Downloads/Github/metasheet2-plm-workbench after commit fcd145a98, inspect the recommended team-view secondary action path. Is there a real contract bug where recommendation cards still offer 'copy-link' even when the underlying team view would fail generic canShare gating? Cite exact file:line evidence and state whether the current handler bypasses canShare."
```

```bash
parallel explorer review via Codex subagent
```

Result:

- `Claude Code` 明确确认 recommendation card 的 `copy-link` 既没在 builder 中看 `canShare`，handler 也会直接绕过 `canShare`
- 并行 explorer 给出了同一条修复方向：把 `secondaryActionDisabled` 收进 recommendation contract

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCatalog.spec.ts tests/usePlmCollaborativePermissions.spec.ts
```

Result:

- `2` files passed
- `12` tests passed

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
- `329` tests passed

Note:

- 全量 Vitest 打印过 `WebSocket server error: Port is already in use`
- 测试进程正常退出，结果全绿

## Assertions locked by this round

- 推荐卡 secondary `copy-link` 现在会对齐 generic `canShare` 合同。
- 推荐卡 secondary 按钮不再只看 loading；不可分享时会直接 disabled。
- handler 侧也补了 defensive `canShare / canSetDefault` gate，避免未来新入口回归。
- recommendation model 现在同时表达 primary 和 secondary 两条 actionability 合同。
