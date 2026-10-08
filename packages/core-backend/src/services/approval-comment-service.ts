/**
 * Lock-10 (S2) — `approval_comments` service: participant-scoped, mutable comments on PLATFORM
 * approval instances (D2(b1) storage, D3 write widening, D5 mention scoping, OD-S1-14/15,
 * HISTORY-TIMELINE arm (i)).
 *
 * Module-function style (matches `approval-attachment-runtime.ts`'s family), not a DI class —
 * this slice has no need for constructor-injected collaborators; the notify/delivery seams below
 * are the ONE piece of mutable module state, mirroring `CommentService`'s own
 * `commentTargetReadChecker` seam shape but FAIL-CLOSED by default (OD-S1-15).
 *
 * THE PREDICATE IS IMPORTED, NEVER RE-DERIVED. OD-S1-14 (Lock-10 `:581-591`) verbatim:
 * "`canReadApprovalInstance` gates comment list/read, and the same predicate gates comment
 * create. Deletion tombstones (D2(b1)) are readable under the same gate — a tombstone is comment
 * data." Rejected arm (b): a separate `canWriteApprovalComment`. If a future ruling wants write
 * narrower than read it must be `S1 AND <extra>`, never a parallel union — this module has no
 * second predicate and must never grow one.
 *
 * `plm:` ids: OD-S1-18(a), Lock-10 `:617-620` verbatim — "The comments consumer (OD-S1-14) is
 * **not** enabled for `plm:` ids in v1; there is no participant union to widen a comment write
 * to." Every exported function below denies a `plm:` instanceId the SAME shape as an unknown
 * platform instance (the route maps both to `404 APPROVAL_NOT_FOUND`) — `isPlmApprovalId` is
 * checked before ANY DB write so a `plm:` id never reaches `canReadApprovalInstance` from this
 * module (defense in depth; the route's own check is primary — see `approval-comments.ts`).
 */
import { randomUUID } from 'crypto'
import { canReadApprovalInstance, isPlmApprovalId } from './approval-instance-readability'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { transaction as runInTransaction } from '../db/pg'

// ------------------------------------------------------------------------------------------------
// Constants — R7 (body bounds), pagination bounds, mention-candidate cap.
// ------------------------------------------------------------------------------------------------

/** SHAPE is locked (a max exists); the NUMBER is reversible S2 implementation judgement. */
export const APPROVAL_COMMENT_BODY_MAX_CHARS = 5000
const APPROVAL_COMMENT_DEFAULT_LIMIT = 50
const APPROVAL_COMMENT_MAX_LIMIT = 200 // matches MAX_APPROVAL_PAGE_SIZE (routes/approvals.ts)
const APPROVAL_MENTION_CANDIDATE_MAX = 50

// ------------------------------------------------------------------------------------------------
// Errors — the route layer maps these to values-free HTTP denial shapes (see approval-comments.ts
// §6.3). Each carries a stable `code` so the route never has to string-match a message.
// ------------------------------------------------------------------------------------------------

export class ApprovalCommentNotFoundError extends Error {
  readonly code = 'APPROVAL_NOT_FOUND'
  constructor() {
    super('Approval instance not found')
    this.name = 'ApprovalCommentNotFoundError'
  }
}

export class ApprovalCommentRecordNotFoundError extends Error {
  readonly code = 'APPROVAL_COMMENT_NOT_FOUND'
  constructor() {
    super('Approval comment not found')
    this.name = 'ApprovalCommentRecordNotFoundError'
  }
}

export class ApprovalCommentValidationError extends Error {
  readonly code = 'VALIDATION_ERROR'
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalCommentValidationError'
  }
}

export class ApprovalCommentDeletedError extends Error {
  readonly code = 'APPROVAL_COMMENT_DELETED'
  constructor() {
    super('Comment has been deleted')
    this.name = 'ApprovalCommentDeletedError'
  }
}

// ------------------------------------------------------------------------------------------------
// DTO
// ------------------------------------------------------------------------------------------------

