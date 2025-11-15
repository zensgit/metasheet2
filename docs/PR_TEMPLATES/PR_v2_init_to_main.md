# PR: Promote v2/init to main (observability + migrations + openapi gates)

## Summary
- Promote v2/init with real CI gates to main
- Observability: OpenAPI build/validate/method-level diff; migrate+seed; concurrency smokes; metrics thresholds
- Migration Replay: run v2 migrations on empty DB, start backend, health check

## Changes
- Workflows aligned to `working-directory: metasheet-v2`
- Postgres 15 in CI services
- OpenAPI artifact published as build output for future diffs

## Risks / Rollback
- Merge during low traffic window
- Rollback: revert PR or redeploy previous tag

## Validation (attach links)
- [ ] Observability run: <link>
- [ ] Migration Replay run: <link>
- [ ] Local quick-verify: passed

## Post-merge
- [ ] Tag release (v2.0.0-alpha.x)
- [ ] Publish OpenAPI artifact
- [ ] Monitor error rate, P99 latency, approval conflict share for 24–48h
