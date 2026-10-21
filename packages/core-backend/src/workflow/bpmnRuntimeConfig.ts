/**
 * Fail-closed env-gate for the entire BPMN workflow **runtime** surface.
 *
 * Security context (rebaselined @ c5a4a94f7, 2026-08-20):
 *   - `routes/workflow.ts` mounts the whole runtime router at `/api/workflow`
 *     unconditionally (`index.ts` `app.use('/api/workflow', workflowRouter)`),
 *     so every runtime endpoint — `/deploy`, `/start/:key`, `/instances`,
 *     `/tasks`, `/tasks/:id/claim`, `/tasks/:id/complete`, `/message`,
 *     `/signal`, `/incidents` — is reachable by any authenticated user.
 *   - Those handlers lack per-task/per-tenant authorization: `completeUserTask`
 *     verifies no assignee/candidate, `task` list can enumerate cross-user, and
 *     tenant propagation on `bpmn_process_definitions`/`_instances` is broken.
 *   - The pre-existing `DISABLE_WORKFLOW` flag only skips
 *     `workflowEngine.initialize()`; it does NOT stop the HTTP routes. So a
 *     "disabled" deployment still exposes the runtime surface.
 *
 * This gate closes the whole runtime, fail-closed by default:
 *   - The engine only initializes when the runtime is enabled (so the timer
 *     poller, `resumeActiveInstances`, metrics and health-check all stay off
 *     too — runtime-off implies poller-off).
 *   - `requireBpmnRuntimeEnabled` returns 503 for every runtime route when
 *     disabled, closing the anonymous-access hole regardless of engine state.
 *
 * DEFAULT OFF. Enabled ONLY when `ENABLE_BPMN_RUNTIME` is the exact string
 * `'true'` AND `DISABLE_WORKFLOW` is not `'true'`. Missing / empty / any other
 * value (`'TRUE'`, `'1'`, `'yes'`, …) => disabled. Only re-enable a deployment
 * after the workflow task-authorization + tenant-isolation model is built and
 * a task substrate is chosen (see the platform design doc §7 / #16a′).
 *
 * Gating the runtime PAUSES processing (pre-existing WAITING timer jobs stay
 * WAITING, in-flight instances are not resumed) rather than dropping anything;
 * it is fully reversible by setting the flag.
 */

export const BPMN_RUNTIME_ENABLED_ENV = 'ENABLE_BPMN_RUNTIME'
export const BPMN_RUNTIME_DISABLE_ENV = 'DISABLE_WORKFLOW'

type BpmnRuntimeEnv = Readonly<Record<string, string | undefined>>

/**
 * Single source of truth for "is the BPMN runtime allowed to serve / initialize".
 * Fail-closed: true only for the exact literal `ENABLE_BPMN_RUNTIME==='true'`
 * with `DISABLE_WORKFLOW` not forcing it off.
 */
export function isBpmnRuntimeEnabled(env: BpmnRuntimeEnv = process.env): boolean {
  if (env[BPMN_RUNTIME_DISABLE_ENV] === 'true') return false
  return env[BPMN_RUNTIME_ENABLED_ENV] === 'true'
}

/** Values-free reason string surfaced to disabled-runtime callers. */
export const BPMN_RUNTIME_DISABLED_MESSAGE =
  'BPMN workflow runtime is disabled (set ENABLE_BPMN_RUNTIME=true to enable).'

interface MinimalResponse {
  status(code: number): MinimalResponse
  json(body: unknown): unknown
}
type MinimalNext = () => void

/**
 * Express middleware: 503 when the runtime is disabled, otherwise `next()`.
 * Typed structurally so it needs no `express` import and stays unit-testable.
 *
 * Apply to the whole `/api/workflow` router and to the designer's ONE
 * engine-reaching route, `/workflows/:id/deploy`.
 *
 * NOT `/templates/:id/instantiate` (Codex round 2): that handler is draft-only
 * authoring — it ends at `designer.saveWorkflow`, a `workflow_definitions`
 * upsert with `status: 'draft'`, and `WorkflowDesigner` never imports
 * `BPMNWorkflowEngine`. The ratified S1 spec keeps draft/modeling/
 * compile-preview OPEN while the runtime is off and closes only
 * deploy/start/timer.
 */
export function requireBpmnRuntimeEnabled(
  _req: unknown,
  res: MinimalResponse,
  next: MinimalNext,
): void {
  if (isBpmnRuntimeEnabled()) {
    next()
    return
  }
  res.status(503).json({
    success: false,
    error: BPMN_RUNTIME_DISABLED_MESSAGE,
    code: 'BPMN_RUNTIME_DISABLED',
  })
}