export interface ApprovalCommentView {
  id: string
  instanceId: string
  parentId: string | null
  authorId: string
  body: string | null
  mentions: string[]
  createdAt: string
  updatedAt: string
  editedAt: string | null
  deleted: boolean
  deletedAt: string | null
}

interface ApprovalCommentRow {
  id: string
  instance_id: string
  parent_id: string | null
  author_id: string
  body: string | null
  mentions: unknown
  created_at: string | Date
  updated_at: string | Date
  edited_at: string | Date | null
  deleted_at: string | Date | null
}

function toIso(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function normalizeMentionsColumn(value: unknown): string[] {
  const parsed = typeof value === 'string' ? safeJsonParse(value) : value
  if (!Array.isArray(parsed)) return []
  const out = new Set<string>()
  for (const entry of parsed) {
    if (typeof entry === 'string' && entry.trim()) out.add(entry.trim())
  }
  return [...out]
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return []
  }
}

function toView(row: ApprovalCommentRow): ApprovalCommentView {
  return {
    id: row.id,
    instanceId: row.instance_id,
    parentId: row.parent_id,
    authorId: row.author_id,
    body: row.deleted_at ? null : row.body,
    mentions: row.deleted_at ? [] : normalizeMentionsColumn(row.mentions),
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
    editedAt: toIso(row.edited_at),
    deleted: row.deleted_at !== null,
    deletedAt: toIso(row.deleted_at),
  }
}

// ------------------------------------------------------------------------------------------------
// R4.4 mention grammar — DELIBERATELY DUPLICATED from `CommentService.ts`'s private
// `parseMentions`/`normalizeMentions` (option B of the reuse study: extracting a shared pure
// module would edit a shipped multitable service inside an authorization slice and force a
// re-run of the multitable comment suites — unacceptable blast radius here). Mitigation:
// `tests/unit/approval-comment-mention-grammar.test.ts` pins this EXACT regex literal against
// the same literal in `CommentService.ts` so a future divergence reds instead of silently
// forking the grammar.
//
// Grammar: `@[Display Name](user-id)` — group 2 is the stored id. The STORED VALUE is the id
// array, never the display names.
// ------------------------------------------------------------------------------------------------
function parseMentionsFromBody(body: string): string[] {
  const regex = /@\[([^\]]+)\]\(([^)]+)\)/g
  const mentions: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(body)) !== null) {
    mentions.push(match[2])
  }
  return normalizeMentionList(mentions)
}

function normalizeMentionList(mentions: Iterable<unknown>): string[] {
  const normalized = new Set<string>()
  for (const mention of mentions) {
    if (typeof mention !== 'string') continue
    const value = mention.trim()
    if (value) normalized.add(value)
  }
  return [...normalized]
}

function resolveMentions(body: string, explicit?: string[]): string[] {
  return explicit ? normalizeMentionList(explicit) : parseMentionsFromBody(body)
}

// ------------------------------------------------------------------------------------------------
// R7 — body validation, values-free (never echoes the body or its length back to the caller).
// ------------------------------------------------------------------------------------------------
function assertValidBody(body: unknown): string {
  if (typeof body !== 'string') {
    throw new ApprovalCommentValidationError('body is required')
  }
  const trimmed = body.trim()
  if (trimmed.length === 0) {
    throw new ApprovalCommentValidationError('body must not be blank')
  }
  if (body.length > APPROVAL_COMMENT_BODY_MAX_CHARS) {
    throw new ApprovalCommentValidationError('body exceeds the maximum length')
  }
  return body
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return APPROVAL_COMMENT_DEFAULT_LIMIT
  }
  return Math.min(Math.floor(limit), APPROVAL_COMMENT_MAX_LIMIT)
}

function clampOffset(offset: number | undefined): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0) {
    return 0
  }
  return Math.floor(offset)
}

