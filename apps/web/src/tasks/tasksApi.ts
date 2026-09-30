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

/** One row of `TaskDetail.children` (M3 backend contract §3.2) — a DIRECT subtask only, already
 *  filtered server-side to non-deleted rows the caller can `view`. Deliberately a NARROW shape
 *  (no `dueAt`/`assignees`/…): the contract states `children` carries exactly these five fields,
 *  not a full `TaskDetail` per child. */
export interface TaskChild {
  id: string
  title: string
  status: TaskStatus
  completionMode: CompletionMode
  depth: number
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
  /** M3 addition (backend contract §3.2). `null` for a root task. */
  parentId: string | null
  /** M3 addition. 0 for a root task, max 4 per the contract ("`depth` 最大是 4,含根"). */
  depth: number
  /** M3 addition. Direct subtasks only — see `TaskChild`'s docblock. Never includes an invisible
   *  or soft-deleted child; the contract omits those rather than 404ing the whole detail read. */
  children: TaskChild[]
  /** Optional: the follower user ids, when the backend includes them in the detail body (requested
   *  for the M3 contract §3.2; absent today). When absent the follower list is learned only from a
   *  membership write response. */
  followers?: string[]
  /** Optional: whether the viewer may leave (stop following) this task, when the backend provides
   *  it. When present it is the only input for showing the Leave control. */
  canLeave?: boolean
  /** Optional row-level abilities (backend contract §3.2). When present, `false` hides the
   *  matching controls; when absent (an older body) the controls stay visible and the server's
   *  own check remains the only gate. `canEdit` covers membership, completion mode and parent;
   *  `canComment` covers posting, and editing or deleting one's own comment. */
  canEdit?: boolean
  canDelete?: boolean
  canComment?: boolean
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Validates one `TaskDetail.children` row against `TaskChild`'s contract — same "every field,
 *  reject anything unrecognized" discipline as `isTaskDetail` below (an unrecognized `status`
 *  literal, a non-finite `depth`, … must not masquerade as a real child row). */
function isTaskChild(value: unknown): value is TaskChild {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string') return false
  if (typeof record.title !== 'string') return false
  if (record.status !== 'open' && record.status !== 'done') return false
  if (record.completionMode !== 'all' && record.completionMode !== 'any') return false
  if (!isFiniteNumber(record.depth)) return false
  return true
}

/** Validates the FULL `GET /api/tasks/:id` 200 body against `TaskDetail`'s contract — every field,
 *  not just a subset — and returns the parsed detail, or `null` for a malformed body (wrong type,
 *  missing field, an unrecognized `status`/`completionMode` literal, a non-array `assignees`, a
 *  malformed assignee row, …), which the caller resolves to `{ kind: 'error' }`.
 *
 *  The three M3 tree fields (`parentId`/`depth`/`children`) are a GROUP: a body with none of them is
 *  the M2 shape (today's backend) and parses as a root task with no visible children; a body with
 *  any of them must carry all three, each with the right type. The optional `followers`/`canLeave`/
 *  `canEdit`/`canDelete`/`canComment` are validated only when present. */
