# Attendance Local Regression Checklist (2026-03-07)

Purpose:

- Provide one command to validate attendance core integrity after large source updates.
- Produce reproducible local evidence under `output/playwright/attendance-local-regression/<timestamp>/`.

## Command

```bash
pnpm verify:attendance-regression-local
```

Default checks:

1. backend attendance integration test file
2. web unit tests
3. gate contract strict fixture
4. gate contract dashboard fixture

Generated artifacts:

- `summary.md`
- `summary.json`
- `results.tsv`
- one `*.log` file per check

## Optional: include full-flow Playwright

```bash
RUN_PLAYWRIGHT=true \
WEB_URL="http://142.171.239.56:8081/attendance" \
AUTH_TOKEN="<ADMIN_JWT>" \
pnpm verify:attendance-regression-local
```

Mobile full-flow is enabled by default when Playwright mode is on. Disable with:

```bash
RUN_PLAYWRIGHT=true PLAYWRIGHT_MOBILE=false pnpm verify:attendance-regression-local
```

## Exit semantics

- Exit `0`: no failed checks (PASS/SKIP only).
- Exit `1`: one or more checks failed.

## Notes

- This script is local regression tooling; it does not replace GA strict gates.
- Do not store real tokens in docs or committed files; use runtime env vars only.
