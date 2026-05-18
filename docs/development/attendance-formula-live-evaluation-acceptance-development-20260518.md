# 考勤公式真实 Evaluation Acceptance 开发记录

## Summary

本轮目标是把 `#1617` 合入后的考勤公式字段写入能力放到真实 staging 链路中验证：通过管理员接口 seed 一个 custom formula 字段，再让它进入考勤 records、JSON export、CSV label header、CSV code header 和字段 fingerprint。

最终 staging 验证字段：

```text
code: net_anomaly_minutes
name: 异常净时长
formulaExpression: ={late_duration}+{early_leave_duration}
formulaOutputType: duration_minutes
```

## Environment

- API base: `http://localhost:8082`
- Org: `default`
- Sample user: `8b35cbe1-9fd6-4650-9d16-42b2c4d028d1`
- Date range: `2026-05-15..2026-05-17`
- SSH tunnel: local `8082` to staging `8082`
- Token handling: short-lived admin JWT was read from a local file and was not printed.

## Staging Image Alignment

Initial probe showed staging `8082` was still running image tag `e537a5cdb185b87baa5b36ae114431cb379d8251`, which predated `#1617` and therefore did not expose:

```text
PATCH /api/attendance/report-fields/:code/formula
```

The live formula seed could not be performed on that image. Staging was upgraded to the already available `09a4bbb5e0f9bb1c7af66f0795c34b9526a4ba0b` backend/web images, which include `#1617`.

Operational notes:

- Backed up staging `.env` before changing `IMAGE_TAG`.
- The first compose run hit a historical postgres/redis container-name conflict and did not recreate backend/web.
- Retried with `docker compose ... up -d --no-deps backend web`, which recreated only staging backend/web.
- No migration was run.
- Staging Postgres/Redis containers and volumes were not recreated.

## Seed Action

After staging was on the `09a4bbb5...` image, the formula save endpoint was available. The custom formula field was persisted through the attendance plugin API:

```text
PATCH /api/attendance/report-fields/net_anomaly_minutes/formula?orgId=default
```

Final saved field state:

```text
code: net_anomaly_minutes
name: 异常净时长
category: anomaly
categoryLabel: 异常统计字段
unit: minutes
sortOrder: 4500
source: custom
formulaEnabled: true
formulaExpression: ={late_duration}+{early_leave_duration}
formulaScope: record
formulaOutputType: duration_minutes
formulaValid: true
formulaReferences: early_leave_duration, late_duration
```

## Boundary Check

- Did not migrate `attendance_*`.
- Did not write `attendance_*` facts.
- Did not write `meta_*` tables directly.
- Formula config was written through the plugin/API layer into the private `attendance_report_field_catalog`.
- Output evidence under `output/` is local and untracked.
