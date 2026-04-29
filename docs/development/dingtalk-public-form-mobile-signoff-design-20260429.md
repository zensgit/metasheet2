# DingTalk Public Form Mobile Signoff Design - 2026-04-29

## Goal

Close the last non-automated DingTalk public-form acceptance gap with a
redaction-safe evidence packet that can be filled after a real DingTalk mobile
run.

The previous automated coverage already verifies backend guards, frontend
access-matrix rendering, and 142 deployment health. What still cannot be faked
in unit tests is the product loop inside a real DingTalk client. This slice
makes that manual loop repeatable and auditable without requiring screenshots.

## Scope

Added script:

- `scripts/ops/dingtalk-public-form-mobile-signoff.mjs`

Added tests:

- `scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs`

The script has two modes:

- `--init-kit <dir>` writes an editable `mobile-signoff.json`, a checklist, and
  per-check artifact folders.
- `--input <file> --output-dir <dir> --strict` validates the filled evidence and
  writes `summary.json`, `summary.md`, and `mobile-signoff.redacted.json`.

## Access Matrix

The kit covers the operator-facing cases that matter for the current DingTalk
public-form plan:

| Check ID | Scenario |
| --- | --- |
| `public-anonymous-submit` | Fully public anonymous form inserts a record. |
| `dingtalk-unbound-rejected` | Login-required form rejects a local user without DingTalk binding. |
| `dingtalk-bound-submit` | Login-required form accepts a DingTalk-bound user. |
| `selected-unbound-rejected` | Selected-user form rejects a selected local user that is not DingTalk-bound. |
| `selected-bound-submit` | Selected-user form accepts a selected DingTalk-bound user. |
| `selected-unlisted-bound-rejected` | Selected-user form rejects a DingTalk-bound user outside the allowlist. |
| `granted-bound-without-grant-rejected` | DingTalk-authorized form rejects a bound user without an enabled grant. |
| `granted-bound-with-grant-submit` | DingTalk-authorized form accepts a bound user with an enabled grant. |
| `password-change-bypass-observed` | A DingTalk public-form visitor with local `must_change_password=true` sees the form instead of the password-change page. |

## Screenshot-Free Evidence

Screenshots and recordings are optional. Strict mode accepts structured
service-side evidence:

- Allowed submit checks require a positive `recordInsertDelta` or increasing
  `beforeRecordCount` / `afterRecordCount`.
- Denied submit checks require `submitBlocked=true`, zero insert delta or equal
  before/after counts, and a `blockedReason`.
- Password-change bypass observation requires `formRendered=true` and
  `passwordChangeRequiredShown=false`.

This preserves an auditable acceptance trail even when the operator cannot or
does not want to capture a DingTalk mobile screenshot.

## Secret Handling

The script rejects common raw secret shapes in JSON text and small text
artifacts:

- DingTalk robot webhook URLs.
- DingTalk `SEC...` signing secrets.
- `access_token` query parameters.
- Bearer tokens and JWTs.
- Public form tokens.
- DingTalk client secrets.

The compiled evidence file is always redacted again before writing
`mobile-signoff.redacted.json`.

## Non-goals

- The script does not call DingTalk or staging.
- The script does not create users, grants, forms, or records.
- The script does not replace backend or frontend automated tests.
- The script does not store temporary passwords or webhook secrets.
