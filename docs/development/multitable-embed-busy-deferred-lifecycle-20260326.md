# Multitable Embed Busy Deferred Lifecycle

## Goal

Close the last meaningful embed-host verification gap:

- component-level specs already covered `deferred`, `superseded`, and replay semantics
- but live smoke, readiness, handoff, and release-bound artifacts still only surfaced:
  - base protocol
  - dirty-form blocked/confirmed navigation protection

This round promotes the async host-navigation lifecycle into first-class pilot evidence.

## Design

### 1. Add a real browser busy/deferred chain to live smoke

`scripts/verify-multitable-live-smoke.mjs` now exercises:

1. mount embed host in form mode on a real record
2. intercept one real `POST /api/multitable/views/:viewId/submit`
3. start a real form save and hold the request open
4. send one host `mt:navigate`
5. verify `deferred`
6. send a second host `mt:navigate`
7. verify the older request becomes `superseded`
8. query host state and confirm the newest pending target is retained
9. release the save request
10. verify only the newest deferred target replays as `applied`
11. verify the in-flight form save persisted successfully

New smoke checks:

- `ui.embed-host.navigate.deferred`
- `ui.embed-host.navigate.superseded`
- `ui.embed-host.state-query.deferred`
- `ui.embed-host.navigate.replayed`
- `api.embed-host.persisted-busy-form-save`

This is stronger than synthetic protocol-only testing because it validates:

- real iframe/parent messaging
- real busy gating
- replay behavior after async unblock
- no loss of the in-flight save

### 2. Promote the lifecycle into readiness

`scripts/ops/multitable-pilot-readiness.mjs` now summarizes a third embed-host category:

- `embedHostDeferredReplay`

`overallOk` now also requires this category to pass.

`readiness.md` now contains:

- `## Embed Host Busy Deferred Replay`

### 3. Promote the lifecycle into handoff and release-bound

`scripts/ops/multitable-pilot-handoff.mjs` now lifts the readiness-derived lifecycle summary into:

- `handoff.json`
- `handoff.md`

`scripts/ops/multitable-pilot-release-bound.sh` now lifts it again into:

- `report.json`
- `report.md`

Top-level embed-host acceptance now includes:

- protocol
- navigation protection
- busy deferred replay

### 4. Update pilot runbook expectations

The pilot runbook now requires all three readiness sections to be `PASS`:

- `Embed Host Protocol Evidence`
- `Embed Host Navigation Protection`
- `Embed Host Busy Deferred Replay`

## Verification

I ran:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
node --check scripts/verify-multitable-live-smoke.mjs
node --check scripts/ops/multitable-pilot-readiness.mjs
node --check scripts/ops/multitable-pilot-handoff.mjs
bash -n scripts/ops/multitable-pilot-release-bound.sh
node --test \
  scripts/ops/multitable-pilot-readiness.test.mjs \
  scripts/ops/multitable-pilot-handoff.test.mjs \
  scripts/ops/multitable-pilot-release-bound.test.mjs
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-embed-host.spec.ts \
  tests/multitable-embed-route.spec.ts \
  tests/multitable-phase5.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  tests/multitable-form-view.spec.ts \
  tests/multitable-import-modal.spec.ts \
  tests/multitable-field-manager.spec.ts \
  tests/multitable-view-manager.spec.ts \
  --reporter=dot
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web build
```

Results:

- node syntax checks passed
- ops node tests passed: `8/8`
- focused frontend Vitest passed: `8 files / 70 tests passed`
- `tsc --noEmit` passed
- `@metasheet/web build` passed

## Notes

This round did **not** execute a full live smoke against a running local or staging stack.

What is complete now:

- script logic
- readiness/gate artifact promotion
- regression coverage
- build/type safety

What still remains for runtime proof:

- bring up API/Web
- run `scripts/verify-multitable-live-smoke.mjs`
- run pilot release/readiness flow against the real environment
