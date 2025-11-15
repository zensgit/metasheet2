# PR: Merge ci/v2-stabilize into v2/init (CI/workflows alignment)

## Summary
- Align workflows to use `working-directory: metasheet-v2`
- Remove echo placeholders; run real migrate/seed/smokes
- Use v2 OpenAPI artifact (`packages/openapi/dist/combined.openapi.yml`) and enable method-level diff
- Keep legacy backend workflows limited to `paths: backend/**` (optional)
- Unify Postgres to 15 in CI

## Changes
- .github/workflows/observability.yml: workdir metasheet-v2, OpenAPI build/validate/diff, migrate+seed, concurrency smokes, metrics thresholds
- .github/workflows/migration-replay.yml: real migration replay with Postgres 15
- metasheet-v2/scripts/*: real concurrency smokes and quick-verify
- metasheet-v2/packages/openapi/*: split specs, build/validate/diff

## Risks / Rollback
- Scope: CI-only and scripts; minimal runtime impact
- Rollback: revert this PR or switch workflows back to previous commit

## Validation
- [ ] Local quick-verify.sh passed
- [ ] Observability workflow green
- [ ] Migration Replay workflow green
- [ ] OpenAPI build/validate/diff green (no path/method removal)

## Checklist
- [ ] working-directory fixed to metasheet-v2
- [ ] Postgres 15 in CI
- [ ] Real migrate/seed/approve-smoke with thresholds (success≥1, conflict≥1)
- [ ] OpenAPI artifact used and method-level diff enabled
- [ ] Legacy backend workflows limited to backend/** (if kept)
