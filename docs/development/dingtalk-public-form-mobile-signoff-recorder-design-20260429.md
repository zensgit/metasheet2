# DingTalk Public Form Mobile Signoff Recorder Design - 2026-04-29

## Goal

Reduce the remaining real DingTalk mobile signoff work from hand-editing a full
JSON packet to running one command per verified scenario.

The previous mobile signoff kit already provides `--init-kit` and strict
compile validation. This slice adds a narrow `--record` mode so operators can
capture each public-form access-matrix result immediately after testing it on a
real DingTalk client.

## Scope

Changed script:

- `scripts/ops/dingtalk-public-form-mobile-signoff.mjs`

Changed tests:

- `scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs`

Added docs:

- `docs/development/dingtalk-public-form-mobile-signoff-recorder-design-20260429.md`
- `docs/development/dingtalk-public-form-mobile-signoff-recorder-verification-20260429.md`

## CLI Contract

Record one check:

```bash
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs \
  --record mobile-signoff.json \
  --check-id public-anonymous-submit \
  --status pass \
  --source server-observation \
  --operator qa \
  --summary "Anonymous public form inserted one record." \
  --record-insert-delta 1
```

Supported record fields:

- `--check-id`: one of the known mobile signoff check IDs.
- `--status`: `pass`, `fail`, `skipped`, or `pending`.
- `--source`: `manual-client`, `server-observation`, or `operator-note`.
- `--operator`, `--performed-at`, `--summary`, `--notes`.
- `--artifact`: repeatable relative artifact path inside the kit.
- `--before-record-count`, `--after-record-count`, `--record-insert-delta`.
- `--submit-blocked`, `--blocked-reason`.
- `--form-rendered`, `--password-change-required-shown`, `--no-password-change-required-shown`.
- `--dry-run`: validates and prints the updated check without writing.

## Validation Rules

Record mode reuses the existing strict evidence semantics for a check marked
`pass`:

- Allowed submit checks require a positive insert delta or increasing before /
  after counts.
- Denied submit checks require `submitBlocked=true`, zero insert proof, and a
  blocked reason.
- Render checks require `formRendered=true` and
  `passwordChangeRequiredShown=false`.

For `pass` and `fail`, `performedAt` is auto-filled when absent. Artifact paths
must be relative to the signoff kit and must exist before a passing record is
accepted.

## Secret Handling

The recorder scans the updated check before writing:

- DingTalk robot webhook URLs are rejected.
- DingTalk `SEC...` signing secrets are rejected.
- `access_token` query parameters are rejected.
- Bearer tokens and JWTs are rejected.
- Public form tokens and DingTalk client secrets are rejected.

`--dry-run` prints the redacted check only after validation succeeds.

## Operator Flow

1. Initialize the kit with `--init-kit`.
2. Run each real DingTalk mobile scenario.
3. Immediately run `--record` for that scenario.
4. Compile with `--input ... --strict` after all required checks are recorded.

This keeps the final evidence packet deterministic while still allowing
screenshot-free validation through service-side insert counts and visible block
reasons.

## Non-goals

- The recorder does not call DingTalk.
- The recorder does not create forms, grants, users, or records.
- The recorder does not persist raw screenshots, tokens, temporary passwords, or
  webhook secrets.
