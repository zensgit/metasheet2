# PLM Workbench Team Preset Readonly Management Parity Verification

## Verified Change

已验证 readonly `team preset` 的 management handler 现在返回 owner-specific denial：

- `delete` -> `仅创建者可删除...`
- `archive` -> `仅创建者可归档...`
- `set default` -> `仅创建者可设置...`
- `clear default` -> `仅创建者可取消...`
- `restore` -> `仅创建者可恢复...`

并且没有破坏已有的 `local preset owner` drift 语义：

- 当本地 owner 仍持有当前过滤状态时，manageable archived preset 仍可继续 `restore`

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

```text
tests/usePlmTeamFilterPresets.spec.ts  42 tests passed
```

`pnpm --filter @metasheet/web type-check` 通过。

全量前端回归结果：

```text
62 files passed
498 tests passed
```

## Focused Coverage

- existing local-owner-drift restore case still passes
- readonly management case now checks all five owner-specific denial messages

## Outcome

这次调整把 `team preset` readonly management 的反馈粒度拉齐到了 `team view`，并保住了已有的 restore 特例，没有引入新的前端回归。
