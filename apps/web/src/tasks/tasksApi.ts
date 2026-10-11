/**
 * Task-feature-line frontend API client: M2 (design lock §5.2 / §5.2.1, backend #6062), M3
 * (backend #6229) and the M4 additions further down (the PR-3a branch's routes, not on main yet).
 *
 * Typed wrappers over the `TASKS_ENABLED`-gated `/api/tasks*`, `/api/task-lists*`,
 * `/api/task-groups*` and `/api/task-settings` endpoints, using the SAME authenticated `apiFetch`
 * helper every other view uses — no bespoke transport, no mock short-circuit: the real endpoint is
 * always asked, in development and tests too.
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
   *  own check remains the only gate. `canEdit` covers completion mode, parent and the M4 editor
   *  (and, in a body without `canManageMembers`, the assignee / follower controls too);
   *  `canComment` covers posting, and editing or deleting one's own comment. */
  canEdit?: boolean
  canDelete?: boolean
  canComment?: boolean
  /** M4 (PR-3a; ruled 2026-10-07): whether the viewer may add or remove assignees and followers —
   *  true exactly for the task's creator and its assignees (a direct role); a viewer who can edit
   *  the task only through a list is `canEdit: true, canManageMembers: false`. The PR-3a backend
   *  always sends it; main's M3 body does not, and there the member controls follow `canEdit`
   *  (see TasksView). */
  canManageMembers?: boolean
  /** The row version `patchTask` sends back as `expectedVersion`; a positive integer when present.
   *  main's M3 backend (#6229) sends it as well, so its presence does not say the backend has
   *  `PATCH /api/tasks/:id` — the S4 group below does. */
  version?: number
  /** M4 (PR-3a S4). These four are a GROUP like the M3 tree fields: a body with any of them
   *  carries all four (each `string | null`); a body with none is the pre-S4 shape. They arrive
   *  with `PATCH /api/tasks/:id`, so the editor renders only for a body that carries them. */
  description?: string | null
  /** `'YYYY-MM-DD'`, same wall-clock reading as `dueDate`. */
  startDate?: string | null
  /** `'HH:MM:SS'`, same reading as `dueTime`. */
  startTime?: string | null
  /** An ISO instant, or `null` for no reminder. */
  remindAt?: string | null
  /** M4 (PR-3a S7): ids of the lists holding this task — every such list for the task's creator,
   *  the viewer's own lists for anyone else. Always sent from S7 on; absent from an older body. */
  listIds?: string[]
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
  /** `total` (M4, PR-3a S3) is present when the body carries it as a non-negative integer and
   *  absent otherwise; a body with a malformed `total` is an `error`. */
  | { kind: 'ok'; items: TaskListItem[]; total?: number }
  | { kind: 'predicate_error' }
  | { kind: BaseResultKind; status?: number }

export interface CreateTaskInput {
  title: string
  /** Omitted entirely (not sent) when undefined — per lock §4.2, an OMITTED `assignees` field
   *  inserts the creator as the sole assignee, while an explicit `[]` means zero assignees. Callers
   *  that want "no assignees" must pass `[]` explicitly; they are not the same request body. */
  assignees?: string[]
  completionMode?: CompletionMode
  /** M4 (PR-3a S4) — the date keys `POST /api/tasks` accepts. Each is sent only when given; the
   *  create form does not set them in this slice (design §12-Q3, `[fe-09]`). */
  dueDate?: string | null
  dueTime?: string | null
  startDate?: string | null
  startTime?: string | null
  timeZone?: string | null
  remindAt?: string | null
}

/** The 422 codes `createTask` reports as `validation` (design §3.2, an allowlist). Any other 422
 *  code stays `{ kind: 'error', status: 422 }`, the M2 reading (tasks-api.spec.ts pins
 *  `VALIDATION_FAILED` that way). */
export const CREATE_TASK_VALIDATION_CODES = [
  'INVALID_DATE',
  'INVALID_TIME_ZONE',
  'TIME_ZONE_REQUIRED',
  'INVALID_REMIND_AT',
  'INVALID_ASSIGNEES',
  'INVALID_MODE',
  'INACTIVE_ORG_MEMBER',
  'LIMIT',
] as const
export type CreateTaskValidationCode = (typeof CREATE_TASK_VALIDATION_CODES)[number]

/** The backend's `POST /api/tasks` 200 body is contracted to carry only `{ id: string }` — it does
 *  NOT echo back the full row (no `status`/`completion_mode`/`created_by`/`due_at`). Typing the ok
 *  result as a full `TaskListItem` (as this used to) let `createTask` blindly cast whatever the 200
 *  body happened to be, so a malformed or partial body would silently masquerade as a real task
 *  row instead of failing. Every caller only needs the new id (to keep it or ignore it) — the
 *  fresh row itself always comes from the subsequent `loadList()`. */
export type CreateTaskResult =
  /** `version` (M4, PR-3a S4) is present when the body carries it as a positive integer. */
  | { kind: 'ok'; id: string; version?: number }
  | { kind: 'invalid_title' }
  | { kind: 'validation'; code: CreateTaskValidationCode }
  | { kind: BaseResultKind; status?: number }

export type CompleteTaskResult =
  | { kind: 'ok'; done: boolean }
  | { kind: BaseResultKind; status?: number }

export type ReopenTaskResult =
  | { kind: 'ok' }
  | { kind: BaseResultKind; status?: number }

export type PendingCountResult =
  /** `badgeScope: 'off'` (M4, PR-3a S3) is present exactly when the body says `'off'` with a zero
   *  count; see `fetchPendingCount`. */
  | { kind: 'ok'; count: number; badgeScope?: 'off' }
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

/** The browser's IANA zone name, or `''` when the platform does not report one. Read fresh on
 *  every call. Exported since M4 for the settings page and the detail editor's default zone. */
export function resolveViewerTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' ? zone : ''
  } catch {
    return ''
  }
}

/** `GET /api/tasks?view=…`. Without `page` the request string is the M2 one; with it, the M4
 *  page parameters are appended (`limit` fixed at `TASK_PAGE_LIMIT`). The views call it without
 *  `page`; `total` is parsed but not used (`[fe-10]`). */
