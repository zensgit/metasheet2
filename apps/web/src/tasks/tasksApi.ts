/**
 * Task-feature-line M2 frontend API client (design lock §5.2 / §5.2.1, backend PR #6062).
 *
 * Typed wrappers over the (not-yet-merged, `TASKS_ENABLED`-gated) `/api/tasks*` endpoints, using
 * the SAME authenticated `apiFetch` helper every other view uses — no bespoke transport, no
 * mock short-circuit: the real endpoint is always asked, in development and tests too.
 *
 * Every function below returns a discriminated result and NEVER throws on an HTTP status or a
 * transport failure — the caller switches on `kind` instead of catching. The lock's org-guidance
 * flow has exactly THREE triggers (§5.2 "引导流三触发"): `GET /api/tasks/context` resolving
 * `orgId === null`, a READ (`listTasks`) reporting `degraded: true, reason: 'org_missing'`, and a
 * WRITE (`createTask` / `completeTask` / `reopenTask`) failing with HTTP 422
 * `{ error: { code: 'ORG_MISSING' } }`. `predicate_error` (a READ-only degraded reason) is
 * deliberately a SEPARATE `kind` and must never be folded into `org_missing` — the lock is explicit
 * that a predicate failure does not trigger the org-guidance UI.
 */
import { apiFetch } from '../utils/api'

export type TaskStatus = 'open' | 'done'
export type CompletionMode = 'all' | 'any'
export type TaskView = 'assigned' | 'following' | 'created' | 'delegated' | 'any_role'
export type ReopenScope = 'self' | 'all'

export interface TaskListItem {
  id: string
  title: string
  status: TaskStatus
  completion_mode: CompletionMode
  created_by: string
  due_at: string | null
}

/** One row of `TaskDetail.assignees`. */
export interface TaskAssignee {
  userId: string
  completedAt: string | null
}

/** The `GET /api/tasks/:id` 200 body — camelCase, a DELIBERATELY separate shape from
 *  `TaskListItem` (snake_case, from the list endpoint). Do not reuse one type for both: the two
 *  endpoints do not share a wire contract, only overlapping field names in different cases. */
export interface TaskDetail {
  id: string
  title: string
  status: TaskStatus
  completionMode: CompletionMode
  createdBy: string
  /** Non-null for a TIMED task; null for an all-day task (use `dueDate`/`timeZone` instead). */
  dueAt: string | null
  /** `'YYYY-MM-DD'`, set for an all-day task. */
  dueDate: string | null
  /** `'HH:MM:SS'`, set alongside `dueDate` when the backend also tracked a time-of-day. */
  dueTime: string | null
  timeZone: string | null
  assignees: TaskAssignee[]
  /** ROLE-only: whether the viewer is PERMITTED to complete this task, independent of its current
   *  `status`. The caller must additionally check `status === 'open'` before offering the action —
   *  this field alone does not mean the button should render. */
  canComplete: boolean
  /** Same ROLE-only caveat as `canComplete`, gated by `status === 'done'` instead. */
  canReopen: boolean
}

/** `getTask`'s result kinds — deliberately NOT `BaseResultKind`: `GET /api/tasks/:id` has no
 *  org-guidance trigger (the lock's three triggers are `context`, `listTasks`'s `org_missing`
 *  degraded reason, and a WRITE's 422 `ORG_MISSING` — a single-task READ is none of those; per the
 *  backend contract a missing org resolves to a plain 404, same as "not found"/"invisible"). */
export type GetTaskResult =
  | { kind: 'ok'; task: TaskDetail }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'error'; status?: number }

/** The subset of result kinds every one of this module's functions can resolve to. `predicate_error`
 *  is added only to `ListTasksResult` (list-only, per the lock). */
type BaseResultKind = 'org_missing' | 'forbidden' | 'not_found' | 'error'

export type ListTasksResult =
  | { kind: 'ok'; items: TaskListItem[] }
  | { kind: 'predicate_error' }
  | { kind: BaseResultKind; status?: number }

export interface CreateTaskInput {
  title: string
  /** Omitted entirely (not sent) when undefined — per lock §4.2, an OMITTED `assignees` field
   *  inserts the creator as the sole assignee, while an explicit `[]` means zero assignees. Callers
   *  that want "no assignees" must pass `[]` explicitly; they are not the same request body. */
  assignees?: string[]
  completionMode?: CompletionMode
}

/** The backend's `POST /api/tasks` 200 body is contracted to carry only `{ id: string }` — it does
 *  NOT echo back the full row (no `status`/`completion_mode`/`created_by`/`due_at`). Typing the ok
 *  result as a full `TaskListItem` (as this used to) let `createTask` blindly cast whatever the 200
 *  body happened to be, so a malformed or partial body would silently masquerade as a real task
 *  row instead of failing. Every caller only needs the new id (to keep it or ignore it) — the
 *  fresh row itself always comes from the subsequent `loadList()`. */
