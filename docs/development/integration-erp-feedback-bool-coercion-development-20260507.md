# ERP Feedback Boolean Coercion Development

## Context

`erp-feedback.cjs` controls whether target ERP writeback outcomes are reflected
back into staging multitable rows. Operators can set two booleans in pipeline
configuration:

- `erpFeedback.enabled`
- `erpFeedback.failOnError`

Before this change, both options only respected literal JavaScript booleans:

- `enabled === false`
- `failOnError === true`

That left spreadsheet/manual JSON values such as `"false"`, `"否"`, `0`,
`"true"`, `"是"`, or `1` interpreted in the wrong direction.

## Change

Added a local boolean coercion helper for ERP feedback options. It accepts the
same operator-friendly values used elsewhere in the integration pipeline:

- true-like: `true`, `1`, `yes`, `y`, `on`, `是`, `启用`, `开启`
- false-like: `false`, `0`, `no`, `n`, `off`, `否`, `禁用`, `关闭`

`erpFeedback.enabled` now disables feedback item generation and writer execution
when set to false-like values. `erpFeedback.failOnError` now throws writer
failures when set to true-like values.

Unrecognized non-empty values fail closed with `ErpFeedbackError` rather than
being silently guessed.

## Scope

Changed files:

- `plugins/plugin-integration-core/lib/erp-feedback.cjs`
- `plugins/plugin-integration-core/__tests__/erp-feedback.test.cjs`

No K3 WebAPI adapter, REST route, run-log, external-system registry, workflow,
or frontend code is changed.