// ------------------------------------------------------------------------------------------------
// §4.5 dual-write — the pointer row. `approval_records.comment IS NULL` on the pointer row is the
// LOAD-BEARING invariant of D2(b1): the body lives SOLELY in the mutable `approval_comments`
// table, and deletion clears it there. A pointer row that also filled `comment` would duplicate
// the body into an IMMUTABLE audit trail and defeat the tombstone entirely.
//
// Uniquely-named closure (P26/census lesson — a generic name like `insert` or `queryFn` would
// collide with the census's nearest-preceding-declaration attribution).
// ------------------------------------------------------------------------------------------------
async function insertApprovalCommentPointerRecord(
  client: Queryable,
  instanceId: string,
  commentId: string,
  actorId: string,
): Promise<void> {
  const instanceRes = await client.query(
    `SELECT status, version FROM approval_instances WHERE id = $1`,
    [instanceId],
  )
  const instanceRow = instanceRes.rows[0] as { status?: string; version?: number } | undefined
  const status = instanceRow?.status ?? null
  const version = instanceRow?.version ?? null
  await client.query(
    `INSERT INTO approval_records
       (instance_id, action, actor_id, actor_name, comment, from_status, to_status, from_version, to_version, metadata)
     VALUES ($1, 'comment', $2, NULL, NULL, $3, $3, $4, $4, $5::jsonb)`,
    [instanceId, actorId, status, version, JSON.stringify({ commentId })],
  )
}

// ------------------------------------------------------------------------------------------------
// R1 — author-only edit/delete. NOT admin-overridable (S1 admits you to the INSTANCE; it does not
// make you the author of someone else's comment). An admin override is not in the decided arms.
// ------------------------------------------------------------------------------------------------
async function loadOwnCommentOrThrow(
  db: Queryable,
  commentId: string,
  instanceId: string,
  viewerId: string,
): Promise<ApprovalCommentRow> {
  const result = await db.query(
    `SELECT id, instance_id, parent_id, author_id, body, mentions, created_at, updated_at, edited_at, deleted_at
       FROM approval_comments
      WHERE id = $1 AND instance_id = $2`,
    [commentId, instanceId],
  )
  const row = result.rows[0] as unknown as ApprovalCommentRow | undefined
  // R16 (check ordering, §6.2/C-16): unknown comment, wrong instance, and non-author all collapse
  // to the SAME 404 — a non-author must not learn the comment exists on this instance and is not
  // theirs.
  if (!row || row.author_id !== viewerId) {
    throw new ApprovalCommentRecordNotFoundError()
  }
  return row
}

// ------------------------------------------------------------------------------------------------
// R6/R5 — parentId validation: same instance (R6), one-level threading (R5). Reply-TO-a-tombstone
// is ALLOWED (R3) — a tombstone is comment data and a thread must survive its parent's deletion.
//
// Fix-round (gate P3-4): "unknown id" and "real id, wrong instance" collapse to the SAME message
// (mirrors `loadOwnCommentOrThrow`'s R16 collapse two functions above). Before this fix a caller
// who already held a comment id from a DIFFERENT instance they also participate in could
// distinguish "this id exists somewhere" from "this id doesn't exist at all" by the wording alone
// — a one-bit oracle over an id space the caller already holds a member of, not a new read
// primitive, but values-free denial shapes are this file's own stated convention (OD-L7-7) and the
// two branches cost nothing to unify. The one-level-threading branch stays separate: it discloses
// nothing about any OTHER instance, only that the caller's OWN chosen parent already has a parent.
// ------------------------------------------------------------------------------------------------
async function resolveParentOrThrow(
  db: Queryable,
  instanceId: string,
  parentId: string,
): Promise<void> {
  const result = await db.query(
    `SELECT instance_id, parent_id FROM approval_comments WHERE id = $1`,
    [parentId],
  )
  const parent = result.rows[0] as { instance_id?: string; parent_id?: string | null } | undefined
  if (!parent || parent.instance_id !== instanceId) {
    throw new ApprovalCommentValidationError('parentId does not reference a valid comment on this instance')
  }
  if (parent.parent_id) {
    throw new ApprovalCommentValidationError('replies to replies are not supported (one level only)')
  }
}

