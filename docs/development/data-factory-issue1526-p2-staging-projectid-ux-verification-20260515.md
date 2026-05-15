# Data Factory issue #1526 P2 - staging project ID scope UX - verification - 2026-05-15

Companion to `data-factory-issue1526-p2-staging-projectid-ux-design-20260515.md`.
Frontend-only; no `plugins/plugin-integration-core`, no DB migration, no API
runtime, no route change.

## Local test commands and results

```text
cd apps/web
pnpm vitest run tests/integrationWorkbench.spec.ts tests/k3WiseSetup.spec.ts \
  tests/IntegrationWorkbenchView.spec.ts tests/IntegrationK3WiseSetupView.spec.ts
```

```text
 ✓ tests/integrationWorkbench.spec.ts        (21 tests)
 ✓ tests/k3WiseSetup.spec.ts                 (41 tests)
 ✓ tests/IntegrationK3WiseSetupView.spec.ts  (3 tests)
 ✓ tests/IntegrationWorkbenchView.spec.ts    (6 tests)

 Test Files  4 passed (4)
      Tests  71 passed (71)
```

```text
pnpm vue-tsc --noEmit   -> exit 0
eslint (changed files)  -> 0 errors (18 warnings, all pre-existing
                           router-link test-stub pattern, not introduced here)
```

## Modified existing assertions (declared up front, motivated - not pure-add)

Per the PR-hardening discipline, the existing-test changes are listed here
explicitly with their justification:

1. `k3WiseSetup.spec.ts` "summarizes deploy readiness fields that can be filled
   after deployment": `expect(byId.staging?.status).toBe('missing')` ->
   `toBe('ready')`, plus an added `message` contains-assertion.
   **Why:** the form has an empty `projectId`. PR #1572 made an empty
   projectId valid (server auto-scopes). The old `'missing'` assertion encoded
   the pre-#1572 behavior that this P2 is explicitly fixing - the contradiction
   between the K3-setup checklist and the Workbench was the bug. `summary`
   assertions are unchanged: `canCreatePipelines` stays `false` because
   `plm-source` is `external` (staging readiness alone does not flip it), and
   the `toMatchObject` only checks `external: 1`.

2. `k3WiseSetup.spec.ts` "marks internal dry-run ready ..." and "requires an
   explicit live-run opt-in ...": `projectId: 'project_1'` ->
   `'tenant_1:integration-core'`.
   **Why:** these tests exercise the **pipeline-dry-run / pipeline-live-run**
   gating; staging-ready is incidental setup. Under the now-correct rule
   `project_1` is non-scoped -> staging `warning` -> `canCreatePipelines` false,
   which would mask the dry-run/live logic they actually test. Using an
   integration-scoped projectId keeps staging genuinely `ready` so the gating
   under test is still exercised, and aligns the fixture with what a real
   deployment must use.

Neither of these two tests is itself a project-ID-validation test - the new
dedicated "flags a non-integration-scoped projectId ..." case (below) owns the
plain-vs-scoped negative/positive coverage, so no negative case is lost by
re-scoping their fixtures.

No other existing assertions were modified.

## Added tests (pure-add)

- `integrationWorkbench.spec.ts`: table-driven `isIntegrationScopedProjectId`
  (10 cases) and `normalizeIntegrationProjectId` (8 cases) including the
  wrong-guess catcher `tenant:integration-core:extra` -> invalid, plus a
  property test that normalize output is always scoped.
- `k3WiseSetup.spec.ts`: "flags a non-integration-scoped projectId as a warning
  and accepts a scoped one" (plain -> `warning` + `field: projectId`; scoped ->
  `ready`).
- `IntegrationWorkbenchView.spec.ts`: "warns and one-click normalizes a
  non-integration-scoped staging project ID" - warning hidden when blank,
  appears for `project_default`, normalize button -> `project_default:integration-core`,
  warning clears, status line confirms; blank again -> no warning.

## Pre-existing unrelated failures (NOT introduced by this PR)

A broader sweep showed `tests/multitable-workbench-import-flow.spec.ts` (and
two sibling import-flow files) failing. Verified these are pre-existing and
unrelated:

- the file imports none of the modules changed here
  (`integration/workbench`, `integration/k3WiseSetup`,
  `IntegrationWorkbenchView`, `IntegrationK3WiseSetupView`);
- with this PR's `apps/web` changes stashed, the same file still fails 7/7 on
  clean `origin/main`.

They are an import-flow / auth-token setup issue outside this PR's scope and
are explicitly not addressed here.

## Backend grounding (read-only, not modified)

Helpers were written against `assertProjectIdAllowedForPlugin` in
`packages/core-backend/src/multitable/plugin-scope.ts` and
`getPluginProjectNamespaces` (allowed final segments:
`integration-core`, `plugin-integration-core`). No core-backend file was
modified; it was only read to learn the exact rule so the normalize is
deterministic rather than guessed.

## Deployment impact

None. No env, no migration, no flag, no route, no bundle behavior change.
Rendering + a pure helper + a checklist-status fix. Rollback = revert the PR.

## Stage 1 Lock conformance

- No new战线; existing Data Factory / K3 setup surfaces only.
- No `plugins/plugin-integration-core` touch.
- No migration, no API runtime, no real adapter change.
- `/integrations/workbench` and the K3 setup route unchanged.

## GATE-blocking status

Does not lift the customer GATE and does not implement any P1 read/list
runtime. Pure onboarding-clarity polish for already-deployed environments.
