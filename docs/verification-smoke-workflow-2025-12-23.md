# Smoke Workflow Verification (2025-12-23)

## Scope

- New GitHub Actions smoke workflow
- Manual dispatch, lightweight validation

## Changes

- Added `.github/workflows/smoke-verify.yml`
- Updated `.github/workflows/README.md` with workflow details
- Updated `docs/verification-index.md` with CI entry

## Verification

CI workflow only. Local runner confirmed smoke suite passes after RBAC changes:

```bash
pnpm verify:smoke:all
```

Result:

- PASS
- Reference: `docs/verification-smoke-2025-12-23.md`

## CI Trigger Status

Attempted to trigger via `gh`:

```bash
gh workflow run smoke-verify.yml --ref main
```

Result:

- ❌ `HTTP 404: workflow smoke-verify.yml not found on the default branch`
- Action needed: push `.github/workflows/smoke-verify.yml` to the remote default branch before retrying.
