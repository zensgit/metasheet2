# PLM Workbench Audit Followup Window Parity Verification

## Scope

验证 `audit team view set-default` collaboration followup 在 audit log route 只于完整 canonical 上下文匹配时保留，`windowMinutes` 变化时会被正确清掉。

## Focused Tests

命令：

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts
```

结果：

- `1` 文件 / `46` 测试通过

覆盖点：

- share followup 仍只跟随 `teamViewId`
- `set-default` followup 在 canonical audit log route 下继续保留
- `windowMinutes` 从默认值切到非默认值时，`set-default` followup 现在返回 `false`

## Full Validation

待本轮代码一起继续验证：

- `pnpm --filter @metasheet/web type-check`
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`

## Expected Runtime Outcome

- 用户在 `set-default` 后看到的 followup，只在默认时间窗口的对应日志上下文里继续存在
- 仅修改 audit 时间窗口后，followup 会被清掉，不再错误暗示“当前下方日志仍是那次默认切换的匹配结果”