export async function listTasks(view: TaskView, page?: { offset: number }): Promise<ListTasksResult> {
  const query = page === undefined ? '' : `&limit=${TASK_PAGE_LIMIT}&offset=${page.offset}`
  let response: Response
  try {
    response = await apiFetch(`/api/tasks?view=${encodeURIComponent(view)}${query}`)
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

  if (!Array.isArray(record.items)) return { kind: 'error', status: response.status }
  const items = record.items as TaskListItem[]
  if (record.total === undefined) return { kind: 'ok', items }
  if (!isNonNegativeInteger(record.total)) return { kind: 'error', status: response.status }
  return { kind: 'ok', items, total: record.total }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/** A positive safe integer: a row `version`, a 409 body's `currentVersion`. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/** A non-negative safe integer: a collection `total`, a placement `position`. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
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
 *  the M2 shape (the M2 backend) and parses as a root task with no visible children; a body with
 *  any of them must carry all three, each with the right type. The optional `followers`/`canLeave`/
 *  `canEdit`/`canDelete`/`canComment`/`canManageMembers` are validated only when present. */
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
  for (const flag of ['canEdit', 'canDelete', 'canComment', 'canManageMembers'] as const) {
    if (record[flag] === undefined) continue
    if (typeof record[flag] !== 'boolean') return null
    detail[flag] = record[flag]
  }
  // M4 keys (design §3.2 `getTask`): each optional, each checked when present; the four edit
  // fields are a group — any one present means all four must be, each `string | null`.
  if (record.version !== undefined) {
    if (!isPositiveInteger(record.version)) return null
    detail.version = record.version
  }
  const editFields = ['description', 'startDate', 'startTime', 'remindAt'] as const
  if (editFields.some((field) => record[field] !== undefined)) {
    if (!isNullableString(record.description)) return null
    if (!isNullableString(record.startDate)) return null
    if (!isNullableString(record.startTime)) return null
    if (!isNullableString(record.remindAt)) return null
    detail.description = record.description
    detail.startDate = record.startDate
    detail.startTime = record.startTime
    detail.remindAt = record.remindAt
  }
  if (record.listIds !== undefined) {
    if (!Array.isArray(record.listIds) || !record.listIds.every((id) => typeof id === 'string')) return null
    detail.listIds = record.listIds
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
  // M4 date keys: the same "absent is not sent" rule.
  for (const key of ['dueDate', 'dueTime', 'startDate', 'startTime', 'timeZone', 'remindAt'] as const) {
    if (input[key] !== undefined) body[key] = input[key]
  }

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
    const code = extractErrorCode(errorBody)
    if (code === 'ORG_MISSING') return { kind: 'org_missing' }
    // Deterministic: retrying the same title fails the same way, so the caller says so.
    if (code === 'INVALID_TITLE') return { kind: 'invalid_title' }
    if (code !== null && (CREATE_TASK_VALIDATION_CODES as readonly string[]).includes(code)) {
      return { kind: 'validation', code: code as CreateTaskValidationCode }
    }
    return { kind: 'error', status: 422 }
  }
  if (response.status !== 200) return { kind: 'error', status: response.status }

  const okBody = await safeJson(response)
  if (okBody && typeof okBody === 'object' && typeof (okBody as Record<string, unknown>).id === 'string') {
    const { id, version } = okBody as Record<string, unknown>
    if (version === undefined) return { kind: 'ok', id: id as string }
    if (!isPositiveInteger(version)) return { kind: 'error', status: response.status }
    return { kind: 'ok', id: id as string, version }
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

  if (!isCountLike(record.count)) return { kind: 'error', status: response.status }
  // ASSUMPTION(task-m4-fe): [own-11] (PR-3a) — the key appears only with `'off'`. Read with
  // tolerance (`[fe-14]`): only the literal `'off'` has a meaning, and it must come with a zero
  // count; the key absent, another closed-set value, or any other value reads as a plain count.
  if (record.badgeScope === 'off') {
    if (record.count !== 0) return { kind: 'error', status: response.status }
    return { kind: 'ok', count: 0, badgeScope: 'off' }
  }
  return { kind: 'ok', count: record.count }
}

/*
 * ---------------------------------------------------------------------------------------------
 * M3 additions (backend contract `docs/development/task-m3-backend-design-20260928.md`, §3.1,
 * §3.3–§3.7; the backend is on main, #6229). Tests mock `apiFetch`. The PR-3a branch adds a 422
 * `INACTIVE_ORG_MEMBER` to the assignee / follower adds (an inactive or foreign user, R17) and
 * answers the four assignee / follower writes 404 for a viewer without a direct role on the task
 * (the detail's `canManageMembers`); both go through the mapping below unchanged.
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

/** Whether an id can be placed in a request URL path: it must be non-empty and not `.` or `..`.
 *  Other ids are refused before any request is built. */
export function isPathSafeSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..'
}

export type WriteFailure =
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'org_missing' }
  | { kind: 'validation'; code: string }
  /** `currentVersion` (M4, `PATCH /api/tasks/:id` 409 `VERSION_CONFLICT`) is present when the 409
   *  body carries it as a positive integer; a caller without it treats the conflict as one whose
   *  version is unknown and reloads the same way. */
  | { kind: 'conflict'; code: string; currentVersion?: number }
  | { kind: 'error'; status?: number }

/** Shared non-2xx classifier for every M3 / M4 write endpoint — see the module-level note above
 *  for the full mapping. Only called once `response.status` is confirmed not to be a success. */
