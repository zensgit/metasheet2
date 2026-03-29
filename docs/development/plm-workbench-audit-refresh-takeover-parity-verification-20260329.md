# PLM Workbench Audit Refresh Takeover Parity Verification

## Scope

验证 audit team-view refresh 在 route 未变化且 team view 仍有效时，不再误触 route-takeover cleanup；同时 shared-entry takeover 和 default auto-apply refresh 仍保持原有 cleanup 语义。

## Focused Tests

命令：

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts tests/plmAuditTeamViewRouteState.spec.ts
```

结果：

- `2` 文件 / `45` 测试通过

覆盖点：

- CAD team-view share URL 现在会在存在 `fileId` 时输出 `autoload=true`
- unchanged valid requested audit team-view route refresh 不再要求 cleanup
- shared-entry refresh 仍会 cleanup
- default auto-apply refresh 仍会 cleanup

## Full Validation

待本轮代码一起继续验证：

- `pnpm --filter @metasheet/web type-check`
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`

## Expected Runtime Outcome

- 用户点击 audit team-view refresh 时，如果当前 route 仍是有效 canonical team view，正在进行中的 collaboration/followup 不会被误清
- shared-entry takeover 和真正的 route pivot 仍会继续清掉旧 takeover 状态
