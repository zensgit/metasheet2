# Approval navigation regression verification

## Baseline and scope

Base: `4cf17e9d379c19995f0a305a91cd811c1e33579d`.
Target: `apps/web/tests/approvalNavBatchTransferEntry.spec.ts`.
Original target: 13/13 PASS. New target: 16/16 PASS, no tests removed.
Production source is byte-identical to the base after every temporary mutation is restored.
Restored composable blob: `727b3fcf62c10cd1d237e97bc919fef22a2cfbc2`.
Final test blob: `b3f06b0858ee1b53ff1bd4f54e275de916d223e5`.

## Local gates

| Gate | Result |
| --- | --- |
| Target navigation suite | 16/16 PASS |
| Target plus batch-transfer page, todo badge, delegation entry | 4 files, 110/110 PASS |
| `type-check:verification-approval` | PASS |
| Target ESLint | exit 0; 7 existing harness warnings, 0 errors |
| Full required-web | exit 0; 14 batches, 530 file executions, 7758 tests PASS; target 16-test file present |
| Independent nav diff review (`gpt-5.6-terra`) | 0 P1 / 0 P2 / 0 P3; original 13 preserved, 16/16 focused run; consumer-only proof accepted |

Commands (from repository root):

```sh
pnpm --filter @metasheet/web exec vitest run tests/approvalNavBatchTransferEntry.spec.ts --reporter=dot
pnpm --filter @metasheet/web exec vitest run approvalNavBatchTransferEntry approvalBatchTransferView approvalNavTodoBadge approvalNavDelegationEntry --reporter=dot
pnpm --filter @metasheet/web run type-check:verification-approval
pnpm --filter @metasheet/web exec eslint tests/approvalNavBatchTransferEntry.spec.ts
bash apps/web/scripts/run-required-web-tests.sh
git diff --check
```

## Discriminating mutations

All mutations were temporary changes to `useApprovalAdminCapability.ts`, individually restored;
none is included in the delivery. Ordinary positive controls remained in the suite.

| Mutation | Observed result |
| --- | --- |
| Remove invalidation callback's generation increment | 15 PASS / 1 FAIL; precisely the new pending-logout test restores the link incorrectly |
| Replace deferred read with synchronous invocation | 14 PASS / 2 FAIL; pending logout makes an extra request, identity transition reads A instead of B |
| Remove successful response generation comparison | New pending-logout and same-subject tests both FAIL; focused same-subject rerun exits 1 at the late-grant assertion |

The initial full run of mutation 3 also encountered a Node 24 worker SIGABRT after printing the
two expected assertion failures. It is not used as a clean mutation run: a subsequent targeted
run returned ordinary exit 1 at the named same-subject assertion. Final restored gates are separate.

## Evidence limitations and publication boundary

These mounted tests use a mocked capability resolver and manual auth notifications. They prove
navigation behavior through the real composable, not HTTP/database authorization or cache IO.
No browser UAT, live data, database, flag activation, registry operation, or deployment was run.

Before Draft publication, workflow triggers were inspected on the unchanged base: the
`docker-build.yml` publisher only triggers on main/master pushes or manual dispatch, not on this
new branch or a pull request. The separate `deploy.yml` also has no pull-request event. Neither
is dispatched here. No push branch pattern matches this candidate branch; no `pull_request_target`
or `workflow_run` trigger was present. The changed-path-matched PR jobs were inspected separately;
the image publication workflows are not among them. This is a bounded trigger audit, not an audit
of every test subprocess. Ordinary remote test status must be reported separately from local PASS.

Trigger audit census: 130 workflow files parsed, zero candidate-branch push matches, zero
`pull_request_target` and zero `workflow_run` triggers. Positive control: `main` does match
`docker-build.yml`. This is why Draft publication and main merge have different boundaries.
