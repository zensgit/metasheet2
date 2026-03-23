# Attendance Import CSV Template Design

Date: 2026-03-23

## Status

- Implemented on branch `codex/attendance-import-template-csv-20260323`.
- Runtime code, OpenAPI, tests, and generated artifacts are included in the same change.
- The change remains additive and keeps the JSON template endpoint stable.

## Background

Run21 API testing confirmed a mismatch between the current attendance import contract and the external-client expectation:

- `GET /api/attendance/import/template` currently returns a JSON guide payload.
- The web UI converts that JSON guide into a CSV template client-side.
- API consumers who do not use the web UI still need a direct CSV download endpoint.
- The Run21 feedback specifically called out that the template is exposed as JSON, while the expected artifact is a CSV file with a header row and a sample row.

This implementation adds an API-level CSV template download path without breaking the existing JSON guide contract.

## Goals

- Provide a direct CSV download endpoint for attendance import templates.
- Keep the current JSON template endpoint intact for the web UI and any existing API consumers.
- Reuse the same mapping/profile source of truth so JSON and CSV templates do not diverge.
- Support optional profile selection so the endpoint can generate profile-specific templates.
- Keep the change additive and easy to roll back.

## Non-Goals

- Do not redesign the attendance import payload schema.
- Do not remove or rename the existing JSON template endpoint.
- Do not introduce database changes.

## Proposed API

Add a new endpoint:

- `GET /api/attendance/import/template.csv`
- Optional query parameter: `profileId`
- Response content type: `text/csv; charset=utf-8`
- Response disposition: `attachment; filename="attendance-import-template-<profile>.csv"`

Behavior:

- If `profileId` is omitted, use the same default attendance import template profile the UI currently relies on.
- If `profileId` matches a known import profile, generate the CSV header and sample row from that profile.
- If `profileId` is unknown, return `400` with `VALIDATION_ERROR`.
- Keep `401` and `403` aligned with the existing attendance admin permission model.

## Template Generation Model

The CSV template is derived from the same profile metadata that powers the JSON guide:

- Reuse the existing attendance import mapping profile list.
- Let each mapping profile declare a preferred `templateColumns` list and `templateSampleRow` for the most usable CSV download.
- Fall back to mapping-column extraction when a profile does not declare an explicit template column list.
- Escape all CSV cells correctly, including commas, quotes, and line breaks.

This keeps JSON and CSV outputs backed by the same profile registry while still letting the CSV artifact be more operator-friendly than a raw dump of every possible column.

## Relationship To Existing JSON Template

The existing JSON endpoint remains the authoritative structured guide:

- `GET /api/attendance/import/template` continues to return JSON.
- The JSON response remains the best source for the web UI, because it carries metadata such as mapping profiles and payload examples.
- The new CSV endpoint is an additional output format, not a replacement.

This separation keeps the UI and API consumers both supported:

- Web UI now prefers the new CSV endpoint and keeps the existing client-side CSV generation as a compatibility fallback for older backends.
- External clients can download the CSV directly without reconstructing template columns themselves.

## OpenAPI Contract

Update the attendance OpenAPI spec to document both formats:

- Keep the existing JSON schema for `GET /api/attendance/import/template`.
- Add `GET /api/attendance/import/template.csv` with a `text/csv` response.
- Document `profileId` as an optional query parameter.
- Document `mappingProfiles` on `AttendanceImportTemplate`, because the endpoint already returns it and the UI depends on it.
- Make the CSV endpoint additive so existing generated clients do not break.

If generated OpenAPI artifacts are tracked in this branch, they should be refreshed in the same change to avoid contract drift.

## Error Semantics

- `401` when the caller is not authenticated.
- `403` when the caller lacks `attendance:admin` permission.
- `400` when `profileId` is present but does not match a known template profile.
- `500` only for unexpected server-side template generation failures.

Do not silently fall back to a different template profile when the caller explicitly passes an invalid `profileId`.

## Compatibility And Rollback

Compatibility:

- Existing JSON callers keep working unchanged.
- Existing frontend CSV download behavior remains available as a fallback.
- The new endpoint is additive and does not require a migration.

Rollback:

- Remove the new CSV route and its OpenAPI entry if the feature needs to be reverted.
- Leave the JSON template endpoint untouched so the UI can continue operating.
- Because there is no persistent schema change, rollback is code-only.

## Risks

- The CSV template could drift from the JSON guide if the generation logic is duplicated.
- A profile mismatch could create user confusion if the web UI and API default to different profiles.
- If the endpoint is added without good tests, contract regressions could hide behind the existing JSON endpoint.

Mitigations:

- Share template derivation logic between JSON and CSV outputs.
- Add explicit integration coverage for the CSV route and invalid profile handling.
- Keep the JSON template route as the canonical metadata source for structured payload guidance.

## Acceptance Criteria

- API clients can download a CSV template directly.
- The CSV output is generated from the same attendance import profile metadata as the JSON guide.
- Invalid `profileId` values fail fast with a clear validation error.
- The existing JSON template endpoint still returns the same shape.
- The frontend download action can use the server CSV path without breaking older backends.
- The feature can be rolled back without database work.
