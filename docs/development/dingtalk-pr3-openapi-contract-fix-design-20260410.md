## Summary

`PR #724` 的 `contracts (openapi)` 失败不是运行时代码问题，而是 `packages/openapi/src/paths/attendance.yml` 已经包含 `partialErrors` 字段，但 `packages/openapi/dist/*` 生成产物没有同步提交。

## Root Cause

- `attendance.yml` 已声明 `partialErrors`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/openapi.yaml`
- `packages/openapi/dist/combined.openapi.yml`

这 3 个生成文件仍停留在旧状态。

CI 在 `Attendance Gate Contract Matrix / contracts (openapi)` 中执行：

```bash
./scripts/ops/attendance-run-gate-contract-case.sh openapi
```

脚本内部会先重建 OpenAPI，再检查上述 3 个 dist 文件是否有 `git diff`。因为仓库中的 dist 未更新，所以 CI 报 `openapi dist drift detected`。

## Chosen Fix

- 不改运行时代码
- 不改 OpenAPI 源定义
- 只重新生成并提交 `packages/openapi/dist/*`

这样修复范围最小，也和 CI gate 的目的完全一致。

## Non-Goals

- 不调整 attendance import schema
- 不修改 contract gate 脚本
- 不扩展 `PR #724` 功能范围
