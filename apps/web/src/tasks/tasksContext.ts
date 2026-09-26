/**
 * Task-feature-line M2 frontend skeleton (design lock §5.2 / §5.3).
 *
 * Loads `GET /api/tasks/context` through the app's shared authenticated fetch helper — the same
 * `apiFetch` approvals and every other authenticated view use (`apps/web/src/utils/api.ts`). No
 * bespoke HTTP client, no mock data: the real endpoint is asked and its answer is classified.
 *
 * Five states, per the lock:
 *  - 'ready'       200 with a non-empty string `orgId` — the tenant is resolved.
 *  - 'org_missing' 200 with `orgId: null` EXACTLY — the principal is authenticated but has no org
 *                  selected yet; the view prompts them to choose one.
 *  - 'unavailable' a plain 404 — the route does not exist on this deployment. This is a REACHABILITY
 *                  fact only. It does NOT assert anything about the `TASKS_ENABLED` flag's value —
 *                  the lock (§5.2 "§13-38 缺省乙") is explicit that a 404 is rendered the same way
 *                  whether the flag is off or the backend simply predates the tasks routes.
 *  - 'forbidden'   403 — the principal is authenticated but not permitted.
 *  - 'error'       anything else: a non-2xx/404/403 HTTP status, a 200 whose body is missing
 *                  `orgId` or carries the wrong shape/type for it (a malformed 200 is not the same
 *                  contract as "no org yet" and must not be rendered as if it were), or a transport
 *                  failure (network error, abort, a 200 whose body fails to parse as JSON) that
 *                  never produces a usable response.
 */
import { apiFetch } from '../utils/api'

export type TasksContextResult =
  | { state: 'ready'; orgId: string }
  | { state: 'org_missing' }
  | { state: 'unavailable' }
  | { state: 'forbidden' }
  | { state: 'error' }

/**
 * Pure classifier: (HTTP status, parsed JSON body) -> one of the five states above. No I/O, no
 * fetch — this is the piece `tasks-context.spec.ts` exercises directly and exhaustively.
 */
export function classifyTasksContext(status: number, body: unknown): TasksContextResult {
  if (status === 200) {
    const orgId = body && typeof body === 'object' ? (body as Record<string, unknown>).orgId : undefined
    if (typeof orgId === 'string' && orgId.length > 0) {
      return { state: 'ready', orgId }
    }
    // Only an EXPLICIT `orgId: null` is "no org selected yet". Anything else at a 200 — a missing
    // field, an empty string, the wrong type, a non-object body — is a malformed/unexpected answer
    // and must not be silently rendered as the org-picker prompt.
    if (orgId === null) {
      return { state: 'org_missing' }
    }
    return { state: 'error' }
  }
  if (status === 404) return { state: 'unavailable' }
  if (status === 403) return { state: 'forbidden' }
  return { state: 'error' }
}

/**
 * Loads and classifies the task context for the current session. Any failure that never yields an
 * HTTP response (network outage, aborted request, a non-JSON 200 body, …) also classifies as
 * 'error' — that branch lives here, not in `classifyTasksContext`, which stays a pure function of
 * (status, body).
 */
export async function loadTasksContext(): Promise<TasksContextResult> {
  let response: Response
  try {
    response = await apiFetch('/api/tasks/context')
  } catch {
    return { state: 'error' }
  }

  if (response.status !== 200) {
    return classifyTasksContext(response.status, null)
  }

  try {
    const body = await response.json()
    return classifyTasksContext(response.status, body)
  } catch {
    // A 200 whose body is not valid JSON is not "no org yet" — it is an unusable answer.
    return { state: 'error' }
  }
}