async function classifyWriteFailure(response: Response): Promise<WriteFailure> {
  if (response.status === 403) return { kind: 'forbidden' }
  if (response.status === 404) return { kind: 'not_found' }
  if (response.status === 409) {
    const body = await safeJson(response)
    const code = extractErrorCode(body)
    if (!code) return { kind: 'error', status: 409 }
    const currentVersion = (body as Record<string, unknown>).currentVersion
    return isPositiveInteger(currentVersion) ? { kind: 'conflict', code, currentVersion } : { kind: 'conflict', code }
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
 *  the `COMMENTS_MAX_PAGES` bound, where `items.length < total` says so.
 *
 *  The offset advances by ROWS READ, not by distinct comments: a comment committed between two
 *  page reads can sort ahead of rows already read and push one of them onto the next page, so a
 *  row may arrive twice — it is kept once, by id. `isSuperseded` lets a caller whose result will be
 *  discarded (a newer read started) stop the remaining page requests; the partial result it gets
 *  back must not be rendered. */
export async function listComments(
  id: string,
  options: { isSuperseded?: () => boolean } = {},
): Promise<ListCommentsResult> {
  const items: Comment[] = []
  const seen = new Set<string>()
  let rowsRead = 0
  let total = 0
  for (let page = 0; page < COMMENTS_MAX_PAGES; page += 1) {
    const result = await fetchCommentsPage(id, rowsRead)
    if (result.kind !== 'ok') return result
    rowsRead += result.items.length
    for (const item of result.items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
    }
    total = result.total
    if (result.items.length === 0 || rowsRead >= total) break
    if (options.isSuperseded?.()) break
  }
  return { kind: 'ok', items, total: Math.max(total, rowsRead) }
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

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

export function checkCommentBody(body: string): 'ok' | 'COMMENT_BLANK' | 'COMMENT_TOO_LONG' | 'COMMENT_INVALID_CHAR' {
  // Same steps as the server's normalizeUserText: NFC, trim Unicode White_Space and the four
  // zero-width marks from both edges only, NFC again.
  const normalized = body.normalize('NFC').replace(COMMENT_EDGE_TRIM_RE, '').normalize('NFC')
  if (normalized.length === 0) return 'COMMENT_BLANK'
  if (Array.from(normalized).length > 5000) return 'COMMENT_TOO_LONG'
  // The server rejects U+0000 and lone UTF-16 surrogates after the two checks above, in the same
  // order (contract §3.6).
  if (normalized.includes('\u0000') || LONE_SURROGATE_RE.test(normalized)) return 'COMMENT_INVALID_CHAR'
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

/*
 * ---------------------------------------------------------------------------------------------
 * M4 additions (frontend design `docs/development/task-m4-frontend-design-20261007.md` §3;
 * backend contract PR-3a `task-m4-pr3a-backend-design-20260930.md` §3 and its verification
 * record). Every route below is built on the PR-3a branch — settings (S3), `PATCH /api/tasks/:id`
 * (S4), lists (S5), list members (S6), list items (S7), groups (S8); PR-3a also adds the detail's
 * `canManageMembers` and (S9) the 422 `INACTIVE_ORG_MEMBER` of the task create and the assignee /
 * follower adds — and none is on main yet. Tests mock `apiFetch`.
 *
 * Rules shared by every function below (design §3.1):
 *   - every id placed in a request path passes `isPathSafeSegment` before a request is built — a
 *     task / list / group id that fails is `not_found`, a user id that fails is `validation` with
 *     that endpoint's own member code;
 *   - write failures go through `classifyWriteFailure` (409 now carries `currentVersion`);
 *   - every success body passes a strict parser (every field checked, closed sets compared
 *     literal by literal, unknown keys ignored, a missing or mistyped field is `error`);
 *   - collection reads are `{ items, total }` with `limit` fixed at `TASK_PAGE_LIMIT` and the
 *     offset supplied by the caller; the degraded body (no `total`) is checked first; a 422
 *     (`INVALID_LIMIT` / `INVALID_OFFSET` / `INVALID_FILTER`) can only be contract drift and is
 *     `error`; "read every page" functions share `collectPages`.
 * ---------------------------------------------------------------------------------------------
 */

// RULED(2026-10-07): [R15] — the page size every M4 collection endpoint is read with (the
// server's upper bound) and the offset form.
export const TASK_PAGE_LIMIT = 100
/** Upper bound on pages one "read every page" call makes; past it the result has
 *  `items.length < total`. The value follows `COMMENTS_MAX_PAGES` (`[fe-13]`). */
export const TASK_MAX_PAGES = 20

/** Result of every M4 collection read. `org_missing` is the degraded body; a 404 is
 *  `not_found` (the list-scoped reads fold a missing org into it as well). */
export type CollectionResult<T> =
  | { kind: 'ok'; items: T[]; total: number }
  | { kind: 'org_missing' }
  | { kind: 'forbidden' }
  | { kind: 'not_found' }
  | { kind: 'error'; status?: number }

/** One page of a collection endpoint. */
async function readCollection<T>(path: string, isItem: (value: unknown) => value is T): Promise<CollectionResult<T>> {
  let response: Response
  try {
    response = await apiFetch(path)
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
  if (!Array.isArray(record.items) || !record.items.every(isItem)) return { kind: 'error', status: response.status }
  if (!isNonNegativeInteger(record.total)) return { kind: 'error', status: response.status }
  return { kind: 'ok', items: record.items, total: record.total }
}

/** Reads page after page (the `listComments` loop): the offset advances by rows read, a row seen
 *  twice is kept once by key, an empty page or `rowsRead >= total` ends the read, `isSuperseded`
 *  ends it early, `TASK_MAX_PAGES` bounds it. Any page failing fails the whole read. */
async function collectPages<T>(
  fetchPage: (offset: number) => Promise<CollectionResult<T>>,
  keyOf: (item: T) => string,
  options: { isSuperseded?: () => boolean } = {},
): Promise<CollectionResult<T>> {
  const items: T[] = []
  const seen = new Set<string>()
  let rowsRead = 0
  let total = 0
  for (let page = 0; page < TASK_MAX_PAGES; page += 1) {
    const result = await fetchPage(rowsRead)
    if (result.kind !== 'ok') return result
    rowsRead += result.items.length
    for (const item of result.items) {
      const key = keyOf(item)
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
    total = result.total
    if (result.items.length === 0 || rowsRead >= total) break
    if (options.isSuperseded?.()) break
  }
  return { kind: 'ok', items, total: Math.max(total, rowsRead) }
}

/** Options of every "read every page" function. */
export interface ReadAllOptions {
  isSuperseded?: () => boolean
}

function pageQuery(offset: number): string {
  return `limit=${TASK_PAGE_LIMIT}&offset=${offset}`
}

function listPath(listId: string, suffix = ''): string {
  return `/api/task-lists/${encodeURIComponent(listId)}${suffix}`
}

/** A write: `apiFetch` with the method and optional JSON body; a non-200 is classified, a 200
 *  hands its body (parsed, or `null`) to the caller's parser. */
async function sendWrite(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<{ ok: true; body: unknown; status: number } | { ok: false; failure: WriteFailure }> {
  let response: Response
  try {
    response = await apiFetch(path, body === undefined ? { method } : { method, body: JSON.stringify(body) })
  } catch {
    return { ok: false, failure: { kind: 'error', status: 0 } }
  }
  if (response.status !== 200) return { ok: false, failure: await classifyWriteFailure(response) }
  return { ok: true, body: await safeJson(response), status: response.status }
}

// ---- 3.2 tasks: PATCH /api/tasks/:id (S4) ---------------------------------------------------

/** The editable keys of `PATCH /api/tasks/:id`. A key that is `undefined` is not sent; `null`
 *  clears the field (`description` is cleared with `''`, the server stores it as NULL). */
export interface TaskPatch {
  title?: string
  description?: string
  dueDate?: string | null
  /** `'HH:MM'` — the client sends the minutes form; the server stores `'HH:MM:SS'`. */
  dueTime?: string | null
  startDate?: string | null
  startTime?: string | null
  /** An IANA zone name; `null` clears the zone (only accepted when no date remains). */
  timeZone?: string | null
  /** An ISO instant; `null` clears the reminder. Never derived by the server. */
  remindAt?: string | null
}

export const TASK_PATCH_KEYS = [
  'title',
  'description',
  'dueDate',
  'dueTime',
  'startDate',
  'startTime',
  'timeZone',
  'remindAt',
] as const
export type TaskPatchKey = (typeof TASK_PATCH_KEYS)[number]

export interface TaskPatchRequest extends TaskPatch {
  /** The detail's `version` at the time the draft was taken. */
  expectedVersion: number
}

export type PatchTaskResult = { kind: 'ok'; id: string; version: number } | WriteFailure

function isIdVersion(value: unknown): value is { id: string; version: number } {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && isPositiveInteger(record.version)
}

// RULED(2026-10-07): [R03] — edits go through `PATCH /api/tasks/:id` under `expectedVersion`;
// a stale version is a 409 `VERSION_CONFLICT` whose body also carries `currentVersion`.
/** `PATCH /api/tasks/:id`. Only the keys given in `patch` (plus `expectedVersion`) are
 *  serialized. Codes: `INVALID_VERSION` `INVALID_TITLE` `INVALID_DESCRIPTION` `INVALID_DATE`
 *  `INVALID_TIME_ZONE` `TIME_ZONE_REQUIRED` `INVALID_REMIND_AT` (422 `validation`),
 *  `VERSION_CONFLICT` (409 `conflict` with `currentVersion`). A body equal to the stored values is
 *  a no-op that still answers 200 with the unchanged version. */
export async function patchTask(id: string, patch: TaskPatchRequest): Promise<PatchTaskResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  const body: Record<string, unknown> = { expectedVersion: patch.expectedVersion }
  for (const key of TASK_PATCH_KEYS) {
    if (patch[key] !== undefined) body[key] = patch[key]
  }
  const sent = await sendWrite(`/api/tasks/${encodeURIComponent(id)}`, 'PATCH', body)
  if (!sent.ok) return sent.failure
  if (isIdVersion(sent.body)) return { kind: 'ok', id: sent.body.id, version: sent.body.version }
  return { kind: 'error', status: sent.status }
}

// ---- 3.2 settings (S3) -----------------------------------------------------------------------

export const TASK_BADGE_SCOPES = ['off', 'overdue', 'overdue_or_today'] as const
export type TaskBadgeScope = (typeof TASK_BADGE_SCOPES)[number]
export const TASK_REMIND_MODES = ['default', 'none'] as const
export type TaskRemindMode = (typeof TASK_REMIND_MODES)[number]

// RULED(2026-10-07): [R02] [R07] — the four settings fields and their shapes.
export interface TaskSettings {
  badgeScope: TaskBadgeScope
  dailyReminderEnabled: boolean
  defaultRemindPolicy: { mode: TaskRemindMode }
  /** A canonical IANA name, or `null` for none. */
  timeZone: string | null
}

/** The `GET /api/task-settings` 200 body, or `null` for a malformed one. Closed sets are compared
 *  literal by literal; keys outside the four are ignored. */
export function parseTaskSettings(value: unknown): TaskSettings | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.badgeScope !== 'string' || !(TASK_BADGE_SCOPES as readonly string[]).includes(record.badgeScope)) return null
  if (typeof record.dailyReminderEnabled !== 'boolean') return null
  const policy = record.defaultRemindPolicy
  if (!policy || typeof policy !== 'object') return null
  const mode = (policy as Record<string, unknown>).mode
  if (typeof mode !== 'string' || !(TASK_REMIND_MODES as readonly string[]).includes(mode)) return null
  if (!isNullableString(record.timeZone)) return null
  return {
    badgeScope: record.badgeScope as TaskBadgeScope,
    dailyReminderEnabled: record.dailyReminderEnabled,
    defaultRemindPolicy: { mode: mode as TaskRemindMode },
    timeZone: record.timeZone,
  }
}

export type GetTaskSettingsResult =
  | { kind: 'ok'; settings: TaskSettings }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'error'; status?: number }

/** `GET /api/task-settings`. A 404 covers both a missing route and a missing org (the contract
 *  does not distinguish them). */
export async function getTaskSettings(): Promise<GetTaskSettingsResult> {
  let response: Response
  try {
    response = await apiFetch('/api/task-settings')
  } catch {
    return { kind: 'error', status: 0 }
  }
  if (response.status === 403) return { kind: 'forbidden' }
  if (response.status === 404) return { kind: 'not_found' }
  if (response.status !== 200) return { kind: 'error', status: response.status }
  const settings = parseTaskSettings(await safeJson(response))
  return settings ? { kind: 'ok', settings } : { kind: 'error', status: response.status }
}

/** Any subset of `TaskSettings`; `timeZone: null` clears the zone; an `undefined` key is not
 *  sent. `badgeScope` and `defaultRemindPolicy` are never sent as `null`. */
export interface TaskSettingsPatch {
  badgeScope?: TaskBadgeScope
  dailyReminderEnabled?: boolean
  defaultRemindPolicy?: { mode: TaskRemindMode }
  timeZone?: string | null
}

export const TASK_SETTINGS_KEYS = ['badgeScope', 'dailyReminderEnabled', 'defaultRemindPolicy', 'timeZone'] as const

export type PatchTaskSettingsResult = { kind: 'ok'; settings: TaskSettings } | WriteFailure

/** `PATCH /api/task-settings`. Codes: `INVALID_SETTINGS` `INVALID_BADGE_SCOPE`
 *  `INVALID_DAILY_REMINDER_ENABLED` `INVALID_POLICY` `INVALID_TIME_ZONE`
 *  `DAILY_REMINDER_REQUIRES_TIME_ZONE` (422 `validation`). The 200 body is the merged settings. */
export async function patchTaskSettings(patch: TaskSettingsPatch): Promise<PatchTaskSettingsResult> {
  const body: Record<string, unknown> = {}
  for (const key of TASK_SETTINGS_KEYS) {
    if (patch[key] !== undefined) body[key] = patch[key]
  }
  const sent = await sendWrite('/api/task-settings', 'PATCH', body)
  if (!sent.ok) return sent.failure
  const settings = parseTaskSettings(sent.body)
  return settings ? { kind: 'ok', settings } : { kind: 'error', status: sent.status }
}

// ---- 3.2 lists (S5) --------------------------------------------------------------------------

export const TASK_LIST_ROLES = ['read', 'edit', 'owner'] as const
export type TaskListRole = (typeof TASK_LIST_ROLES)[number]
/** The roles a member can be given directly; `owner` only moves by transfer. */
export type TaskListAssignableRole = 'read' | 'edit'

function isTaskListRole(value: unknown): value is TaskListRole {
  return typeof value === 'string' && (TASK_LIST_ROLES as readonly string[]).includes(value)
}

export interface TaskList {
  id: string
  name: string
  createdBy: string
  /** The member holding `owner`; `null` only for a row without one. */
  ownerId: string | null
  /** ISO instant, or `null` while not archived. */
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  /** The caller's own role on this list. */
  myRole: TaskListRole
}

/** The `List` body of the list routes, or `null` for a malformed one. */
export function parseTaskList(value: unknown): TaskList | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string') return null
  if (typeof record.name !== 'string') return null
  if (typeof record.createdBy !== 'string') return null
  if (!isNullableString(record.ownerId)) return null
  if (!isNullableString(record.archivedAt)) return null
  if (typeof record.createdAt !== 'string') return null
  if (typeof record.updatedAt !== 'string') return null
  if (!isTaskListRole(record.myRole)) return null
  return {
    id: record.id,
    name: record.name,
    createdBy: record.createdBy,
    ownerId: record.ownerId,
    archivedAt: record.archivedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    myRole: record.myRole,
  }
}

function isTaskList(value: unknown): value is TaskList {
  return parseTaskList(value) !== null
}

export type TaskListWriteResult = { kind: 'ok'; list: TaskList } | WriteFailure

export type GetTaskListResult =
  | { kind: 'ok'; list: TaskList }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'error'; status?: number }

function taskListsPath(includeArchived: boolean, offset: number): string {
  return `/api/task-lists?includeArchived=${includeArchived ? 'true' : 'false'}&${pageQuery(offset)}`
}

/** `GET /api/task-lists` — one page of the caller's lists (`updatedAt` desc). The caller pages
 *  with `offset` until `items.length === total`. */
export async function listTaskLists(options: { includeArchived: boolean; offset: number }): Promise<CollectionResult<TaskList>> {
  return readCollection(taskListsPath(options.includeArchived, options.offset), isTaskList)
}

/** Every page of `GET /api/task-lists` (the detail page's "my lists" read, design §4.3). */
export async function listAllTaskLists(
  options: { includeArchived: boolean },
  readOptions: ReadAllOptions = {},
): Promise<CollectionResult<TaskList>> {
  return collectPages(
    (offset) => readCollection(taskListsPath(options.includeArchived, offset), isTaskList),
    (list) => list.id,
    readOptions,
  )
}

/** `POST /api/task-lists` `{ name }` — the caller becomes `owner`. Codes: `INVALID_NAME`
 *  `NAME_TOO_LONG` (422 `validation`). */
export async function createTaskList(name: string): Promise<TaskListWriteResult> {
  const sent = await sendWrite('/api/task-lists', 'POST', { name })
  if (!sent.ok) return sent.failure
  const list = parseTaskList(sent.body)
  return list ? { kind: 'ok', list } : { kind: 'error', status: sent.status }
}

/** `GET /api/task-lists/:id`. A missing list, another org's list and a list the caller is not a
 *  member of are the same 404. */
export async function getTaskList(id: string): Promise<GetTaskListResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  let response: Response
  try {
    response = await apiFetch(listPath(id))
  } catch {
    return { kind: 'error', status: 0 }
  }
  if (response.status === 403) return { kind: 'forbidden' }
  if (response.status === 404) return { kind: 'not_found' }
  if (response.status !== 200) return { kind: 'error', status: response.status }
  const list = parseTaskList(await safeJson(response))
  return list ? { kind: 'ok', list } : { kind: 'error', status: response.status }
}

