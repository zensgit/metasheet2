# 考勤公式真实 Evaluation Acceptance TODO

## Summary

`#1617` 已经把内联公式编辑器合入 main：管理员可以创建/编辑 custom formula 字段，后端通过 `PATCH /api/attendance/report-fields/:code/formula` 将配置写入插件私有多维表 catalog，保存前复用公式 validator。

下一步最有价值的收口不是继续扩功能，而是在真实 staging 上 seed 一个 custom formula 字段并重跑 live acceptance，证明公式字段不只是 catalog 层存在，而是能进入 records、JSON export、CSV label/code header，并参与 fingerprint/evaluation。

## Why This Before More Features

- 之前真实 live acceptance 中 staging catalog 暂无公式字段，所以 `EXPECT_FORMULA_CODE` 相关检查属于“无公式字段时为空通过”。
- 现在已有 #1617 的 UI/API 写入能力，应该先用真实环境证明 formula evaluation 链路：catalog -> records -> export -> CSV -> fingerprint。
- “公式字段依赖图与循环检测”在 v1 下不应优先做：当前 validator 仍拒绝 formula-to-formula，custom 非公式字段也不作为公式源，因此没有真正的循环图可运行。依赖图应随 formula-to-formula 或 custom source v2 一起做。

## Required Inputs

- staging API base，例如 `http://localhost:8082` 或外部 staging URL。
- 短期 `attendance:admin` JWT 文件路径，不在聊天明文贴 token。
- 一个有考勤记录的样本用户：
  - `orgId`
  - `userId`
  - `from`
  - `to`
- staging 多维表写入允许范围：只允许写插件私有 `attendance_report_field_catalog` 中的一个 custom formula 字段，不写 `attendance_*` 事实表，不直接写 `meta_*`。

## Proposed Formula Field

推荐字段：

```text
code: net_anomaly_minutes
name: 异常净时长
category: anomaly
unit: minutes
formulaEnabled: true
formulaExpression: ={late_duration}+{early_leave_duration}
formulaScope: record
formulaOutputType: duration_minutes
```

选择该表达式的原因：

- 引用现有系统字段，不依赖动态 subtype 或 raw alias。
- 单记录级、确定性、易核验。
- 不触发 v1 禁止的 formula-to-formula。

## Execution Plan

1. 通过 #1617 新增接口 seed formula 字段：

```bash
AUTH_TOKEN="$(cat /tmp/<staging-admin-jwt>.jwt)"
API_BASE="http://localhost:8082"

curl -sS -X PATCH "$API_BASE/api/attendance/report-fields/net_anomaly_minutes/formula?orgId=<orgId>" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "name":"异常净时长",
    "category":"anomaly",
    "unit":"minutes",
    "enabled":true,
    "reportVisible":true,
    "sortOrder":4500,
    "dingtalkFieldName":"异常净时长",
    "description":"迟到与早退分钟数之和。",
    "internalKey":"formula.net_anomaly_minutes",
    "formulaEnabled":true,
    "formulaExpression":"={late_duration}+{early_leave_duration}",
    "formulaScope":"record",
    "formulaOutputType":"duration_minutes"
  }'
```

2. 确认 `GET /api/attendance/report-fields` 返回：

- `net_anomaly_minutes`
- `formulaEnabled: true`
- `formulaValid: true`
- `formulaReferences: ["early_leave_duration", "late_duration"]`

3. 跑 live acceptance：

```bash
AUTH_TOKEN_FILE="/tmp/<staging-admin-jwt>.jwt" \
API_BASE="http://localhost:8082" \
ORG_ID="<orgId>" \
USER_ID="<userId>" \
FROM_DATE="<from>" \
TO_DATE="<to>" \
EXPECT_FORMULA_CODE="net_anomaly_minutes" \
pnpm run verify:attendance-report-fields:live
```

4. 检查输出 evidence：

- catalog 包含公式字段。
- records/report values 包含公式字段。
- JSON export 包含公式字段。
- CSV label header 包含公式字段 label。
- CSV code header 包含 `net_anomaly_minutes`。
- field fingerprint 在 catalog/records/export/CSV label/CSV code 间一致。

## Acceptance Criteria

- live acceptance PASS，且不是 “no formula codes expected and none present” 的 trivially ok 路径。
- evidence 脱敏：不包含 JWT、Bearer token、用户家目录绝对路径。
- 不新增 migration。
- 不直接写 `meta_*`。
- 不改 `attendance_*` 事实源。

## Follow-up After PASS

- 在 PR 或 closeout MD 中追加真实 formula evaluation evidence。
- 再评估下一条功能：
  - Custom 非公式字段作为公式源 v2。
  - 周期汇总级公式。
  - 公式依赖图与循环检测（应跟 formula-to-formula 或 custom source v2 一起做）。