function parseTaskDetail(value: unknown): TaskDetail | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string') return null
  if (typeof record.title !== 'string') return null
  if (record.status !== 'open' && record.status !== 'done') return null
  if (record.completionMode !== 'all' && record.completionMode !== 'any') return null
  if (typeof record.createdBy !== 'string') return null
  if (!isNullableString(record.dueAt)) return null
  if (!isNullableString(record.dueDate)) return null
  if (!isNullableString(record.dueTime)) return null
  if (!isNullableString(record.timeZone)) return null
  if (!Array.isArray(record.assignees) || !record.assignees.every(isTaskAssignee)) return null
  if (typeof record.canComplete !== 'boolean') return null
  if (typeof record.canReopen !== 'boolean') return null

  const treeFields = ['parentId', 'depth', 'children'] as const
  const present = treeFields.filter((field) => record[field] !== undefined)
  let parentId: string | null = null
  let depth = 0
  let children: TaskChild[] = []
  if (present.length > 0) {
    // Each check below also rejects an ABSENT field (undefined fails all three), which is what
    // makes a partial group malformed.
    if (!isNullableString(record.parentId)) return null
    if (!isFiniteNumber(record.depth)) return null
    if (!Array.isArray(record.children) || !record.children.every(isTaskChild)) return null
    parentId = record.parentId
    depth = record.depth
    children = record.children
  }

  const detail: TaskDetail = {
    id: record.id,
    title: record.title,
    status: record.status,
    completionMode: record.completionMode,
    createdBy: record.createdBy,
    dueAt: record.dueAt,
    dueDate: record.dueDate,
    dueTime: record.dueTime,
    timeZone: record.timeZone,
    assignees: record.assignees,
    canComplete: record.canComplete,
    canReopen: record.canReopen,
    parentId,
    depth,
    children,
  }
  if (record.followers !== undefined) {
    if (!Array.isArray(record.followers) || !record.followers.every((id) => typeof id === 'string')) return null
    detail.followers = record.followers
  }
  if (record.canLeave !== undefined) {
    if (typeof record.canLeave !== 'boolean') return null
    detail.canLeave = record.canLeave
  }
  for (const flag of ['canEdit', 'canDelete', 'canComment'] as const) {
    if (record[flag] === undefined) continue
    if (typeof record[flag] !== 'boolean') return null
    detail[flag] = record[flag]
  }
  return detail
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

  const task = parseTaskDetail(await safeJson(response))
  if (task) return { kind: 'ok', task }
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

/*
 * ---------------------------------------------------------------------------------------------
 * M3 additions (backend contract `docs/development/task-m3-backend-design-20260928.md`, §3.1,
 * §3.3–§3.7). The backend is NOT implemented yet — every function below is coded only against
 * that contract; tests mock `apiFetch`.
 *
 * Every M3 WRITE endpoint shares the SAME non-2xx shape: 403 -> forbidden, 404 -> not_found, a
 * 409 with a parseable `error.code` -> conflict, a 422 with `error.code === 'ORG_MISSING'` ->
 * org_missing (the contract's preamble restates M2's invariant — "写操作缺 org 仍是 422
 * ORG_MISSING" — applies uniformly to every M3 write, not just the M2 three), any OTHER 422 code
 * -> validation, and anything unparseable/unexpected -> error. `classifyWriteFailure` below is
 * the single place that mapping lives; every write function calls it once `response.status` is
 * known not to be its own success code. `listComments` is the one new READ (mirrors `getTask`:
 * a plain 404 covers missing/invisible/other-org/soft-deleted, no `org_missing` kind — see
 * `ListCommentsResult`'s docblock).
 * ---------------------------------------------------------------------------------------------
 */

/** Whether a value can be placed in a URL path as ONE segment. `encodeURIComponent` leaves `.`
 *  unescaped and URL parsing collapses `.` and `..` segments, so such a value would change which
 *  route the request reaches; it is refused before any request is built. */
export function isPathSafeSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..'
}

export type WriteFailure =
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'org_missing' }
  | { kind: 'validation'; code: string }
  | { kind: 'conflict'; code: string }
  | { kind: 'error'; status?: number }

/** Shared non-2xx classifier for every M3 write endpoint — see the module-level note above for
 *  the full mapping. Only called once `response.status` is confirmed not to be a success. */
async function classifyWriteFailure(response: Response): Promise<WriteFailure> {
  if (response.status === 403) return { kind: 'forbidden' }
  if (response.status === 404) return { kind: 'not_found' }
  if (response.status === 409) {
    const code = extractErrorCode(await safeJson(response))
    return code ? { kind: 'conflict', code } : { kind: 'error', status: 409 }
  }
  if (response.status === 422) {
    const code = extractErrorCode(await safeJson(response))
    if (code === 'ORG_MISSING') return { kind: 'org_missing' }
    return code ? { kind: 'validation', code } : { kind: 'error', status: 422 }
  }
  return { kind: 'error', status: response.status }
}

// ---- 3.1 PATCH /api/tasks/:id/parent --------------------------------------------------------

