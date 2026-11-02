// Tasks acceptance walk — the shared fixture values of the harness page and its spec.
//
// Plain data only: the harness (browser) and the spec (Playwright, in node) both import this file,
// so it imports nothing. Every response body here is shaped the way the server sends it,
// and the file names the source of each shape next to it. Ids and names are synthetic.

export const WALK_ORG_ID = 'org_walk'
/** The signed-in dispatcher: an ordinary user who can use tasks. */
export const WALK_USER_ID = 'usr_walk_dispatcher'
/** The assignee the walk names: a user who cannot use tasks yet. */
export const WALK_NO_ACCESS_USER_ID = 'usr_walk_no_task_access'
export const WALK_SHEET_ID = 'sht_walk'
export const WALK_VIEW_ID = 'viw_walk'
export const WALK_BASE_ID = 'bse_walk'
export const WALK_RECORD_ID = 'rec_walk_1'
export const WALK_RECORD_TITLE = '巡检记录 A'
export const WALK_TASK_ID = 'tsk_walk_1'

/** A JWT-shaped token the app's own payload reader understands (header and signature are not read).
 *  It carries the subject and the `tenantId` claim, the claim the server takes the user's org from,
 *  as every token of a working tasks session does. No explicit session org is stored with it. */
export const WALK_TOKEN = `h.${btoa(JSON.stringify({ sub: WALK_USER_ID, tenantId: WALK_ORG_ID })).replace(/=+$/, '')}.s`

/** `GET /api/auth/me`: routes/auth.ts answers `{ success, data: { user, features } }`, with the
 *  feature keys of `buildFeaturePayload` there; `tasks` is true exactly when the server mounts the
 *  task routes. `user.tenantId` is the token's `tenantId` claim, where the server takes it from. */
export function walkSessionBody(): Record<string, unknown> {
  return {
    success: true,
    data: {
      user: {
        id: WALK_USER_ID,
        email: 'dispatcher@example.test',
        name: '派发人',
        role: 'user',
        permissions: ['tasks:read', 'tasks:write'],
        tenantId: WALK_ORG_ID,
      },
      features: {
        attendance: false,
        workflow: false,
        attendanceAdmin: false,
        attendanceImport: false,
        plm: false,
        approvalAttachments: false,
        approvalCanvasV2: true,
        approvalFwbWriteback: false,
        approvalCcUnreadBadge: false,
        approvalMineOutcomeBadge: false,
        attendanceGroupEffectivePolicyPanel: false,
        elearning: false,
        tasks: true,
        mode: 'platform',
      },
    },
  }
}

/** The 422 body of a task create or assignee add that names someone without task access: the
 *  server's `fail(422, 'ASSIGNEE_TASK_ACCESS_REQUIRED')`, sent by `sendError` (routes/tasks-http.ts)
 *  as `{ error: { code } }`, nothing else. */
export const ASSIGNEE_TASK_ACCESS_REQUIRED_BODY = { error: { code: 'ASSIGNEE_TASK_ACCESS_REQUIRED' } }

/** `GET /api/tasks/:id`: the object `getTask` (services/task-records.ts) returns, key for key.
 *  `canManageMembers` is true, so the assignee add form renders. `dueAt` is the instant the server
 *  derives from the due date (tasks/task-dates.ts `computeDueAt`, called by tasks/task-edit.ts): with
 *  no due time, the end of that day (23:59:59.999) in the task's zone, here UTC+8. */
export function walkTaskDetailBody(): Record<string, unknown> {
  return {
    id: WALK_TASK_ID,
    title: '复核巡检记录',
    status: 'open',
    completionMode: 'all',
    createdBy: WALK_USER_ID,
    dueAt: '2031-05-06T15:59:59.999Z',
    dueDate: '2031-05-06',
    dueTime: null,
    timeZone: 'Asia/Shanghai',
    assignees: [{ userId: WALK_USER_ID, completedAt: null }],
    canComplete: true,
    canReopen: false,
    followers: [],
    canEdit: true,
    canManageMembers: true,
    canDelete: true,
    canComment: true,
    canLeave: false,
    version: 1,
    parentId: null,
    depth: 0,
    children: [],
    description: null,
    startDate: null,
    startTime: null,
    remindAt: null,
    listIds: [],
  }
}
