# Attendance Import Perf Template Payload Development 2026-05-14

## Summary

After PR `#1539` fixed long-run auth resolution, live run `25846123607`
advanced past `Resolve valid auth token` and failed inside
`rows10k-commit / Run long-run scenario`.

The failure was not an auth failure. The perf helper used
`GET /attendance/import/template` as a baseline payload and spread
`payloadExample` directly into the preview/commit request. That template
contains display-oriented fields such as `columns: ["日期", "工号", ...]` and
`requiredFields`. The current import API schema treats top-level `columns` as
API column objects, so string columns fail validation.

## Changes

- Added `sanitizeImportTemplatePayloadExample()` in
  `scripts/ops/attendance-import-perf.mjs`.
- Removed display-only string `columns` from template examples before building
  live preview/commit payloads.
- Removed `requiredFields`, which is documentation metadata and not part of the
  import request contract.
- Preserved API-style object columns when present.
- Reused `template.data.mapping` as the request `mapping` when the sanitized
  payload example does not already include one.
- Guarded the script entrypoint so the sanitizer can be imported by focused
  tests without executing the live perf run.

## Scope

This is an ops-helper compatibility fix only. It does not change the Attendance
import API, database schema, or production runtime behavior.

## Rollback

Revert this commit to restore the old helper behavior. If reverted, long-run
perf scenarios may again fail when template examples include display-only
string columns.