// ==================================================================================================
// PUBLIC API
// ==================================================================================================

export interface CreateApprovalCommentInput {
  instanceId: string
  authorId: string
  body: string
  parentId?: string
  mentions?: string[]
}

/**
 * §4.5 — ONE transaction, both writes or neither. The predicate check + parent validation run on
 * the caller's `db` handle (a plain read, no need to hold it inside the write transaction); the
 * comment INSERT and the pointer-row INSERT into `approval_records` are then issued against a
 * SINGLE checked-out client via `transaction()` (`../db/pg`), so a crash between the two can never
 * leave a comment with no audit row or an audit row with no comment.
 */
export async function createApprovalComment(
  db: Queryable,
  input: CreateApprovalCommentInput,
): Promise<{ comment: ApprovalCommentView }> {
  if (isPlmApprovalId(input.instanceId)) throw new ApprovalCommentNotFoundError()
  const readable = await canReadApprovalInstance(db, input.authorId, input.instanceId)
  if (!readable) throw new ApprovalCommentNotFoundError()

  const body = assertValidBody(input.body)
  if (input.parentId) {
    await resolveParentOrThrow(db, input.instanceId, input.parentId)
  }
  const mentions = resolveMentions(body, input.mentions)
  const id = `acmt_${randomUUID()}`

  const row = await runInTransaction(async (client) => {
    const insertRes = await client.query(
      `INSERT INTO approval_comments (id, instance_id, parent_id, author_id, body, mentions)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, instance_id, parent_id, author_id, body, mentions, created_at, updated_at, edited_at, deleted_at`,
      [id, input.instanceId, input.parentId ?? null, input.authorId, body, JSON.stringify(mentions)],
    )
    await insertApprovalCommentPointerRecord(client, input.instanceId, id, input.authorId)
    return insertRes.rows[0] as unknown as ApprovalCommentRow
  })

  return { comment: toView(row) }
}

export interface ListApprovalCommentsInput {
  instanceId: string
  viewerId: string
  limit?: number
  offset?: number
}

export async function listApprovalComments(
  db: Queryable,
  input: ListApprovalCommentsInput,
): Promise<{ comments: ApprovalCommentView[]; page: { total: number; limit: number; offset: number } }> {
  if (isPlmApprovalId(input.instanceId)) throw new ApprovalCommentNotFoundError()
  const readable = await canReadApprovalInstance(db, input.viewerId, input.instanceId)
  if (!readable) throw new ApprovalCommentNotFoundError()

  const limit = clampLimit(input.limit)
  const offset = clampOffset(input.offset)

  const countRes = await db.query(
    `SELECT COUNT(*)::int AS c FROM approval_comments WHERE instance_id = $1`,
    [input.instanceId],
  )
  const total = Number((countRes.rows[0] as { c?: number } | undefined)?.c ?? 0)

  // ORDER BY created_at ASC, id ASC — the tiebreaker is NOT optional: two comments created in the
  // same millisecond would otherwise paginate non-deterministically, duplicating/dropping rows
  // across pages.
  const rowsRes = await db.query(
    `SELECT id, instance_id, parent_id, author_id, body, mentions, created_at, updated_at, edited_at, deleted_at
       FROM approval_comments
      WHERE instance_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT $2 OFFSET $3`,
    [input.instanceId, limit, offset],
  )
  const comments = (rowsRes.rows as unknown as ApprovalCommentRow[]).map(toView)
  return { comments, page: { total, limit, offset } }
}

export interface EditApprovalCommentInput {
  commentId: string
  instanceId: string
  editorId: string
  body: string
  mentions?: string[]
}