export type SetParentResult =
  | { kind: 'ok'; id: string; parentId: string | null; depth: number }
  | WriteFailure

function isSetParentOk(value: unknown): value is { id: string; parentId: string | null; depth: number } {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && isNullableString(record.parentId) && isFiniteNumber(record.depth)
}

/** `parentId: null` clears the parent (`validateClearParent`); a string sets it
 *  (`validateSetParent`). Codes per §3.1: `INVALID_PARENT` (self/descendant/not-found-as-422 —
 *  the contract folds the pure function's `not_found` into a plain 404, so `INVALID_PARENT` here
 *  is only `self`/`descendant`), `DEPTH_EXCEEDED`. A `noop: true` pure-function result is still an
 *  HTTP 200 per the contract, indistinguishable from a real move at this layer. */
export async function setParent(id: string, parentId: string | null): Promise<SetParentResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  let response: Response
  try {
    response = await apiFetch(`/api/tasks/${encodeURIComponent(id)}/parent`, {
      method: 'PATCH',
      body: JSON.stringify({ parentId }),
    })
  } catch {
    return { kind: 'error', status: 0 }
  }
  if (response.status !== 200) return classifyWriteFailure(response)
  const body = await safeJson(response)
  if (isSetParentOk(body)) return { kind: 'ok', id: body.id, parentId: body.parentId, depth: body.depth }
  return { kind: 'error', status: response.status }
}

// ---- 3.3 assignees, 3.4 completion-mode ------------------------------------------------------

/** The shared success shape of `addAssignee`/`removeAssignee`/`setCompletionMode` (§3.3/§3.4):
 *  membership + completion state, NOT a full `TaskDetail` — no `parentId`/`children`/`canComplete`/
 *  `canReopen`. Callers that need those reload via `getTask` (this repo's chosen refetch policy —
 *  see the M3 frontend design doc — because removing yourself as an assignee can change YOUR OWN
 *  `canComplete`/`canReopen`, which this response does not carry). */
export interface MembershipState {
  id: string
  status: TaskStatus
  completionMode: CompletionMode
  assignees: TaskAssignee[]
}

function isMembershipState(value: unknown): value is MembershipState {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string') return false
  if (record.status !== 'open' && record.status !== 'done') return false
  if (record.completionMode !== 'all' && record.completionMode !== 'any') return false
  if (!Array.isArray(record.assignees) || !record.assignees.every(isTaskAssignee)) return false
  return true
}

export type MembershipResult = { kind: 'ok'; task: MembershipState } | WriteFailure

async function membershipCall(response: Response): Promise<MembershipResult> {
  if (response.status !== 200) return classifyWriteFailure(response)
  const body = await safeJson(response)
  if (isMembershipState(body)) return { kind: 'ok', task: body }
  return { kind: 'error', status: response.status }
}

/** `POST /api/tasks/:id/assignees` — `INVALID_ASSIGNEES` (id not printable) or `LIMIT` (>50)
 *  per §3.3. Already-an-assignee is a `noop`, still 200. */
export async function addAssignee(id: string, userId: string): Promise<MembershipResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  if (!isPathSafeSegment(userId)) return { kind: 'validation', code: 'INVALID_ASSIGNEES' }
  let response: Response
  try {
    response = await apiFetch(`/api/tasks/${encodeURIComponent(id)}/assignees`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    })
  } catch {
    return { kind: 'error', status: 0 }
  }
  return membershipCall(response)
}

/** `DELETE /api/tasks/:id/assignees/:userId` — no request body. Not-an-assignee is a `noop`,
 *  still 200. */