/** `PATCH /api/task-lists/:id` `{ name }`. The same name is a no-op, still 200. Codes:
 *  `INVALID_NAME` `NAME_TOO_LONG`. */
export async function renameTaskList(id: string, name: string): Promise<TaskListWriteResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  const sent = await sendWrite(listPath(id), 'PATCH', { name })
  if (!sent.ok) return sent.failure
  const list = parseTaskList(sent.body)
  return list ? { kind: 'ok', list } : { kind: 'error', status: sent.status }
}

async function setTaskListArchived(id: string, segment: 'archive' | 'unarchive'): Promise<TaskListWriteResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  const sent = await sendWrite(listPath(id, `/${segment}`), 'POST')
  if (!sent.ok) return sent.failure
  const list = parseTaskList(sent.body)
  return list ? { kind: 'ok', list } : { kind: 'error', status: sent.status }
}

// RULED(2026-10-07): [R13] — lists are archived, never deleted; there is no delete call.
/** `POST /api/task-lists/:id/archive` — no body. Already archived is a no-op, still 200. */
export async function archiveTaskList(id: string): Promise<TaskListWriteResult> {
  return setTaskListArchived(id, 'archive')
}

/** `POST /api/task-lists/:id/unarchive` — no body. Not archived is a no-op, still 200. */
export async function unarchiveTaskList(id: string): Promise<TaskListWriteResult> {
  return setTaskListArchived(id, 'unarchive')
}