export async function editApprovalComment(
  db: Queryable,
  input: EditApprovalCommentInput,
): Promise<{ comment: ApprovalCommentView }> {
  if (isPlmApprovalId(input.instanceId)) throw new ApprovalCommentNotFoundError()
  const readable = await canReadApprovalInstance(db, input.editorId, input.instanceId)
  if (!readable) throw new ApprovalCommentNotFoundError()

  // R1/C-16: author check happens BEFORE payload validation, so a non-author never learns their
  // payload was malformed.
  const existing = await loadOwnCommentOrThrow(db, input.commentId, input.instanceId, input.editorId)
  // R2: editing a tombstone is refused — the CHECK forbids restoring a body anyway.
  if (existing.deleted_at) throw new ApprovalCommentDeletedError()

  const body = assertValidBody(input.body)
  const mentions = resolveMentions(body, input.mentions)

  // R8: updated_at + edited_at move; created_at + author_id NEVER do.
  const result = await db.query(
    `UPDATE approval_comments
        SET body = $1, mentions = $2::jsonb, updated_at = now(), edited_at = now()
      WHERE id = $3
      RETURNING id, instance_id, parent_id, author_id, body, mentions, created_at, updated_at, edited_at, deleted_at`,
    [body, JSON.stringify(mentions), input.commentId],
  )
  const row = result.rows[0] as unknown as ApprovalCommentRow
  return { comment: toView(row) }
}

export interface DeleteApprovalCommentInput {
  commentId: string
  instanceId: string
  actorId: string
}

export async function deleteApprovalComment(
  db: Queryable,
  input: DeleteApprovalCommentInput,
): Promise<{ comment: ApprovalCommentView }> {
  if (isPlmApprovalId(input.instanceId)) throw new ApprovalCommentNotFoundError()
  const readable = await canReadApprovalInstance(db, input.actorId, input.instanceId)
  if (!readable) throw new ApprovalCommentNotFoundError()

  // R1: author-only. R4 — DELIBERATELY NOT copying `CommentService.deleteComment`'s
  // reply-refusal (`CommentConflictError('Comments with replies cannot be deleted')`,
  // `CommentService.ts:259`). That rule exists because multitable delete is a HARD ROW DELETE and
  // a child would be orphaned; here delete is a TOMBSTONE — the parent row (and its children,
  // author, timestamps) all survive. Deleting a comment WITH replies is therefore ALLOWED
  // (C-15's explicit anti-pattern gate).
  await loadOwnCommentOrThrow(db, input.commentId, input.instanceId, input.actorId)

  // R9 / fix-round (gate P3-3): tombstone clears body -> NULL and mentions -> '[]'; keeps
  // author_id, created_at, parent_id, and the row itself. `deleted_at` is stamped; `updated_at`
  // moves (it is a mutation); `edited_at` is deliberately NOT touched (a delete is not an edit).
  // The `WHERE ... AND deleted_at IS NULL` guard makes DELETE IDEMPOTENT: re-deleting an
  // already-tombstoned comment (author retries, or a same-instant concurrent second DELETE) is
  // still ALLOWED (200, unchanged from the un-guarded behavior above) but no longer moves
  // `deleted_at` forward or mints a second pointer row's worth of write activity with nothing to
  // show for it — before this fix a repeat DELETE silently rewrote the tombstone timestamp on
  // every call.
  const result = await db.query(
    `UPDATE approval_comments
        SET body = NULL, mentions = '[]'::jsonb, deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, instance_id, parent_id, author_id, body, mentions, created_at, updated_at, edited_at, deleted_at`,
    [input.commentId],
  )
  let row = result.rows[0] as unknown as ApprovalCommentRow | undefined
  if (!row) {
    // Already tombstoned (or, between the two statements above, hard-deleted via the instance's
    // `ON DELETE CASCADE`) — re-read and return the CURRENT row as a no-op rather than throwing a
    // spurious error for a state the caller's own request already achieves. A row that vanished
    // entirely (the CASCADE case) is a genuine 404, not swallowed into a fake success.
    const reread = await db.query(
      `SELECT id, instance_id, parent_id, author_id, body, mentions, created_at, updated_at, edited_at, deleted_at
         FROM approval_comments WHERE id = $1`,
      [input.commentId],
    )
    row = reread.rows[0] as unknown as ApprovalCommentRow | undefined
    if (!row) throw new ApprovalCommentRecordNotFoundError()
  }
  return { comment: toView(row) }
}

