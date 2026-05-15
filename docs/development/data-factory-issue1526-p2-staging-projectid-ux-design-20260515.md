# Data Factory issue #1526 P2 - staging project ID scope UX - design - 2026-05-15

## Problem

#1526 finding #5: "A plain project ID triggered plugin-scope warnings; an
integration-scoped project ID succeeded. This rule is not obvious to
implementation users."

PR #1572 already made the project ID **optional** in the Workbench (blank ->
backend auto-scopes to `tenant:integration-core`). That removed the
"required-but-unexplained" trap for the blank case. Two residual gaps remain
and are the scope of this P2:

1. The K3 setup view's deploy-gate checklist (`k3WiseSetup.ts`) still computed
   `stagingReady = Boolean(trim(form.projectId))`. After #1572 that is wrong:
   an **empty** projectId is now valid, but the checklist marked it `missing`
   and told the user to "填写 projectId" - directly contradicting the
   Workbench's "blank is fine, auto-scoped" behavior. This contradiction *is*
   the residual confusion.
2. A user who types a **plain, non-scoped** project ID (e.g. `project_default`,
   copied from an old screenshot) still hits the original backend plugin-scope
   error with no frontend guidance and no way to fix it without knowing the
   convention.

## Backend rule (source of truth, read-only)

`packages/core-backend/src/multitable/plugin-scope.ts`
`assertProjectIdAllowedForPlugin`:

- the project ID is split on `:`; only the **final segment** is inspected;
- it must be exactly one of `getPluginProjectNamespaces('plugin-integration-core')`
  = `{ 'plugin-integration-core', 'integration-core' }`.

So:

| projectId | final segment | allowed |
| --- | --- | --- |
| `tenant:integration-core` | `integration-core` | yes (this is #1572's default) |
| `integration-core` | `integration-core` | yes |
| `plugin-integration-core` | `plugin-integration-core` | yes |
| `myproject:integration-core` | `integration-core` | yes |
| `project_default` | `project_default` | no |
| `tenant:integration-core:extra` | `extra` | **no** |

The last row is the trap: appending a suffix *after* `integration-core` breaks
it. The normalize helper is designed against this exact rule, not a guess.

## Changes (frontend only, no Stage 1 Lock break)

No `plugins/plugin-integration-core`, no DB migration, no API runtime, no route
change. Reading core-backend to learn the rule is allowed; only modification is
locked.

### 1. `apps/web/src/services/integration/workbench.ts` - two pure helpers

```ts
isIntegrationScopedProjectId(projectId): boolean
// trimmed, non-empty, and trimmed.split(':').pop().trim() in
// { 'integration-core', 'plugin-integration-core' }

normalizeIntegrationProjectId(projectId, tenantId): string
// '' / whitespace        -> `${tenantId||'default'}:integration-core`
// already scoped          -> trimmed input, unchanged
// otherwise               -> `${trimmed}:integration-core`  (suffix append,
//                            user's text preserved as prefix verbatim)
```

`normalizeIntegrationProjectId` output is always `isIntegrationScopedProjectId`
true (covered by a property test). It never injects the tenant into a
non-empty input - it only appends the required suffix, respecting what the
user typed.

### 2. `k3WiseSetup.ts` - fix the deploy-gate staging item

`stagingReady` becomes "empty OR already integration-scoped". States:

- empty projectId -> `ready`, message: server auto-scopes to
  `tenant:integration-core`;
- non-empty scoped -> `ready`, message: confirms the scoped value;
- non-empty plain -> `warning` (the enum already has `warning`), message
  explains it is not integration-scoped and how to fix; `field: projectId`.

`summarizeK3WiseDeployGateChecklist` is unchanged. `canCreatePipelines`
requires staging `=== 'ready'`, so a plain projectId now correctly blocks
pipeline creation in the summary instead of silently passing then failing at
install time.

### 3. `IntegrationK3WiseSetupView.vue` - inline hint

A `<small>` hint under the Project ID input states: blank -> auto
`tenant:integration-core`; custom must end with `:integration-core`.

### 4. `IntegrationWorkbenchView.vue` - warning + one-click normalize

- computed `stagingProjectIdScopeWarning`: non-empty AND not scoped -> a
  warning string; otherwise empty (blank stays clean - #1572 behavior intact);
- a `规范化为 integration 作用域` button (`data-testid="normalize-staging-project-id"`)
  that sets `stagingProjectId = normalizeIntegrationProjectId(value, tenantId)`
  and reports the normalized value via the existing status line;
- the existing #1572 blank-path, `defaultStagingProjectId`,
  `effectiveStagingProjectId`, and install flow are untouched.

## Non-goals

- Not changing the backend rule or auto-scope behavior.
- Not making projectId required again.
- Not touching #1526 findings #2/#3/#4 (read adapter, relationship discovery,
  SQL sampling) - separate slices, #2 is the deferred GATE-front contract.

## Compatibility / Stage 1 Lock

- Frontend only. `plugins/plugin-integration-core` not touched.
- No migration, no API runtime, no route change.
- Helpers are pure and shared (one source of truth) - imported by both
  `k3WiseSetup.ts` and `IntegrationWorkbenchView.vue`.
