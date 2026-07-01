# Workflow BPMN HTTP-task egress A3-b route provenance — development and verification (2026-07-01)

## Scope

This is the A3-b negative-control slice from
`docs/development/workflow-bpmn-http-task-egress-a3-rollout-policy-design-lock-20260701.md`.

It does not enable any live HTTP-task destination, load runtime egress config, alter DNS/transport pinning, or change the
workflow engine wiring. The slice only locks route provenance: workflow route inputs, start variables, designer deploy
payloads, and BPMN XML must not become egress policy.

## Changes

- Added `packages/core-backend/tests/unit/workflow-egress-route-provenance.test.ts`.
  - `POST /api/workflow/deploy`, `POST /api/workflow/start/:key`, and
    `POST /api/workflow-designer/workflows/:id/deploy` remain authenticated
    before any engine deploy/start call.
  - Deploy body fields such as `allowedHosts`, `nat64Prefixes`, `egressPolicy`, and `httpTaskEgress` are not lifted into
    the engine constructor or deploy definition.
  - `POST /api/workflow/start/:key` treats policy-like keys as workflow variables only, not policy constructor input.
  - `POST /api/workflow-designer/workflows/:id/deploy` forwards the stored BPMN XML only, not request-supplied policy.
  - Policy-like BPMN XML extension elements do not construct route-supplied engine policy.
- Extended `packages/core-backend/src/workflow/__tests__/BPMNWorkflowEngine.egress.test.ts` with an engine-level
  variable-smuggling negative control: workflow variables cannot satisfy the egress allowlist.

## Verification

Commands run from the repository root:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/workflow-egress-route-provenance.test.ts \
  src/workflow/__tests__/BPMNWorkflowEngine.egress.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend build

pnpm --filter @metasheet/core-backend exec vitest run \
  src/guards/__tests__/egress-guard.test.ts \
  src/guards/__tests__/egress-dispatcher.test.ts \
  src/guards/__tests__/egress-pinned-transport.test.ts \
  src/guards/__tests__/egress-policy-normalizer.test.ts \
  src/workflow/__tests__/BPMNWorkflowEngine.egress.test.ts \
  tests/unit/workflow-egress-route-provenance.test.ts \
  --reporter=dot

git diff --check
```

Observed result:

- Focused route + engine provenance tests: 2 files / 10 tests PASS.
- Core backend build: PASS.
- R1 egress guard/dispatcher/transport/policy-normalizer/engine/route-provenance suite: 6 files / 112 tests PASS.
- `git diff --check`: PASS.

## Remaining gated work

A3-c remains the first slice that can inject a real runtime egress policy into `BPMNWorkflowEngine`. It is still
owner/governance gated because it decides the actual allowlist source and rollout behavior. This A3-b slice deliberately
keeps the fail-closed/no-destination-enabled boundary intact.