// ------------------------------------------------------------------------------------------------
// §7 — mention candidates (D5). Enumerates the SAME union S1's arms read (arm 5/admin is a
// predicate, NOT a member list — it is deliberately NOT enumerated into the picker).
// `source_queue` seats are EXCLUDED (OD-S1-5): a `source_queue` assignee_id is a permission code,
// not a user id. This enumeration is a CANDIDATE list, not a second predicate — the authorization
// for the resulting comment WRITE is still `canReadApprovalInstance` on the writer, never this
// list.
// ------------------------------------------------------------------------------------------------
export interface ListMentionCandidatesInput {
  instanceId: string
  viewerId: string
  q?: string
  limit?: number
}

export interface ApprovalMentionCandidate {
  id: string
  name: string
  email: string
}

export async function listMentionCandidates(
  db: Queryable,
  input: ListMentionCandidatesInput,
): Promise<{ users: ApprovalMentionCandidate[] }> {
  if (isPlmApprovalId(input.instanceId)) throw new ApprovalCommentNotFoundError()
  const readable = await canReadApprovalInstance(db, input.viewerId, input.instanceId)
  if (!readable) throw new ApprovalCommentNotFoundError()

  const limit = Math.min(
    input.limit && Number.isFinite(input.limit) && input.limit > 0 ? Math.floor(input.limit) : APPROVAL_MENTION_CANDIDATE_MAX,
    APPROVAL_MENTION_CANDIDATE_MAX,
  )
  const q = (input.q ?? '').trim()
  const qParam = `%${q}%`

  const result = await db.query(
    `WITH candidate_ids AS (
       -- arm 1: requester
       SELECT i.requester_snapshot->>'id' AS user_id
         FROM approval_instances i WHERE i.id = $1 AND i.requester_snapshot->>'id' IS NOT NULL
       UNION
       -- arm 2: user-typed assignments (no is_active filter, OD-S1-4 monotonic membership)
       SELECT a.assignee_id
         FROM approval_assignments a
        WHERE a.instance_id = $1 AND a.assignment_type = 'user'
       UNION
       -- arm 2: role-typed assignments expand via user_roles (source_queue explicitly excluded).
       -- Mirrors viewerRoles's TWO role sources: (a) user_roles joined to roles
       -- (role_id OR name), and (b) the plain users.role text column directly -- the same
       -- asymmetry canReadApprovalInstance's role match (rolesParam, built from both sources)
       -- relies on, so this enumeration stays a subset-consistent MIRROR of that match, not a
       -- second predicate.
       SELECT ur.user_id
         FROM approval_assignments a
         JOIN roles r ON r.id = a.assignee_id OR r.name = a.assignee_id
         JOIN user_roles ur ON ur.role_id = r.id
        WHERE a.instance_id = $1 AND a.assignment_type = 'role'
       UNION
       SELECT u.id
         FROM users u
         JOIN approval_assignments a ON a.assignee_id = u.role
        WHERE a.instance_id = $1 AND a.assignment_type = 'role'
       UNION
       -- arm 3: past actors
       SELECT r.actor_id
         FROM approval_records r WHERE r.instance_id = $1
       UNION
       -- arm 4: cc user targets
       SELECT r.metadata->>'targetId'
         FROM approval_records r
        WHERE r.instance_id = $1 AND r.action = 'cc' AND r.metadata->>'targetType' = 'user'
       UNION
       -- arm 4: cc role targets expand via user_roles (same two-source mirror as arm 2 above)
       SELECT ur.user_id
         FROM approval_records r
         JOIN roles ro ON ro.id = r.metadata->>'targetId' OR ro.name = r.metadata->>'targetId'
         JOIN user_roles ur ON ur.role_id = ro.id
        WHERE r.instance_id = $1 AND r.action = 'cc' AND r.metadata->>'targetType' = 'role'
       UNION
       SELECT u.id
         FROM users u
         JOIN approval_records r ON r.metadata->>'targetId' = u.role
        WHERE r.instance_id = $1 AND r.action = 'cc' AND r.metadata->>'targetType' = 'role'
     )
     SELECT u.id, u.name, u.email
       FROM users u
       JOIN candidate_ids c ON c.user_id = u.id
      WHERE u.is_active = TRUE
        AND ($2 = '' OR u.name ILIKE $3 OR u.email ILIKE $3)
      ORDER BY u.name ASC
      LIMIT $4`,
    [input.instanceId, q, qParam, limit],
  )
  const users = (result.rows as Array<{ id: string; name: string | null; email: string | null }>).map((row) => ({
    id: row.id,
    name: row.name ?? '',
    email: row.email ?? '',
  }))
  return { users }
}

