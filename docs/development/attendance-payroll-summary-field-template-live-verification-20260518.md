# 考勤薪资周期字段模板 live evidence 验证记录

Date: 2026-05-18

## Verification Matrix

| Check | Result |
| --- | --- |
| Staging tunnel | PASS: local `8082` reached staging `/api/health` |
| Staging image readiness | PASS: backend/web updated to `5ca91630307603eacbbb13ae8209721f1b4d5bf3` |
| Auth | PASS: regenerated short-lived staging admin JWT validated through `/api/auth/me` |
| Summary formula seed | PASS: `period_net_minutes`, `formulaScope=summary`, `formulaValid=true`, `reportVisible=true` |
| Hidden summary formula seed | PASS: `hidden_summary_live_metric`, `formulaScope=summary`, `reportVisible=false` |
| Payroll template create | PASS: template `2d1bc3c6-66d3-4a48-b0bd-db37c01cd9c9` created with `config.summaryFields` |
| Template readback | PASS: readback `config.summaryFields` exactly matched configured order |
| Payroll cycle create | PASS: cycle `4a3173ab-4065-42f3-bbeb-cb02b4807db2` created |
| Summary API field order | PASS: `period_net_minutes`, `work_duration`, `late_days` |
| Dropped fields | PASS: dropped record-scope formula, hidden summary formula, and unknown field |
| Summary formula value | PASS: `summary.formula_values.period_net_minutes` present |
| Summary CSV export order | PASS: CSV `metric` rows match `period_net_minutes`, `work_duration`, `late_days` |
| Artifact hygiene | PASS: token not stored in evidence; raw output saved under untracked `output/` |
| `git diff --check` | PASS |

## Live Evidence

Output directory:

```text
output/attendance-payroll-summary-field-template-live/2026-05-18T15-20-25-912Z
```

Evidence fingerprint:

```text
43848fd1a417d237f8ade266b17b278c1b41e872
```

Live response summary:

```json
{
  "templateId": "2d1bc3c6-66d3-4a48-b0bd-db37c01cd9c9",
  "cycleId": "4a3173ab-4065-42f3-bbeb-cb02b4807db2",
  "fieldCodes": [
    "period_net_minutes",
    "work_duration",
    "late_days"
  ],
  "dropped": [
    "net_anomaly_minutes",
    "hidden_summary_live_metric",
    "unknown_payroll_live_metric_20260518"
  ],
  "csvMetrics": [
    "period_net_minutes",
    "work_duration",
    "late_days"
  ]
}
```

## Notes

- The first attempted run correctly failed before the staging image update because the old staging backend only accepted `formulaScope=record`. This was expected once the container image was identified as `09a4bbb5e0f9bb1c7af66f0795c34b9526a4ba0b`, which predates the summary formula/template work.
- The live run uses disposable staging rows and does not modify production.
- Existing historical verification docs that said staging live evidence was pending are superseded by this file for the payroll summary field template live evidence item.