export interface TaskListEvent {
  id: string
  listId: string
  actorId: string
  /** A word of the server's closed set; the client checks only that it is a string and shows an
   *  unknown word as is. */
  eventType: string
  payload: unknown
  occurredAt: string
}

function isTaskListEvent(value: unknown): value is TaskListEvent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string') return false
  if (typeof record.listId !== 'string') return false
  if (typeof record.actorId !== 'string') return false
  if (typeof record.eventType !== 'string') return false
  if (record.payload === undefined) return false
  if (typeof record.occurredAt !== 'string') return false
  return true
}

/** `GET /api/task-lists/:id/events` — one page (`occurredAt` desc). */
export async function listTaskListEvents(id: string, options: { offset: number }): Promise<CollectionResult<TaskListEvent>> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  return readCollection(`${listPath(id, '/events')}?${pageQuery(options.offset)}`, isTaskListEvent)
}

// ---- 3.2 list members (S6) -------------------------------------------------------------------

export interface TaskListMember {
  userId: string
  role: TaskListRole
  createdAt: string
}

function isTaskListMember(value: unknown): value is TaskListMember {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.userId === 'string' && isTaskListRole(record.role) && typeof record.createdAt === 'string'
}

/** One row of a member write's `members` (no `createdAt`). */
export interface TaskListMembership {
  userId: string
  role: TaskListRole
}

