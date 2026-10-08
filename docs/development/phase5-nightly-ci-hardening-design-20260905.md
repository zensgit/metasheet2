# Phase 5 Nightly CI Hardening: Design and Development

Date: 2026-09-05
Status: LOCAL VERIFIED; publication is Draft/HOLD only.

## Exact Scope

- Original code/publication base: `177cafd3e34f30b5fc2682b3d392684c92fe67fe`.
- Current replay base: `70dc72d7671cad9cea1925ed93f90d3d9c746aeb`.
- Code commit: `49a0aa5713b1cb5c2f619257d58fe536f9bc66bf`.
- Code tree: `326ef51d315e5f573193466506012f7d0e04e3a4`.
- Branch: `codex/phase5-nightly-ci-hardening-20260905`.
- Four code/workflow files, 118 insertions and 6 deletions; these two reports are separate documentation children.
- Authority: standing bounded development/CI repair and Draft publication. No Ready, merge, dispatch, flag, deployment, production, or customer-data authorization is inferred.

The current-main true merge is `206d9c15f166f3f5de04e53ac5a41c9790eca33c`,
tree `c915350e88f0dcf7d898189d51ab7299ef5b87be`, ordered parents
`da8fd3660f62260a29645cccc5bb38874c862daa` and the current replay base.
All six owned code/report paths are unchanged across this merge. Main's four
stock-preparation source/test/required-Web changes were an automatic union;
there was no conflict or manual resolution. The 48 local contracts, workflow
and Node syntax checks passed again, as did eight focused stock-preparation
tests. This subsequent report child changes no code.

## Observed Failure Classes

The scheduled validation run `33938353803`, job `101230626602`, failed before validation: `npm ci` had no npm lockfile, the pnpm fallback was unavailable, and the Yarn fallback on Node 18 encountered a dependency requiring Node 20. This is a deterministic bootstrap defect, not evidence that a metric failed its threshold.

The other scheduled runs `33938032572` and `33937923638` reached metrics validation but reported six required latency assertions as unavailable. Existing policy correctly fails the overall result when required samples are absent. An unconfigured Slack action added a separate notification failure. This change does not decide whether unavailable samples mean idle instrumentation, wrong runtime provenance, or another live configuration issue.

## Implementation

| File | Bounded change |
| --- | --- |
| `.github/workflows/phase5-nightly.yml` | Establish Node 20, then pnpm 10.16.1, then only `pnpm install --frozen-lockfile`; preserve identical existing setup/install conditions. Guard optional Slack on webhook presence. |
| `.github/workflows/phase5-nightly-validation.yml` | Guard optional Slack on webhook presence while retaining its existing metrics-probe condition. |
| `.github/workflows/ssh-hostkey-pin-contract.yml` | Append the hermetic Phase 5 contract to the existing stable required lane and its push trigger. Preserve all existing SSH tests and selectors. |
| `scripts/ops/phase5-metrics-auth-fallback-workflow-contract.test.mjs` | Preserve nine existing tests; add bootstrap/order, real shell failure propagation, optional-notification, actual PASS-gate, and required-lane contracts. |

The job-level `SLACK_WEBHOOK_CONFIGURED` environment value contains only a Boolean expression result. The actual webhook remains in its existing notification-step environment. Missing optional notification configuration does not turn failed validation into success.

The install test executes the actual workflow shell block with PATH-shadowed package managers. A successful install and exit-code-7 failure must both invoke only frozen pnpm; failure must not launch another installer. No network dependency installation is performed by this test.

The PASS-gate tests execute each actual shell gate against synthetic pass/fail/unavailable/missing/malformed JSON. Only explicit `summary.overall_status=pass` succeeds. The independent existing required-samples test executes the validator against a local synthetic HTTP fixture and proves that absent latency samples still fail.

## Preserved Boundaries

- Metrics auth resolution, SSH pins, probes, validation commands, artifact steps, schedules, and PASS gates are unchanged.
- No metrics selector, minimum-sample requirement, threshold, baseline, or runtime source is weakened.
- Existing unconfigured/unreachable probe skip behavior is outside this repair; no new skip path was introduced.
- No package manifest, lockfile, plugin workflow, provenance pin, branch protection, migration, database, or application code is edited.
- Workflow path-token census retains every old token: nightly 3 to 3, external validation 3 to 3, SSH lane 6 to 7, zero missing tokens.
- Local static/hermetic success is not scheduled-run success, deployed-runtime validation, staging acceptance, or production health.

## Acceptance Gates

| Gate | State at code commit |
| --- | --- |
| Five owning/neighbor test files | PASS: 48 tests, zero skips |
| Eight independent fixture-copy mutations | RED for each removed protection; restored content GREEN |
| Workflow syntax and Node syntax | PASS |
| Independent Terra high bounded review | 0 P1 / 0 P2 / 0 P3; local only |
| Remote exact-head CI | Not claimed by this code-scoped report; inspect the published PR head |
| Ready/merge | Separate owner gate |
| Scheduled/live metrics acceptance | NOT RUN; unresolved required-sample evidence remains HOLD |

See [the verification report](phase5-nightly-ci-hardening-verification-20260905.md) for commands, mutation evidence, and limits.
