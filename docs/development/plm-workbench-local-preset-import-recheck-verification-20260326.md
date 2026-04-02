# PLM Workbench Local Preset Import Recheck Verification

## Scope

验证 same-key local preset import/update 后，watcher 依赖会跟着 `field/value` 变化，route owner 能重新触发 stale 判定。

## Focused Verification

命令：

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmLocalFilterPresetRouteIdentity.spec.ts
```

结果：

- `1` 个文件
- `5` 个测试通过

新增覆盖点：

- `buildPlmLocalFilterPresetRouteOwnerWatchKey(...)` 在同 key、不同 `field/value` 下会返回不同值
- 这保证导入原地更新 preset state 时，watcher 会重新运行

## Type-check

命令：

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

结果：

- 通过

## Full Verification

命令：

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

预期：

- watcher 依赖的 snapshot 化不会回归现有 local/team preset ownership 逻辑
