# Phase 5 Nightly CI Hardening: Verification

Date: 2026-09-05
Status: LOCAL VERIFIED / remote and operational evidence separate.

## Evidence Binding

- Base: `177cafd3e34f30b5fc2682b3d392684c92fe67fe`.
- Exact code head: `49a0aa5713b1cb5c2f619257d58fe536f9bc66bf`.
- Code tree: `326ef51d315e5f573193466506012f7d0e04e3a4`.
- Only the four files declared in [the design report](phase5-nightly-ci-hardening-design-20260905.md) constitute the code delta. Documentation is a subsequent commit, not a different code implementation.

## Local Results

The expanded contract was run before workflow repair: 11 passed, 5 failed. Failures identified missing pnpm setup, the fallback installer invocation, both optional Slack guards, and missing required-lane invocation. After repair it passed 16/16.

The final five-file run passed **48/48**, zero skips:

```sh
node --test \
  scripts/ops/phase5-metrics-auth-fallback-workflow-contract.test.mjs \
  scripts/ops/phase5-cache-hit-rate-contract.test.mjs \
  scripts/ops/phase5-required-samples-contract.test.mjs \
  scripts/ops/ssh-hostkey-pin-family-contract.test.mjs \
  scripts/ops/ssh-hostkey-pin-family-behavior.test.mjs
```

| Suite | Tests |
| --- | ---: |
| Phase 5 auth/bootstrap/notification/PASS/required-lane contract | 16 |
| Cache-hit-rate contract | 4 |
| Required latency samples | 2 |
| SSH family source/caller contract | 12 |
| SSH resolver PATH-shadow behavior | 14 |

Local runtime was Node 20.20.2. The required-samples fixture used an already-installed local `tsx` binary via PATH and `npm_config_offline=true`. An initial environment-only attempt without `tsx` failed before producing validation JSON; it is not counted as successful evidence. No dependency installation, deploy-host connection, real endpoint, or database was used. The fixture server was loopback synthetic; SSH and installer commands were stubbed.

Additional checks:

```sh
actionlint -shellcheck= -pyflakes= \
  .github/workflows/phase5-nightly.yml \
  .github/workflows/phase5-nightly-validation.yml \
  .github/workflows/ssh-hostkey-pin-contract.yml
node --check scripts/ops/phase5-metrics-auth-fallback-workflow-contract.test.mjs
git diff --check
```

All exited zero. Actionlint checked workflow syntax/expressions; external shellcheck and pyflakes integration were disabled, so this is not a claim of those analyzers passing.

## Discriminating Mutations

Each mutation ran on a temporary copy of the actual workflow tree and contract file, not the authoritative worktree. The copy was restored and removed. The original source remained byte-identical throughout.

| Single mutation | Observed distinguishing failure |
| --- | --- |
| Remove pnpm setup | Bootstrap/order contract RED |
| Restore npm/pnpm/Yarn fallback | Bootstrap plus actual-installer contracts RED |
| Remove frozen-lockfile argument | Bootstrap plus actual-installer contracts RED |
| Remove nightly Slack guard | Nightly optional-notification contract RED |
| Remove external-validation Slack guard | External optional-notification contract RED |
| Remove required-lane test invocation | Required-lane census RED |
| Make nightly PASS gate accept `na` | Actual nightly shell gate test RED |
| Make external-validation PASS gate accept `na` | Actual external shell gate test RED |

The first six mutations completed in one run. The initial PASS-gate mutation helper used the wrong shell-variable spelling and stopped before applying either gate mutation; that attempt is not evidence. Corrected contextual mutations each produced the exact expected RED. Restored fixture contract then passed 16/16.

The synthetic required-samples negative retained the existing result: 5 passed assertions plus 6 unavailable latency assertions means overall failure. The positive fixture retains all 11 assertions passing. Missing notification configuration does not affect either outcome.

## Independent Review and Preservation

Terra high reviewed the exact four-file content without writes or operational actions: **0 P1 / 0 P2 / 0 P3**. It separately ran the focused contract 16/16 and the required-lane three-file set 42/42. These are local session results, not remote review artifacts. The reviewer session was closed.

Coordinator source comparison proved the existing nightly resolve/probe/validate/artifact/PASS step bodies byte-identical, and the external validation PASS gate byte-identical. Old path tokens are a subset of the new workflow tokens with zero deletion. Other tracked files, thresholds, validator source, package manifest/lockfile, and auth helpers have no code delta.

## Unfinished Evidence

- Remote CI is to be read against the published exact head, not inferred from these local runs.
- No Ready, merge, workflow dispatch/rerun, flag, staging, deployment, production, or real-customer action was performed.
- No fresh full network install was run locally; workflow bootstrap is source- and stub-verified until a separately authorized scheduled/operational execution supplies runtime evidence.
- Previously observed missing required latency samples remain an operational HOLD. This repair neither manufactures samples nor marks unavailable assertions as passing.
- Prior SHA-scoped reports remain historical evidence and are not replaced by a general claim that Phase 5 or MetaSheet is fully accepted.
