# PLM Workbench Local Preset Destructive Action Ownership Verification

## Scope

验证本地 preset owner 在 destructive team preset action 下不会被错误清掉，同时 restore-style takeover 仍保持原语义。

## Focused Checks

### 1. Ownership helper contract

文件：

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmLocalPresetOwnership.spec.ts`

新增断言：

- `archive` 不清本地 owner
- `batch-delete` 不清本地 owner
- `restore` 仍会清本地 owner

### 2. Team preset regression coverage

文件：

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamFilterPresets.spec.ts`

目的：

- 确认本轮 wrapper 调整没有破坏 team preset 的既有 apply / archive / restore / batch 行为合同。

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmLocalPresetOwnership.spec.ts tests/usePlmTeamFilterPresets.spec.ts
```

结果：

- `2` 个文件
- `40` 个测试通过

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

结果：

- 通过

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

结果：

- `56` 个文件
- `420` 个测试通过

## Conclusion

本地 preset owner 现在只会在真实 takeover 当前过滤状态的团队预设动作后被消费；destructive action 不再错误剥离 route owner。