function isTaskListMembership(value: unknown): value is TaskListMembership {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.userId === 'string' && isTaskListRole(record.role)
}

/** The shared success shape of the four member writes: the list id and the full member roster. */
export type TaskListMembersResult = { kind: 'ok'; id: string; members: TaskListMembership[] } | WriteFailure

function membersResult(sent: { ok: true; body: unknown; status: number }): TaskListMembersResult {
  const body = sent.body
  if (!body || typeof body !== 'object') return { kind: 'error', status: sent.status }
  const record = body as Record<string, unknown>
  if (typeof record.id !== 'string') return { kind: 'error', status: sent.status }
  if (!Array.isArray(record.members) || !record.members.every(isTaskListMembership)) return { kind: 'error', status: sent.status }
  return { kind: 'ok', id: record.id, members: record.members }
}

/** `GET /api/task-lists/:id/members`, every page (the member cap is one page). */
export async function listTaskListMembers(id: string, options: ReadAllOptions = {}): Promise<CollectionResult<TaskListMember>> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  return collectPages(
    (offset) => readCollection(`${listPath(id, '/members')}?${pageQuery(offset)}`, isTaskListMember),
    (member) => member.userId,
    options,
  )
}

// RULED(2026-10-07): [R12] — `owner` is never given directly; the creator cannot be removed;
// an owner transfers first.
// ASSUMPTION(task-m4-fe): [own-14] (PR-3a) — a member leaves through the same DELETE.
/** `POST /api/task-lists/:id/members` `{ userId, role }`. Codes: `INVALID_MEMBER` `INVALID_ROLE`
 *  `INACTIVE_ORG_MEMBER` `LIMIT`. Already a member is a no-op, still 200. */
export async function addTaskListMember(id: string, userId: string, role: TaskListAssignableRole): Promise<TaskListMembersResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  if (!isPathSafeSegment(userId)) return { kind: 'validation', code: 'INVALID_MEMBER' }
  const sent = await sendWrite(listPath(id, '/members'), 'POST', { userId, role })
  return sent.ok ? membersResult(sent) : sent.failure
}

/** `PATCH /api/task-lists/:id/members/:userId` `{ role }`. A target that is not a member is a
 *  plain 404. Codes: `INVALID_MEMBER` `INVALID_ROLE` `OWNER_MUST_TRANSFER`. */
export async function changeTaskListMemberRole(id: string, userId: string, role: TaskListAssignableRole): Promise<TaskListMembersResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  if (!isPathSafeSegment(userId)) return { kind: 'validation', code: 'INVALID_MEMBER' }
  const sent = await sendWrite(listPath(id, `/members/${encodeURIComponent(userId)}`), 'PATCH', { role })
  return sent.ok ? membersResult(sent) : sent.failure
}

/** `DELETE /api/task-lists/:id/members/:userId` — no body; the caller's own id means leaving.
 *  Codes: `INVALID_MEMBER` `CREATED_BY_IMMUTABLE` `OWNER_MUST_TRANSFER`. */
export async function removeTaskListMember(id: string, userId: string): Promise<TaskListMembersResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  if (!isPathSafeSegment(userId)) return { kind: 'validation', code: 'INVALID_MEMBER' }
  const sent = await sendWrite(listPath(id, `/members/${encodeURIComponent(userId)}`), 'DELETE')
  return sent.ok ? membersResult(sent) : sent.failure
}

/** `POST /api/task-lists/:id/transfer-owner` `{ userId }`. Codes: `INVALID_MEMBER`
 *  `TARGET_NOT_MEMBER` `INACTIVE_ORG_MEMBER`. The current owner as target is a no-op. */
