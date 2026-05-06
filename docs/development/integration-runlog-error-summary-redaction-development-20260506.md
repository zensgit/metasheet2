# Integration Run Log Error Summary Redaction - Development

Date: 2026-05-06
Branch: `codex/integration-runlog-error-summary-redaction-20260506`

## Goal

Prevent PLM/ERP adapter errors from persisting secret-bearing text into `integration_runs.error_summary`.

## Problem

`plugins/plugin-integration-core/lib/run-log.cjs` already capped `errorSummary` at `MAX_ERROR_SUMMARY_LENGTH`, but the value was stored verbatim before truncation. Adapter and transport errors can include text such as:

- bearer tokens in HTTP errors;
- query parameters such as `access_token`, `password`, `secret`, or `api_key`;
- inline `token=...` / `Authorization=...` fragments;
- basic-auth style URLs such as `https://user:password@example.test`.

That made the run ledger durable but not fully safe for operator-facing diagnostics or later evidence export.

## Implementation

Files changed:

- `plugins/plugin-integration-core/lib/run-log.cjs`
- `plugins/plugin-integration-core/__tests__/runner-support.test.cjs`

Changes:

- Added `redactErrorSummaryText()` for text-shaped run error summaries.
- Added `sanitizeErrorSummary()` so run-log processing is now:
  1. redact secret-like text;
  2. then enforce the existing 2000-character cap.
- Applied the sanitizer to both:
  - `finishRun(..., extra.errorSummary)`;
  - `failRun(run, error)` via the existing `finishRun()` path.
- Kept short non-sensitive messages unchanged.

## Regression Found While Testing

The first implementation used a broad `key=value` regex that consumed across `&` in query strings. The new regression test caught that `password=...` could disappear from the output instead of being independently redacted. The regex now stops on `&`, preserving per-parameter redaction.

## Safety

This is a run-ledger storage hardening only. It does not change adapter behavior, pipeline branching, dead-letter creation, ERP writes, or public REST response shape.

## Residual Risk

The redaction is intentionally text-pattern based. Structured payload diagnostics should continue using `sanitizeIntegrationPayload()` when stored as objects. This patch specifically protects the plain-text `error_summary` column.