export async function removeAssignee(id: string, userId: string): Promise<MembershipResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  if (!isPathSafeSegment(userId)) return { kind: 'validation', code: 'INVALID_ASSIGNEES' }
  let response: Response
  try {
    response = await apiFetch(
      `/api/tasks/${encodeURIComponent(id)}/assignees/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    )
  } catch {
    return { kind: 'error', status: 0 }
  }
  return membershipCall(response)
}

/** `PATCH /api/tasks/:id/completion-mode` — `INVALID_MODE` for anything other than
 *  `'all'`/`'any'` per §3.4. Same mode as current is a `noop`, still 200. */
export async function setCompletionMode(id: string, completionMode: CompletionMode): Promise<MembershipResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  let response: Response
  try {
    response = await apiFetch(`/api/tasks/${encodeURIComponent(id)}/completion-mode`, {
      method: 'PATCH',
      body: JSON.stringify({ completionMode }),
    })
  } catch {
    return { kind: 'error', status: 0 }
  }
  return membershipCall(response)
}

// ---- 3.5 followers / leave --------------------------------------------------------------------

/** The shared success shape of `addFollower`/`removeFollower`/`leaveTask` (§3.5). This is the
 *  ONLY place the frontend ever learns the follower list — `GET /api/tasks/:id` does not carry
 *  it (M3 contract §3.2 lists only `parentId`/`depth`/`children` as new detail fields). See the
 *  M3 frontend design doc for how the UI handles that "no initial state" gap. */
export interface FollowersState {
  id: string
  followers: string[]
}

function isFollowersState(value: unknown): value is FollowersState {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && Array.isArray(record.followers)
    && record.followers.every((entry) => typeof entry === 'string')
}

export type FollowersResult = { kind: 'ok'; task: FollowersState } | WriteFailure

async function followersCall(response: Response): Promise<FollowersResult> {
  if (response.status !== 200) return classifyWriteFailure(response)
  const body = await safeJson(response)
  if (isFollowersState(body)) return { kind: 'ok', task: body }
  return { kind: 'error', status: response.status }
}

/** `POST /api/tasks/:id/followers` — `INVALID_ASSIGNEES` / `LIMIT`, same codes as assignees
 *  per §3.5. Already-a-follower is a `noop`, still 200. */
export async function addFollower(id: string, userId: string): Promise<FollowersResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  if (!isPathSafeSegment(userId)) return { kind: 'validation', code: 'INVALID_ASSIGNEES' }
  let response: Response
  try {
    response = await apiFetch(`/api/tasks/${encodeURIComponent(id)}/followers`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    })
  } catch {
    return { kind: 'error', status: 0 }
  }
  return followersCall(response)
}

/** `DELETE /api/tasks/:id/followers/:userId` — removing SOMEONE ELSE; requires `edit`, not just
 *  `leave`. Not-a-follower is a `noop`, still 200. */
export async function removeFollower(id: string, userId: string): Promise<FollowersResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  if (!isPathSafeSegment(userId)) return { kind: 'validation', code: 'INVALID_ASSIGNEES' }
  let response: Response
  try {
    response = await apiFetch(
      `/api/tasks/${encodeURIComponent(id)}/followers/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    )
  } catch {
    return { kind: 'error', status: 0 }
  }
  return followersCall(response)
}

/** `POST /api/tasks/:id/leave` — no request body; the caller removes THEMSELVES. Per §3.5 the
 *  `leave` ability is follower-only — a non-follower calling this gets a plain 404 (`not_found`),
 *  same as every other invisible-to-the-caller action in this contract. */
export async function leaveTask(id: string): Promise<FollowersResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  let response: Response
  try {
    response = await apiFetch(`/api/tasks/${encodeURIComponent(id)}/leave`, { method: 'POST' })
  } catch {
    return { kind: 'error', status: 0 }
  }
  return followersCall(response)
}

// ---- 3.6 comments -------------------------------------------------------------------------

/** `toCommentView`'s shape (§3.6). A tombstone has `deleted: true` and `body: null`; a live
 *  comment has `deleted: false` and a non-null `body`. */
export interface Comment {
  id: string
  taskId: string
  authorId: string
  body: string | null
  deleted: boolean
  createdAt: string
}

function isComment(value: unknown): value is Comment {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string') return false
  if (typeof record.taskId !== 'string') return false
  if (typeof record.authorId !== 'string') return false
  if (!isNullableString(record.body)) return false
  if (typeof record.deleted !== 'boolean') return false
  if (typeof record.createdAt !== 'string') return false
  // A tombstone's `body` must be `null` and a live comment's must be a string — the CHECK
  // constraint's own invariant (§4: "墓碑 CHECK"), re-verified client-side so a malformed body
  // can never render as either a real comment or a trustworthy tombstone.
  if (record.deleted && record.body !== null) return false
  if (!record.deleted && record.body === null) return false
  return true
}