export type CreateTaskResult =
  | { kind: 'ok'; id: string }
  | { kind: BaseResultKind; status?: number }

export type CompleteTaskResult =
  | { kind: 'ok'; done: boolean }
  | { kind: BaseResultKind; status?: number }

export type ReopenTaskResult =
  | { kind: 'ok' }
  | { kind: BaseResultKind; status?: number }

export type PendingCountResult =
  | { kind: 'ok'; count: number }
  | { kind: BaseResultKind; status?: number }

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/** `body.error.code`, or `null` for anything that is not that exact shape. */
function extractErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const error = (body as Record<string, unknown>).error
  if (!error || typeof error !== 'object') return null
  const code = (error as Record<string, unknown>).code
  return typeof code === 'string' ? code : null
}

/** A finite, non-negative number — the same strictness `classifyTasksContext` applies to `orgId`:
 *  a malformed 200 body must not be silently treated as a real, trustworthy value. */
function isCountLike(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function resolveViewerTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' ? zone : ''
  } catch {
    return ''
  }
}

export async function listTasks(view: TaskView): Promise<ListTasksResult> {
  let response: Response
  try {
    response = await apiFetch(`/api/tasks?view=${encodeURIComponent(view)}`)
  } catch {
    return { kind: 'error', status: 0 }
  }

  if (response.status === 403) return { kind: 'forbidden' }
  if (response.status === 404) return { kind: 'not_found' }
  if (response.status !== 200) return { kind: 'error', status: response.status }

  const body = await safeJson(response)
  if (!body || typeof body !== 'object') return { kind: 'error', status: response.status }
  const record = body as Record<string, unknown>

  if (record.degraded === true) {
    if (record.reason === 'org_missing') return { kind: 'org_missing' }
    if (record.reason === 'predicate_error') return { kind: 'predicate_error' }
    // An unrecognized degraded reason is not a trustworthy empty list — it must not collapse into
    // the same render as a genuinely empty view.
    return { kind: 'error', status: response.status }
  }

  if (Array.isArray(record.items)) return { kind: 'ok', items: record.items as TaskListItem[] }
  return { kind: 'error', status: response.status }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isTaskAssignee(value: unknown): value is TaskAssignee {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.userId === 'string' && isNullableString(record.completedAt)
}

/** Validates the FULL `GET /api/tasks/:id` 200 body against `TaskDetail`'s contract — every field,
 *  not just a subset. A malformed body (wrong type, missing field, an unrecognized `status`/
 *  `completionMode` literal, a non-array `assignees`, a malformed assignee row, …) must resolve to
 *  `{ kind: 'error' }`, never masquerade as a real task the caller can render. */
function isTaskDetail(value: unknown): value is TaskDetail {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string') return false
  if (typeof record.title !== 'string') return false
  if (record.status !== 'open' && record.status !== 'done') return false
  if (record.completionMode !== 'all' && record.completionMode !== 'any') return false
  if (typeof record.createdBy !== 'string') return false
  if (!isNullableString(record.dueAt)) return false
  if (!isNullableString(record.dueDate)) return false
  if (!isNullableString(record.dueTime)) return false
  if (!isNullableString(record.timeZone)) return false
  if (!Array.isArray(record.assignees) || !record.assignees.every(isTaskAssignee)) return false
  if (typeof record.canComplete !== 'boolean') return false
  if (typeof record.canReopen !== 'boolean') return false
  return true
}

/** `GET /api/tasks/:id`. Per the backend contract, a missing task, an invisible one and one in
 *  another org are ALL a plain 404 — deliberately never distinguished server-side — so this never
 *  produces an `org_missing` kind; see `GetTaskResult`'s docblock. */
export async function getTask(id: string): Promise<GetTaskResult> {
  let response: Response
  try {
    response = await apiFetch(`/api/tasks/${encodeURIComponent(id)}`)
  } catch {
    return { kind: 'error', status: 0 }
  }

  if (response.status === 403) return { kind: 'forbidden' }
  if (response.status === 404) return { kind: 'not_found' }
  if (response.status !== 200) return { kind: 'error', status: response.status }

  const body = await safeJson(response)
  if (isTaskDetail(body)) return { kind: 'ok', task: body }
  return { kind: 'error', status: response.status }
}

export async function createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
  const body: Record<string, unknown> = { title: input.title }
  // Deliberately conditional — see `CreateTaskInput.assignees`'s docblock. Do not default this to
  // `[]`: that would silently change "creator is the sole assignee" into "zero assignees" for
  // every caller that simply omits the field (the create form does).
  if (input.assignees !== undefined) body.assignees = input.assignees
  if (input.completionMode !== undefined) body.completionMode = input.completionMode

  let response: Response
  try {
    response = await apiFetch('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  } catch {
    return { kind: 'error', status: 0 }
  }

  if (response.status === 403) return { kind: 'forbidden' }
  if (response.status === 404) return { kind: 'not_found' }
  if (response.status === 422) {
    const errorBody = await safeJson(response)
    if (extractErrorCode(errorBody) === 'ORG_MISSING') return { kind: 'org_missing' }
    return { kind: 'error', status: 422 }
  }
  if (response.status !== 200) return { kind: 'error', status: response.status }

  const okBody = await safeJson(response)
  if (okBody && typeof okBody === 'object' && typeof (okBody as Record<string, unknown>).id === 'string') {
    return { kind: 'ok', id: (okBody as Record<string, unknown>).id as string }
  }
  return { kind: 'error', status: response.status }
}

export async function completeTask(id: string): Promise<CompleteTaskResult> {
  let response: Response
  try {
    response = await apiFetch(`/api/tasks/${encodeURIComponent(id)}/complete`, { method: 'POST' })
  } catch {
    return { kind: 'error', status: 0 }
  }

  if (response.status === 403) return { kind: 'forbidden' }
  if (response.status === 404) return { kind: 'not_found' }
  if (response.status === 422) {
    const errorBody = await safeJson(response)
    if (extractErrorCode(errorBody) === 'ORG_MISSING') return { kind: 'org_missing' }
    return { kind: 'error', status: 422 }
  }
  if (response.status !== 200) return { kind: 'error', status: response.status }

  const body = await safeJson(response)
  if (body && typeof body === 'object' && typeof (body as Record<string, unknown>).done === 'boolean') {
    return { kind: 'ok', done: (body as Record<string, unknown>).done as boolean }
  }
  return { kind: 'error', status: response.status }
}

export async function reopenTask(id: string, scope: ReopenScope): Promise<ReopenTaskResult> {
  let response: Response
  try {
    response = await apiFetch(`/api/tasks/${encodeURIComponent(id)}/reopen`, {
      method: 'POST',
      body: JSON.stringify({ scope }),
    })
  } catch {
    return { kind: 'error', status: 0 }
  }

  if (response.status === 403) return { kind: 'forbidden' }
  if (response.status === 404) return { kind: 'not_found' }
  if (response.status === 422) {
    const errorBody = await safeJson(response)
    if (extractErrorCode(errorBody) === 'ORG_MISSING') return { kind: 'org_missing' }
    return { kind: 'error', status: 422 }
  }
  if (response.status !== 200) return { kind: 'error', status: response.status }
  return { kind: 'ok' }
}

/** `GET /api/tasks/pending-count`. Sends `x-viewer-time-zone` per the backend contract so the
 *  server can apply the viewer-local overdue/`overdue_or_today` rules (lock §4.4) — computed fresh
 *  on every call, never cached, so a viewer who changes system timezone mid-session is answered
 *  correctly on the next poll.
 *
 *  `suppressUnauthorizedRedirect: true` — the usual discipline for a background nav-shell poll: this
 *  request fires unconditionally every 60s from the nav badge, not from a page the viewer navigated
 *  to on purpose. Without it, a session that expired mid-poll would silently bounce the viewer to
 *  `/login` out of nowhere; `useTasksBadge` already treats a non-`ok` result (401 included) as
 *  `'unavailable'`, which is the correct, non-disruptive outcome here. */
export async function fetchPendingCount(): Promise<PendingCountResult> {
  const timeZone = resolveViewerTimeZone()

  let response: Response
  try {
    response = await apiFetch('/api/tasks/pending-count', {
      headers: timeZone ? { 'x-viewer-time-zone': timeZone } : {},
      suppressUnauthorizedRedirect: true,
    })
  } catch {
    return { kind: 'error', status: 0 }
  }

  if (response.status === 403) return { kind: 'forbidden' }
  if (response.status === 404) return { kind: 'not_found' }
  if (response.status !== 200) return { kind: 'error', status: response.status }

  const body = await safeJson(response)
  if (!body || typeof body !== 'object') return { kind: 'error', status: response.status }
  const record = body as Record<string, unknown>

  if (record.degraded === true) {
    if (record.reason === 'org_missing') return { kind: 'org_missing' }
    return { kind: 'error', status: response.status }
  }

  if (isCountLike(record.count)) return { kind: 'ok', count: record.count }
  return { kind: 'error', status: response.status }
}