// ==================================================================================================
// §7.3 — the notify seam (OD-S1-15, G-S1-9). FAIL-CLOSED default: the multitable sibling
// (`CommentService.ts`'s `commentTargetReadChecker`) initializes to `async () => true` — that is
// the anti-pattern this ruling names by file:line. An unwired seam here notifies NOBODY.
// ==================================================================================================

export type ApprovalCommentNotifyChecker = (input: { instanceId: string; userId: string }) => Promise<boolean>

let approvalCommentNotifyChecker: ApprovalCommentNotifyChecker = async () => false

export function setApprovalCommentNotifyChecker(checker: ApprovalCommentNotifyChecker): void {
  approvalCommentNotifyChecker = checker
}

/** Test-only escape hatch to restore the fail-closed default between suites. Never called from
 *  production wiring (which calls `setApprovalCommentNotifyChecker` with a real checker once, at
 *  boot). */
export function resetApprovalCommentNotifyCheckerForTests(): void {
  approvalCommentNotifyChecker = async () => false
}

async function canNotifyAboutApprovalInstance(instanceId: string, userId: string): Promise<boolean> {
  try {
    return await approvalCommentNotifyChecker({ instanceId, userId })
  } catch {
    return false
  }
}

export type ApprovalCommentMentionDelivery = (userId: string, event: string, payload: unknown) => void

let approvalCommentMentionDelivery: ApprovalCommentMentionDelivery = () => {}

export function setApprovalCommentMentionDelivery(delivery: ApprovalCommentMentionDelivery): void {
  approvalCommentMentionDelivery = delivery
}

export function resetApprovalCommentMentionDeliveryForTests(): void {
  approvalCommentMentionDelivery = () => {}
}

export const APPROVAL_COMMENT_MENTION_EVENT = 'approval-comment:mention'

/**
 * Notify newly-mentioned users a comment mentions them. Called by the ROUTE layer after a
 * successful create/edit (outside the DB transaction — notification is best-effort and must never
 * roll back a committed comment). Values-free payload w.r.t. the instance: `{ commentId,
 * instanceId, authorId }` and NOTHING ELSE — no instance title, no body excerpt (OD-S1-15 names a
 * leaked instance title as the failure mode this seam exists to prevent).
 */
export async function notifyApprovalCommentMentions(input: {
  instanceId: string
  commentId: string
  authorId: string
  mentions: string[]
  previousMentions?: string[]
}): Promise<void> {
  const previous = new Set(input.previousMentions ?? [])
  for (const userId of input.mentions) {
    if (!userId || userId === input.authorId || previous.has(userId)) continue
    const allowed = await canNotifyAboutApprovalInstance(input.instanceId, userId)
    if (!allowed) continue
    approvalCommentMentionDelivery(userId, APPROVAL_COMMENT_MENTION_EVENT, {
      commentId: input.commentId,
      instanceId: input.instanceId,
      authorId: input.authorId,
    })
  }
}