/** `GET /api/tasks/:id/comments`'s result kinds — deliberately NOT a write's `WriteFailure`,
 *  the SAME reasoning `GetTaskResult` documents for `getTask`: this is a READ, and per §3.6 its
 *  only failure the contract names is a plain 404 (not visible / not found / another org — never
 *  distinguished). No `org_missing`, no `validation`, no `conflict`. */
export type ListCommentsResult =
  | { kind: 'ok'; items: Comment[]; total: number }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'error'; status?: number }

/** The server's page size cap for comments (§3.6: `limit` 1..100, default 100). */
export const COMMENTS_PAGE_LIMIT = 100
/** Upper bound on pages one `listComments` call reads. A thread longer than
 *  `COMMENTS_PAGE_LIMIT * COMMENTS_MAX_PAGES` resolves with `items.length < total`, which the
 *  caller must surface rather than present the partial list as the whole thread. */
export const COMMENTS_MAX_PAGES = 20

async function fetchCommentsPage(id: string, offset: number): Promise<ListCommentsResult> {
  let response: Response
  try {
    response = await apiFetch(
      `/api/tasks/${encodeURIComponent(id)}/comments?limit=${COMMENTS_PAGE_LIMIT}&offset=${offset}`,
    )
  } catch {
    return { kind: 'error', status: 0 }
  }
  if (response.status === 403) return { kind: 'forbidden' }
  if (response.status === 404) return { kind: 'not_found' }
  if (response.status !== 200) return { kind: 'error', status: response.status }

  const body = await safeJson(response)
  if (!body || typeof body !== 'object') return { kind: 'error', status: response.status }
  const { items, total } = body as Record<string, unknown>
  if (!Array.isArray(items) || !items.every(isComment)) return { kind: 'error', status: response.status }
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
    return { kind: 'error', status: response.status }
  }
  return { kind: 'ok', items, total }
}

/** `GET /api/tasks/:id/comments`. The server pages this read (oldest first, 100 per page), so one
 *  request is only the OLDEST page: this reads page after page until it holds `total` comments.
 *  Any page failing fails the whole read — a partial thread is never returned as `ok` except at
 *  the `COMMENTS_MAX_PAGES` bound, where `items.length < total` says so. */
export async function listComments(id: string): Promise<ListCommentsResult> {
  const items: Comment[] = []
  let total = 0
  for (let page = 0; page < COMMENTS_MAX_PAGES; page += 1) {
    const result = await fetchCommentsPage(id, items.length)
    if (result.kind !== 'ok') return result
    items.push(...result.items)
    total = result.total
    if (result.items.length === 0 || items.length >= total) break
  }
  return { kind: 'ok', items, total: Math.max(total, items.length) }
}

export type CommentActionResult = { kind: 'ok'; comment: Comment } | WriteFailure

async function commentActionCall(response: Response): Promise<CommentActionResult> {
  if (response.status !== 200) return classifyWriteFailure(response)
  const body = await safeJson(response)
  if (isComment(body)) return { kind: 'ok', comment: body }
  return { kind: 'error', status: response.status }
}

/** `POST /api/tasks/:id/comments` — `COMMENT_BLANK` / `COMMENT_TOO_LONG` per §3.6's
 *  `normalizeCommentBody`. See `checkCommentBody` below for the client-side pre-check that
 *  mirrors these same two codes without a round trip. */
