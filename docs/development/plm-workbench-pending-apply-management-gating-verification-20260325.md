# PLM Workbench Pending-Apply Management Gating Verification

Date: 2026-03-25

## Parallel review

并行 explorer 指出了这条真实错位：

- selector 改的是 `teamViewKey`
- `Apply` 才会同步 canonical `requestedViewId`
- generic 管理动作却直接跟着 selector 瞬时 target 走

也就是说，页面仍停在已应用视图 `A` 时，管理动作已经可能改到 `B`。

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

Result:

- `1` file passed
- `34` tests passed

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
- `345` tests passed

## Assertions locked by this round

- canonical `requestedViewId` 还指向已应用 target 时，selector 漂移不会再提前放开 generic 管理动作
- `share / rename / delete` 这类 handler 在 pending-apply drift 期间会显式拒绝执行
- `Apply` 和 `Save to team` 的既有语义不变
