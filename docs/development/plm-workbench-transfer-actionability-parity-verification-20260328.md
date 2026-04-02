# PLM Workbench Transfer Actionability Parity Verification

## Verified Change

已验证 `team view` 与 `team preset` 的 transfer handler 现在会先检查 actionability，再检查 owner input：

- 只读 target 不再先提示 `请输入目标用户 ID`
- 会直接返回真实 denial：
  - `仅创建者可转移工作台团队视角。`
  - `仅创建者可转移BOM团队预设。`

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts tests/usePlmTeamFilterPresets.spec.ts
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

```text
tests/usePlmTeamViews.spec.ts          46 tests passed
tests/usePlmTeamFilterPresets.spec.ts  40 tests passed
total                                  86 tests passed
```

`pnpm --filter @metasheet/web type-check` 通过。

全量前端回归结果：

```text
62 files passed
495 tests passed
```

## Focused Regressions Added

- readonly `workbench` team view transfer now denies before owner input validation
- readonly `BOM` team preset transfer now denies before owner input validation

这次顺序调整没有带出额外的 transfer / permission 回归。