export async function createComment(id: string, body: string): Promise<CommentActionResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  let response: Response
  try {
    response = await apiFetch(`/api/tasks/${encodeURIComponent(id)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    })
  } catch {
    return { kind: 'error', status: 0 }
  }
  return commentActionCall(response)
}

/** `PATCH /api/tasks/:id/comments/:commentId` — `canEditComment` false (not the author, or
 *  already a tombstone) is a plain 404 per §3.6, same as every other invisible-to-the-caller
 *  write in this contract; validation codes are the same two as `createComment`. */
export async function editComment(id: string, commentId: string, body: string): Promise<CommentActionResult> {
  if (!isPathSafeSegment(id) || !isPathSafeSegment(commentId)) return { kind: 'not_found' }
  let response: Response
  try {
    response = await apiFetch(
      `/api/tasks/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
      { method: 'PATCH', body: JSON.stringify({ body }) },
    )
  } catch {
    return { kind: 'error', status: 0 }
  }
  return commentActionCall(response)
}

/** `DELETE /api/tasks/:id/comments/:commentId` — no request body. Success returns the
 *  tombstone-shaped `Comment` (§3.6: "成功 200 返回墓碑形的 Comment"). `canDeleteComment` false is
 *  a plain 404, same as `editComment`. */
export async function deleteComment(id: string, commentId: string): Promise<CommentActionResult> {
  if (!isPathSafeSegment(id) || !isPathSafeSegment(commentId)) return { kind: 'not_found' }
  let response: Response
  try {
    response = await apiFetch(
      `/api/tasks/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
      { method: 'DELETE' },
    )
  } catch {
    return { kind: 'error', status: 0 }
  }
  return commentActionCall(response)
}

/** Client-side pre-check mirroring the backend's `normalizeCommentBody` (§3.6), which NFC-normalizes
 *  and trims edge whitespace and zero-width marks BEFORE measuring: blank after that -> `'COMMENT_BLANK'`; over 5000
 *  UNICODE CODE POINTS of the normalized text (NOT UTF-16 code units — `[...]` spreads by code
 *  point, so astral-plane characters, e.g. emoji, are not double-counted as surrogate pairs) ->
 *  `'COMMENT_TOO_LONG'`; otherwise `'ok'`. Measuring the raw input instead would reject bodies the
 *  server accepts (trailing newline, decomposed accents). This is an OPTIMIZATION ONLY — it saves a round trip
 *  for the obvious cases and lets the same two codes drive the SAME inline-message mapping the
 *  server's own `validation` result would — never a substitute for the server's check: a caller
 *  still submits through `createComment`/`editComment`, whose 422 `validation` result is the
 *  actual source of truth. */
const COMMENT_EDGE_TRIM_RE = /^[\p{White_Space}\u200B\u200C\u200D\uFEFF]+|[\p{White_Space}\u200B\u200C\u200D\uFEFF]+$/gu

export function checkCommentBody(body: string): 'ok' | 'COMMENT_BLANK' | 'COMMENT_TOO_LONG' {
  // Same steps as the server's normalizeUserText: NFC, trim Unicode White_Space and the four
  // zero-width marks from both edges only, NFC again.
  const normalized = body.normalize('NFC').replace(COMMENT_EDGE_TRIM_RE, '').normalize('NFC')
  if (normalized.length === 0) return 'COMMENT_BLANK'
  if (Array.from(normalized).length > 5000) return 'COMMENT_TOO_LONG'
  return 'ok'
}

// ---- 3.7 DELETE /api/tasks/:id ----------------------------------------------------------------

export type DeleteTaskResult = { kind: 'ok'; id: string; deleted: true } | WriteFailure

function isDeleteTaskOk(value: unknown): value is { id: string; deleted: true } {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && record.deleted === true
}

/** `DELETE /api/tasks/:id` — §3.7's `has_children` reason maps to 409 `HAS_CHILDREN` (handled by
 *  `classifyWriteFailure`'s `conflict` kind); `not_found`/`forbidden` both fold into the plain 404
 *  this contract uses everywhere else. Does not cascade — the caller must delete children first. */
export async function deleteTask(id: string): Promise<DeleteTaskResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  let response: Response
  try {
    response = await apiFetch(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch {
    return { kind: 'error', status: 0 }
  }
  if (response.status !== 200) return classifyWriteFailure(response)
  const body = await safeJson(response)
  if (isDeleteTaskOk(body)) return { kind: 'ok', id: body.id, deleted: true }
  return { kind: 'error', status: response.status }
}