export async function transferTaskListOwner(id: string, userId: string): Promise<TaskListMembersResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  if (!isPathSafeSegment(userId)) return { kind: 'validation', code: 'INVALID_MEMBER' }
  const sent = await sendWrite(listPath(id, '/transfer-owner'), 'POST', { userId })
  return sent.ok ? membersResult(sent) : sent.failure
}

// ---- 3.2 list items (S7) ---------------------------------------------------------------------

/** The strict form of a `TaskListItem` row (the list endpoints' snake_case six columns). */
function isTaskListItem(value: unknown): value is TaskListItem {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string') return false
  if (typeof record.title !== 'string') return false
  if (record.status !== 'open' && record.status !== 'done') return false
  if (record.completion_mode !== 'all' && record.completion_mode !== 'any') return false
  if (typeof record.created_by !== 'string') return false
  if (!isNullableString(record.due_at)) return false
  return true
}

/** `GET /api/task-lists/:id/items`, every page. Past `TASK_MAX_PAGES` the result has
 *  `items.length < total`. */
export async function listTaskListItems(id: string, options: ReadAllOptions = {}): Promise<CollectionResult<TaskListItem>> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  return collectPages(
    (offset) => readCollection(`${listPath(id, '/items')}?${pageQuery(offset)}`, isTaskListItem),
    (item) => item.id,
    options,
  )
}

export type TaskListItemResult = { kind: 'ok'; listId: string; taskId: string } | WriteFailure

function listItemResult(sent: { ok: true; body: unknown; status: number }): TaskListItemResult {
  const body = sent.body
  if (!body || typeof body !== 'object') return { kind: 'error', status: sent.status }
  const record = body as Record<string, unknown>
  if (typeof record.listId !== 'string' || typeof record.taskId !== 'string') return { kind: 'error', status: sent.status }
  return { kind: 'ok', listId: record.listId, taskId: record.taskId }
}

// RULED(2026-10-07): [own-25] (PR-3a, R12 (a1)) — adding needs a direct role on the task; the
// 404 folds the three conditions together.
/** `POST /api/task-lists/:id/items` `{ taskId }`. Codes: `INVALID_TASK` `LIMIT`. Already in the
 *  list is a no-op, still 200. */
export async function addTaskToList(id: string, taskId: string): Promise<TaskListItemResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  const sent = await sendWrite(listPath(id, '/items'), 'POST', { taskId })
  return sent.ok ? listItemResult(sent) : sent.failure
}

/** `DELETE /api/task-lists/:id/items/:taskId` — no body. */
export async function removeTaskFromList(id: string, taskId: string): Promise<TaskListItemResult> {
  if (!isPathSafeSegment(id) || !isPathSafeSegment(taskId)) return { kind: 'not_found' }
  const sent = await sendWrite(listPath(id, `/items/${encodeURIComponent(taskId)}`), 'DELETE')
  return sent.ok ? listItemResult(sent) : sent.failure
}

// ---- 3.2 groups (S8) -------------------------------------------------------------------------

export const TASK_GROUP_SCOPES = ['list', 'user'] as const
export type TaskGroupScope = (typeof TASK_GROUP_SCOPES)[number]

export interface TaskGroup {
  /** `null` only for the personal scope's default group before its row exists. */
  id: string | null
  scope: TaskGroupScope
  name: string
  position: number
  isDefault: boolean
}

/** A task's placement inside a group: `position` is the 0-based dense index in that group's
 *  visible set, not a stored column. */
export interface TaskPlacement {
  groupId: string
  taskId: string
  position: number
}

// RULED(2026-10-07): [R11] — one default group per container.
// ASSUMPTION(task-m4-fe): [own-24] (PR-3a) — the personal default group has `id: null` before its
// row exists.
/** One `Group` body for the given scope, or `null` for a malformed one: `scope` must be the
 *  expected one; `id` may be `null` only in the personal scope and only for the default group. */
export function parseTaskGroup(value: unknown, scope: TaskGroupScope): TaskGroup | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.scope !== scope) return null
  if (!isNullableString(record.id)) return null
  if (typeof record.name !== 'string') return null
  if (!isNonNegativeInteger(record.position)) return null
  if (typeof record.isDefault !== 'boolean') return null
  if (record.id === null && (scope !== 'user' || !record.isDefault)) return null
  return { id: record.id, scope, name: record.name, position: record.position, isDefault: record.isDefault }
}

function isTaskPlacement(value: unknown): value is TaskPlacement {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.groupId === 'string' && typeof record.taskId === 'string' && isNonNegativeInteger(record.position)
}

export type TaskGroupResult = { kind: 'ok'; group: TaskGroup } | WriteFailure
export type DeleteTaskGroupResult = { kind: 'ok'; id: string; deleted: true; reassignedTo: string } | WriteFailure
export type PlaceTaskResult = { kind: 'ok'; taskId: string; groupId: string; position: number } | WriteFailure

function groupResult(sent: { ok: true; body: unknown; status: number }, scope: TaskGroupScope): TaskGroupResult {
  const group = parseTaskGroup(sent.body, scope)
  return group ? { kind: 'ok', group } : { kind: 'error', status: sent.status }
}

function deleteGroupResult(sent: { ok: true; body: unknown; status: number }): DeleteTaskGroupResult {
  const body = sent.body
  if (!body || typeof body !== 'object') return { kind: 'error', status: sent.status }
  const record = body as Record<string, unknown>
  if (typeof record.id !== 'string' || record.deleted !== true || typeof record.reassignedTo !== 'string') {
    return { kind: 'error', status: sent.status }
  }
  return { kind: 'ok', id: record.id, deleted: true, reassignedTo: record.reassignedTo }
}

function placeResult(sent: { ok: true; body: unknown; status: number }): PlaceTaskResult {
  const body = sent.body
  if (!body || typeof body !== 'object') return { kind: 'error', status: sent.status }
  const record = body as Record<string, unknown>
  if (typeof record.taskId !== 'string' || typeof record.groupId !== 'string' || !isNonNegativeInteger(record.position)) {
    return { kind: 'error', status: sent.status }
  }
  return { kind: 'ok', taskId: record.taskId, groupId: record.groupId, position: record.position }
}

