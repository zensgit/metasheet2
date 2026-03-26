# Multitable Pilot Local Report Verification

Date: 2026-03-26
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Scope

Verify the local pilot wrapper report slice only:

- `package.json`
- `scripts/ops/multitable-pilot-local.sh`
- `scripts/ops/multitable-pilot-local.test.mjs`

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
bash -n scripts/ops/multitable-pilot-local.sh
node --test scripts/ops/multitable-pilot-local.test.mjs
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

## Results

- shell syntax check passed
- `multitable-pilot-local.test.mjs` passed
  - `multitable pilot local writes local report with embed-host summary when runner report exists`
  - `multitable pilot local fails when runner exits without writing report.json`
- frontend `vue-tsc --noEmit` passed
- frontend build passed

## Verified Behavior

- local pilot wrapper now writes `local-report.json` and `local-report.md`
- wrapper report captures backend/web reuse vs startup mode
- wrapper report summarizes embed-host protocol, navigation protection, and deferred replay evidence when present
- wrapper fails if the delegated runner exits without producing the expected raw report
- non-embed local runners remain valid because embed evidence is summarized only when present

## Conclusion

This slice is verified. Local and staging rehearsal runs now emit a first-class wrapper artifact that is easier to inspect than raw runner output alone, and false-green runs caused by missing runner reports are now blocked.
