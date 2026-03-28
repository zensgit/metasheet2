# PLM Workbench Team Preset Share Parity Verification

## Verified Change

已验证 `team preset share` 现在会区分两类 denial：

- readonly target：
  - `仅创建者可分享BOM团队预设。`
- manageable but explicitly unshareable target：
  - `当前BOM团队预设不可分享。`

同时保留了原有的：

- archived restore-first 分支
- share success path
- pending-management blocker

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

```text
tests/usePlmTeamFilterPresets.spec.ts  43 tests passed
```

`pnpm --filter @metasheet/web type-check` 通过。

全量前端回归结果：

```text
62 files passed
499 tests passed
```

## Focused Coverage

- readonly share denial returns owner-specific message
- explicit `permissions.canShare = false` still returns generic action denial

## Outcome

`team preset share` 的反馈粒度现在和 `team view share` 一致，readonly 与 explicit share denial 不再混成同一条文案，同时没有引入新的前端回归。
