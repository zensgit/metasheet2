# PLM Workbench Rename Actionability Parity Verification

## Verified Change

已验证 `team views` 与 `team presets` 的 `rename` handler 现在会先检查 target actionability，再检查名称输入：

- readonly workbench team view：
  - 不再先报 `请输入工作台团队视角名称。`
  - 直接返回 `仅创建者可重命名工作台团队视角。`
- readonly BOM team preset：
  - 不再先报 `请输入BOM团队预设名称。`
  - 直接返回 `仅创建者可重命名BOM团队预设。`

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts tests/usePlmTeamFilterPresets.spec.ts
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

```text
tests/usePlmTeamViews.spec.ts          47 tests passed
tests/usePlmTeamFilterPresets.spec.ts  41 tests passed
total                                  88 tests passed
```

`pnpm --filter @metasheet/web type-check` 通过。

全量前端回归结果：

```text
62 files passed
497 tests passed
```

## Focused Regressions Added

- readonly workbench team view rename denies before name-input validation
- readonly BOM team preset rename denies before name-input validation

## Outcome

这次调整把 `rename` 和上一轮修过的 `transfer` 拉到了同一套 handler contract：先给真实 actionability denial，再给输入级提示，没有引入其它前端回归。
