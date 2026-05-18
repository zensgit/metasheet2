# 考勤公式真实 Evaluation Acceptance 验证记录

## Summary

本轮只验证文档计划完整性和仓库 hygiene。真实 staging evaluation 尚未执行，因为缺少新的 staging admin JWT、样本用户和日期范围。

## Verification Matrix

| Layer | Command | Result |
| --- | --- | --- |
| TODO presence | `test -f docs/development/attendance-formula-live-evaluation-acceptance-todo-20260517.md` | PASS |
| Development MD presence | `test -f docs/development/attendance-formula-live-evaluation-acceptance-development-20260517.md` | PASS |
| Verification MD presence | `test -f docs/development/attendance-formula-live-evaluation-acceptance-verification-20260517.md` | PASS |
| Diff hygiene | `git diff --check` | PASS |

## Real Staging Status

未运行。

原因：

- 当前没有新的 staging admin JWT 文件路径。
- 当前没有明确样本 `orgId/userId/from/to`。
- 不在缺凭据/缺样本时伪造 formula evaluation 通过。

## Expected Future Evidence

拿到输入后，应追加以下证据：

- seed `net_anomaly_minutes` 的 API 响应脱敏摘要。
- `GET /api/attendance/report-fields` 中 `formulaValid=true` 和 references。
- `EXPECT_FORMULA_CODE=net_anomaly_minutes` live acceptance PASS。
- catalog/records/export/CSV label/CSV code 的 field fingerprint 一致。
- evidence 文件不包含 JWT、Bearer token、用户家目录绝对路径。
