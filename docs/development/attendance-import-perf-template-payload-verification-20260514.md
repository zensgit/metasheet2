# Attendance Import Perf Template Payload Verification 2026-05-14

## Baseline Failure

- Live workflow: `Attendance Import Perf Long Run`
- Run: `25846123607`
- Head SHA: `0b4575fe332141a88e9cedb5e8531a7c91257dea`

Auth status:

- `rows10k-commit`: `Resolve valid auth token` passed.
- `rows50k-preview`: `Resolve valid auth token` passed.
- Skipped matrix entries also reached scenario gating after auth resolution.

Observed runtime failure:

```text
POST /attendance/import/preview: HTTP 400
VALIDATION_ERROR
path: ["columns", ...]
expected: object
received: string
```

## Verification Commands

```bash
node --test scripts/ops/attendance-import-perf-payload.test.mjs
node --check scripts/ops/attendance-import-perf.mjs
git diff --check
git diff --name-only -z | xargs -0 rg -n "access_token=[^[:space:]]+|SEC[0-9A-Za-z]{20,}|eyJ[0-9A-Za-z_-]+\\.|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}"
```

## Local Results

- sanitizer unit test: 3 pass
- `node --check`: pass
- `git diff --check`: pass
- changed-file strict value-pattern secret scan: 0 findings

## Expected Post-Merge Live Check

Rerun `Attendance Import Perf Long Run` from `main`.

Success criteria:

- Auth resolution remains green through the deploy-host fallback.
- `rows10k-commit` no longer fails with top-level `columns` validation.
- Trend summary does not emit `cat: '': No such file or directory`.
- Any remaining failure should be a real import/perf condition, not template
  payload shape drift.