function isListGroup(value: unknown): value is TaskGroup {
  return parseTaskGroup(value, 'list') !== null
}

function isUserGroup(value: unknown): value is TaskGroup {
  return parseTaskGroup(value, 'user') !== null
}

/** `GET /api/task-lists/:id/groups` — one page (the group cap fits in one). */
export async function listTaskListGroups(id: string): Promise<CollectionResult<TaskGroup>> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  return readCollection(`${listPath(id, '/groups')}?${pageQuery(0)}`, isListGroup)
}

/** `POST /api/task-lists/:id/groups` `{ name }`. Codes: `INVALID_NAME` `NAME_TOO_LONG` `LIMIT`. */
export async function createTaskListGroup(id: string, name: string): Promise<TaskGroupResult> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  const sent = await sendWrite(listPath(id, '/groups'), 'POST', { name })
  return sent.ok ? groupResult(sent, 'list') : sent.failure
}

/** `PATCH /api/task-lists/:id/groups/:groupId` `{ name }`. Codes: `INVALID_NAME` `NAME_TOO_LONG`. */
export async function renameTaskListGroup(id: string, groupId: string, name: string): Promise<TaskGroupResult> {
  if (!isPathSafeSegment(id) || !isPathSafeSegment(groupId)) return { kind: 'not_found' }
  const sent = await sendWrite(listPath(id, `/groups/${encodeURIComponent(groupId)}`), 'PATCH', { name })
  return sent.ok ? groupResult(sent, 'list') : sent.failure
}

/** `DELETE /api/task-lists/:id/groups/:groupId` — no body; the group's items move to the default
 *  group (`reassignedTo`). Code: `IS_DEFAULT`. */
export async function deleteTaskListGroup(id: string, groupId: string): Promise<DeleteTaskGroupResult> {
  if (!isPathSafeSegment(id) || !isPathSafeSegment(groupId)) return { kind: 'not_found' }
  const sent = await sendWrite(listPath(id, `/groups/${encodeURIComponent(groupId)}`), 'DELETE')
  return sent.ok ? deleteGroupResult(sent) : sent.failure
}

/** `GET /api/task-lists/:id/group-items`, every page. */
export async function listTaskListGroupItems(id: string, options: ReadAllOptions = {}): Promise<CollectionResult<TaskPlacement>> {
  if (!isPathSafeSegment(id)) return { kind: 'not_found' }
  return collectPages(
    (offset) => readCollection(`${listPath(id, '/group-items')}?${pageQuery(offset)}`, isTaskPlacement),
    (placement) => placement.taskId,
    options,
  )
}

/** `PUT /api/task-lists/:id/group-items/:taskId` `{ groupId, position }` — `groupId: null` names
 *  the default group; `position` is the index in the target group's visible set. Codes:
 *  `INVALID_GROUP` `INVALID_POSITION`. The same group and index is a no-op, still 200. */
export async function placeTaskInListGroup(id: string, taskId: string, groupId: string | null, position: number): Promise<PlaceTaskResult> {
  if (!isPathSafeSegment(id) || !isPathSafeSegment(taskId)) return { kind: 'not_found' }
  const sent = await sendWrite(listPath(id, `/group-items/${encodeURIComponent(taskId)}`), 'PUT', { groupId, position })
  return sent.ok ? placeResult(sent) : sent.failure
}

/** `GET /api/task-groups` — one page: the caller's personal groups, exactly one of them
 *  `isDefault` (with `id: null` before its row exists). */
export async function listUserGroups(): Promise<CollectionResult<TaskGroup>> {
  return readCollection(`/api/task-groups?${pageQuery(0)}`, isUserGroup)
}

/** `POST /api/task-groups` `{ name }`. Codes: `INVALID_NAME` `NAME_TOO_LONG` `LIMIT`. */
export async function createUserGroup(name: string): Promise<TaskGroupResult> {
  const sent = await sendWrite('/api/task-groups', 'POST', { name })
  return sent.ok ? groupResult(sent, 'user') : sent.failure
}

/** `PATCH /api/task-groups/:groupId` `{ name }`. Codes: `INVALID_NAME` `NAME_TOO_LONG`. */
export async function renameUserGroup(groupId: string, name: string): Promise<TaskGroupResult> {
  if (!isPathSafeSegment(groupId)) return { kind: 'not_found' }
  const sent = await sendWrite(`/api/task-groups/${encodeURIComponent(groupId)}`, 'PATCH', { name })
  return sent.ok ? groupResult(sent, 'user') : sent.failure
}

/** `DELETE /api/task-groups/:groupId` — no body. Code: `IS_DEFAULT`. */
export async function deleteUserGroup(groupId: string): Promise<DeleteTaskGroupResult> {
  if (!isPathSafeSegment(groupId)) return { kind: 'not_found' }
  const sent = await sendWrite(`/api/task-groups/${encodeURIComponent(groupId)}`, 'DELETE')
  return sent.ok ? deleteGroupResult(sent) : sent.failure
}

/** `GET /api/task-groups/items`, every page — placements of the tasks on the caller's assigned
 *  view only. */
export async function listUserGroupItems(options: ReadAllOptions = {}): Promise<CollectionResult<TaskPlacement>> {
  return collectPages(
    (offset) => readCollection(`/api/task-groups/items?${pageQuery(offset)}`, isTaskPlacement),
    (placement) => placement.taskId,
    options,
  )
}

/** `PUT /api/task-groups/items/:taskId` `{ groupId, position }` — `groupId: null` names the
 *  default group; the 200 body's `groupId` is the real id once the default group's row exists. A
 *  task outside the caller's assigned view is a plain 404. Codes: `INVALID_GROUP`
 *  `INVALID_POSITION`. */
export async function placeTaskInUserGroup(taskId: string, groupId: string | null, position: number): Promise<PlaceTaskResult> {
  if (!isPathSafeSegment(taskId)) return { kind: 'not_found' }
  const sent = await sendWrite(`/api/task-groups/items/${encodeURIComponent(taskId)}`, 'PUT', { groupId, position })
  return sent.ok ? placeResult(sent) : sent.failure
}
