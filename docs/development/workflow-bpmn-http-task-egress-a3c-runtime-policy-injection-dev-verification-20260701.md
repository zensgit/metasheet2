# R1-A3-c BPMN HTTP-task egress runtime policy injection — development & verification (2026-07-01)

## Scope

This slice implements the A3-c runtime wiring from
`workflow-bpmn-http-task-egress-a3-rollout-policy-design-lock-20260701.md`.

It is intentionally narrow:

- server-owned config source: `BPMN_HTTP_TASK_EGRESS_POLICY`;
- parse/normalize through the shipped A3-a normalizer;
- inject the resulting policy into both `BPMNWorkflowEngine` construction sites:
  - `packages/core-backend/src/routes/workflow.ts`;
  - `packages/core-backend/src/routes/workflow-designer.ts`;
- preserve hard fail-closed behavior for missing/malformed/invalid config;
- keep request bodies, BPMN XML, and workflow variables unable to supply policy.

No concrete production or staging destination is committed by this PR. Operators
must still provide deployment-owned server config before any allowlisted
destination becomes reachable.

## Implementation

- Added `packages/core-backend/src/workflow/bpmnHttpTaskEgressPolicy.ts`.
- The loader reads only `BPMN_HTTP_TASK_EGRESS_POLICY` from a server-owned env
  map and calls `normalizeBpmnHttpTaskEgressPolicyConfig`.
- The factory returns a small structural options object with the normalized
  policy. It intentionally does not import `BPMNWorkflowEngine`, preserving the
  convergence guard's legacy import fence. On any non-ok normalizer result, the
  normalizer already returns the default empty allowlist policy, so the route
  wiring stays fail-closed.
- `workflow.ts` and `workflow-designer.ts` both instantiate
  `BPMNWorkflowEngine(buildBpmnWorkflowEngineOptionsFromServerConfig())`, giving
  both route families the same policy source.

## Verification

Focused tests added/updated:

- `src/workflow/__tests__/bpmnHttpTaskEgressPolicy.test.ts`
  - missing config -> default empty allowlist;
  - malformed config -> default empty allowlist and no raw value in metadata;
  - valid JSON config -> normalized exact-host policy.
- `src/workflow/__tests__/BPMNWorkflowEngine.egress.test.ts`
  - server-owned A3 policy can allow a mocked public host through mocked DNS and
    mocked transport.
  - server-owned A3 policy denies off-allowlist hosts before DNS/transport;
  - malformed server config remains fail-closed before DNS/transport.
- `tests/unit/workflow-egress-route-provenance.test.ts`
  - existing route-smuggling tests now assert the route engines receive only the
    server-owned policy;
  - both `workflow` and `workflow-designer` routes share the same env-backed
    policy source;
  - request-supplied `allowedHosts`, `nat64Prefixes`, `httpTaskEgress`, and
    `egressPolicy` remain request data only and do not become engine policy.

Local commands:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  src/workflow/__tests__/bpmnHttpTaskEgressPolicy.test.ts \
  src/workflow/__tests__/BPMNWorkflowEngine.egress.test.ts \
  tests/unit/workflow-egress-route-provenance.test.ts \
  tests/unit/workflow-approval-automation-convergence.guard.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend build
```

Local results:

- R1 focused suite: 123/123 passed across egress guard, dispatcher, pinned
  transport, policy normalizer, engine wiring, route provenance, convergence
  guard, and the new A3-c loader tests.
- Backend build: `tsc` passed.
- Stale-state grep: no remaining pre-A3-c status claims in the updated R1/A3
  docs.
- `git diff --check`: passed.

## Boundaries

- This does not add a UI/API for managing allowlists.
- This does not allow tenant/user-authored policy.
- This does not broaden the egress scope beyond BPMN HTTP service-tasks.
- This does not change the dispatcher, DNS resolver, pinned transport, or
  method/header policy shipped by R1-A/R1-B.
- This does not configure any destination in source control.
