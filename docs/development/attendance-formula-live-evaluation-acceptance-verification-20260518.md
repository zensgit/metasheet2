# 考勤公式真实 Evaluation Acceptance 验证记录

## Summary

真实 staging formula evaluation acceptance 已通过。此轮不再是“无 formula 字段时 trivially ok”，而是在 staging catalog 中真实存在 `net_anomaly_minutes` 公式字段，并验证它进入 catalog、records、JSON export、CSV label header、CSV code header 以及跨视图 fingerprint。

## Commands

```bash
AUTH_SOURCE=AUTH_TOKEN_FILE \
AUTH_TOKEN_FILE=<staging-admin-jwt-file> \
API_BASE=http://localhost:8082 \
ORG_ID=default \
USER_ID=8b35cbe1-9fd6-4650-9d16-42b2c4d028d1 \
FROM_DATE=2026-05-15 \
TO_DATE=2026-05-17 \
EXPECT_FORMULA_CODE=net_anomaly_minutes \
CONFIRM_SYNC=1 \
OUTPUT_DIR=output/attendance-report-fields-live-acceptance/2026-05-18-staging-formula-eval-pass \
node scripts/ops/attendance-report-fields-live-acceptance.mjs
```

## Result

```text
PASS
Total checks: 48
Failing checks: none
```

Key checks:

```text
catalog.formula-field.expected: PASS
catalog.formula-fields.valid: PASS
records.report-fields.formula-expected: PASS
export.report-fields.formula-expected: PASS
records-export.report-field-codes-match: PASS
catalog-records.report-field-fingerprint-match: PASS
records-export.report-field-fingerprint-match: PASS
export.csv.report-field-fingerprint-match: PASS
export.csv-code.report-field-fingerprint-match: PASS
```

## Fingerprint Evidence

All five field-config fingerprints matched:

```text
catalog:  684233f9c36205f9ea59248b29f9d050f88af0cd
records:  684233f9c36205f9ea59248b29f9d050f88af0cd
export:   684233f9c36205f9ea59248b29f9d050f88af0cd
csv:      684233f9c36205f9ea59248b29f9d050f88af0cd
csv-code: 684233f9c36205f9ea59248b29f9d050f88af0cd
```

Counts:

```text
catalogFieldCount: 47
recordsFieldCount: 47
exportFieldCount: 47
csvFieldCount: 47
formulaFieldCodes: net_anomaly_minutes
recordsTotal: 3
exportTotal: 3
```

## Evaluation Evidence

The formula was:

```text
={late_duration}+{early_leave_duration}
```

Staging returned the expected computed values:

| workDate | late_duration | early_leave_duration | net_anomaly_minutes |
| --- | ---: | ---: | ---: |
| 2026-05-17 | 0 | 0 | 0 |
| 2026-05-16 | 0 | 30 | 30 |
| 2026-05-15 | 12 | 0 | 12 |

The formula field descriptor in JSON export:

```text
code: net_anomaly_minutes
name: 异常净时长
source: custom
formulaEnabled: true
formulaValid: true
formulaReferences: early_leave_duration, late_duration
exportKey: net_anomaly_minutes
```

CSV label header includes `异常净时长`; CSV code header includes `net_anomaly_minutes`.

## Security / Hygiene

- JWT value was not printed or committed.
- Bearer token literal was not printed or committed.
- Local evidence under `output/` remains untracked.
- This document intentionally redacts the local token file path.
- No direct `meta_*` SQL was used.
- No `attendance_*` fact rows were changed.

## Follow-up

The original formula evaluation acceptance gap is closed. Remaining formula work should move to separate P2 items such as custom non-formula field sources v2 or period aggregate formulas.
