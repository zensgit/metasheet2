import type { Request, Response } from 'express'
import { Router } from 'express'
import { z } from 'zod'
import type { Injector } from '@wendellhu/redi'
import {
  ICommentService,
  type CommentAddressRecord,
  type CommentInboxDeniedRow,
  type CommentInboxScope,
  type CommentQueryOptions,
} from '../di/identifiers'
import { Logger } from '../core/logger'
import { rbacGuard } from '../rbac/rbac'
import { apiTokenAuth, requireScope } from '../middleware/api-token-auth'
import { apiTokenWriteRateLimit } from '../middleware/rate-limiter'
import { buildOapiAuditContext, oapiWriteAuditBoundary } from '../multitable/oapi-write-audit'
import { poolManager } from '../integration/db/connection-pool'
import { resolveRequestAccess, type ResolvedRequestAccess } from '../multitable/access'
import {
  canAccessElearningProjectionSheet,
  loadElearningProjectionSheetOrgMap,
} from '../multitable/elearning-projection-access'
import {
  filterReadableSheetRowsForAccess,
  loadDeniedRecordIds,
  loadRowLevelReadDenyEnabled,
  resolveSheetReadableCapabilities,
  type QueryFn,
} from '../multitable/permission-service'
import { loadSheetLivenessBatch } from '../multitable/sheet-liveness'
import { sendSheetNotLive } from '../multitable/sheet-refusals'
import {
  CommentAccessError,
  CommentConflictError,
  CommentNotFoundError,
  CommentValidationError,
} from '../services/CommentService'
import {
  MENTION_CANDIDATES_MAX_ITEMS,
  MENTION_CANDIDATES_MIN_QUERY_LENGTH,
} from '../services/comment-mention-bounds'
import type { CommentMentionCandidate } from '../di/identifiers'

const logger = new Logger('CommentsRoutes')
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function readQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0]
  if (typeof value === 'string') return value
  return undefined
}

function readQueryValues(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
  return undefined
}

function pickFirstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length > 0) return trimmed
  }
  return undefined
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function parseNumberParam(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function clampLimit(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)))
}

function clampOffset(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function getUserId(req: Request): string {
  const user = (req as { user?: { id?: unknown; sub?: unknown; userId?: unknown } }).user
  const headerUserId = req.headers['x-user-id']
  const header = Array.isArray(headerUserId) ? headerUserId[0] : headerUserId
  const raw = user?.id ?? user?.sub ?? user?.userId ?? header
  if (typeof raw === 'string' && raw.trim().length > 0) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return 'anonymous'
}

function respondCommentError(res: Response, error: unknown, fallbackMessage: string) {
  if (error instanceof CommentValidationError) {
    return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: error.message } })
  }
  if (error instanceof CommentAccessError) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: error.message } })
  }
  if (error instanceof CommentNotFoundError) {
    return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: error.message } })
  }
  if (error instanceof CommentConflictError) {
    return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: error.message } })
  }
  return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: fallbackMessage } })
}

/**
 * W1-2 permission-matrix B4 / G-8 — comments sheet-visibility gate.
 *
 * The comments surface is guarded ONLY by the coarse global `rbacGuard('comments','read'|'write')`
 * permission code, which takes NO sheetId and therefore cannot express "may this actor see THIS sheet";
 * `CommentService` then reads/writes purely by `spreadsheet_id`. Without this gate, any holder of the
 * global `comments:read`/`comments:write` codes — a real shipped role shape (the `plm-collaborator`
 * access preset grants `comments:read` with no `multitable:*`; the comment-permissions migration seeds
 * both codes onto the generic `user` role) — could read private comment content and write new comments
 * on a sheet they cannot even see through the interactive multitable read path (which 403s them). That
 * is the confirmed G-8 leak.
 *
 * The codebase's OWN intended contract is `canComment && scope.canRead` (permission-service
 * `applySheetPermissionScope`). This enforces the missing `scope.canRead` half at the route boundary,
 * reusing the SAME `resolveSheetReadableCapabilities` chokepoint the interactive record read path uses.
 * The global `comments:*` code (already checked by `rbacGuard`) supplies the `canComment` half; this adds
 * the per-sheet `canRead` half. Denied → 403, identical status/shape to `GET /records` on a no-read
 * sheet, so the comments surface carries no existence oracle beyond what the interactive read path
 * already exposes. Fail-closed (a resolver throw propagates to the route catch → 500, never a serve).
 *
 * Every gated call site resolves `resolveCommentReadContext(req, res, spreadsheetId)` and returns when it
 * fails. That context carries both sheet-read and row-deny state for read surfaces.
 *
 * SCOPE: this gates the routes that take an explicit `spreadsheetId`/`containerId` (the enumerable,
 * attacker-supplied surface — list/summary/presence/mention-candidates/mention-summary read + create/
 * mark-read/mark-all-read write) and, through `resolveCommentIdContext` (#5831), the `:commentId`-
 * addressed routes (patch/delete/read/reactions/resolve), which gate on the sheet the COMMENT lives on.
 * The user-scoped cross-sheet `inbox`/`unread-count` aggregates name no sheet, so they cannot answer
 * with a single-sheet 403; they are FILTERED instead (#5831 part B, `resolveCommentInboxScope`): only
 * comments on sheets this gate would let the caller read, that are live, on rows it would not deny.
 */
type CommentReadContext = {
  userId: string
  /**
   * #5808: the id `resolveRequestAccess` derived from `req.user` ONLY — empty when there is no
   * authenticated user. Unlike `userId` it never falls back to the `x-user-id` header, so it is the
   * only id allowed to decide whose comments get mention labels.
   */
  authenticatedUserId: string
  deniedRowIds: Set<string>
}

/**
 * The one "not permitted" answer of the comment surface. #5831: a comment-id route gives this SAME body
 * for an unknown comment id, a comment on a sheet the caller cannot read and a comment on a row the
 * caller is denied, so the comment-id routes answer no "does this comment exist?" question. (This
 * router's other comment-id input, `parentId` on POST /api/comments, gives one answer for an unknown
 * parent and a parent outside the caller's record thread — see CommentService.createComment.)
 */
const COMMENT_ACCESS_FORBIDDEN_MESSAGE = 'Not permitted to access comments on this sheet'

/**
 * @param denyScopeRowIds #5831 — when given, the row-level read deny is evaluated for THESE rows only
 *   (loadDeniedRecordIds' `recordIds` bound), so the returned `deniedRowIds` answers for them alone and
 *   must not be used as the sheet's deny set. Only the single-comment gate (`resolveCommentIdContext`)
 *   passes it — a one-comment action must not scan a large sheet's rows. Every sheet-addressed route
 *   omits it: its list/summary/mark-read filters need the complete set.
 */
async function resolveCommentReadContext(
  req: Request,
  res: Response,
  spreadsheetId: string,
  denyScopeRowIds?: readonly string[],
): Promise<CommentReadContext | null> {
  const pool = poolManager.get()
  const query = pool.query.bind(pool)
  const { access, capabilities, sheetLiveness } = await resolveSheetReadableCapabilities(req, query, spreadsheetId)
  if (!capabilities.canRead) {
    res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: COMMENT_ACCESS_FORBIDDEN_MESSAGE } })
    return null
  }
  // Sheet liveness, AFTER the read gate (a caller who may not read the sheet gets the same 403 whether
  // it is live or soft-deleted — no liveness oracle). Comments are stored by `spreadsheet_id` and never
  // join `meta_sheets`, so without this every comment route kept reading and writing a DELETED sheet's
  // threads: list/summary/presence served them, create added new ones. Every sheet-addressed comment
  // route passes through here. (Sheet-liveness closed world: tests/unit/
  // multitable-sheet-liveness-closure-all-routes.guard.test.ts.)
  if (sheetLiveness !== 'live') {
    sendSheetNotLive(res, sheetLiveness)
    return null
  }

  const deniedRowIds = new Set<string>()
  if (!access.isAdminRole && await loadRowLevelReadDenyEnabled(query, spreadsheetId)) {
    for (const rowId of await loadDeniedRecordIds(query, spreadsheetId, access.userId, denyScopeRowIds)) {
      deniedRowIds.add(rowId)
    }
  }
  return { userId: access.userId || getUserId(req), authenticatedUserId: access.userId || '', deniedRowIds }
}

type CommentIdContext = CommentReadContext & { address: CommentAddressRecord }

/**
 * #5831 — the gate of every `:commentId`-addressed route. Those routes name no sheet, so the comment's
 * OWN sheet (its stored `spreadsheet_id`, never a sheet id from the request) is looked up first and then
 * put through exactly the sheet-addressed gate above: capability 403, then the liveness 404, then the
 * row-level read deny.
 *
 * NO EXISTENCE ORACLE: an unknown comment id, a comment on a sheet the caller cannot read and a comment
 * on a row the caller is denied all get the same 403 body. 403 (not 404) because the sheet gate answers a
 * caller without read access with 403 — and the closed-world guard requires that 403 to come before the
 * liveness 404 — so an unknown id has to look like that. A caller who CAN read the sheet still learns
 * that it was deleted (404 SHEET_DELETED), exactly as on the sheet-addressed routes.
 *
 * The row deny is evaluated for the comment's own row only (`[address.rowId]`), so the context's
 * `deniedRowIds` covers that row alone; the comment-id routes never use it as a sheet-wide set.
 */
async function resolveCommentIdContext(
  req: Request,
  res: Response,
  commentService: ICommentService,
  commentId: string,
): Promise<CommentIdContext | null> {
  const address = await commentService.getCommentAddress(commentId)
  if (!address) {
    res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: COMMENT_ACCESS_FORBIDDEN_MESSAGE } })
    return null
  }
  const context = await resolveCommentReadContext(req, res, address.spreadsheetId, [address.rowId])
  if (!context) return null
  if (isRowDenied(context, address.rowId)) {
    res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: COMMENT_ACCESS_FORBIDDEN_MESSAGE } })
    return null
  }
  return { ...context, address }
}

/**
 * #5831 part B — the readable subset of `liveSheetIds` for the cross-sheet aggregates, by the rule the
 * sheet gate above applies to ONE sheet (resolveSheetReadableCapabilities → resolveSheetCapabilitiesForAccess),
 * computed once for the whole set. `filterReadableSheetRowsForAccess` is that rule for a list — the sheet
 * and base list routes use it: sheet grants over the global codes, approval-projection sheets only for
 * their participants, e-learning projection sheets only for their org. It lets an ADMIN through before
 * its e-learning check, which the single-sheet gate does not (restrictElearningProjectionCapabilities
 * applies to admins too), so for an admin that one check is repeated here with the gate's own two
 * helpers — otherwise an admin's inbox could list a comment whose `/read` answers 403.
 */
async function resolveInboxReadableSheetIds(
  query: QueryFn,
  access: ResolvedRequestAccess,
  liveSheetIds: string[],
): Promise<string[]> {
  const readable = (await filterReadableSheetRowsForAccess(query, liveSheetIds.map((id) => ({ id })), access))
    .map((row) => row.id)
  if (!access.isAdminRole || readable.length === 0) return readable
  const elearningOrgBySheet = await loadElearningProjectionSheetOrgMap(query, readable)
  return readable.filter((id) => !elearningOrgBySheet.has(id)
    || canAccessElearningProjectionSheet(access, id, elearningOrgBySheet.get(id) ?? null))
}

/**
 * #5831 part B — WHICH comments the cross-sheet aggregates (GET /api/comments/inbox and GET
 * /api/comments/unread-count) may list and count for the caller: the ones a comment-id route would let
 * the same caller act on, so every listed item can be marked read.
 *
 *  - IDENTITY: the authenticated user only (`resolveRequestAccess`, i.e. `req.user`), never the
 *    `x-user-id` header. No authenticated user ⇒ an empty scope: nothing is listed and no query runs.
 *  - LIVE: sheets whose `meta_sheets` row exists and is not soft-deleted (loadSheetLivenessBatch, the
 *    batched twin of the gate's loadSheetLiveness). Admins included, as on the sheet-addressed routes.
 *  - READABLE: resolveInboxReadableSheetIds, the gate's read rule for the whole set.
 *  - ROW DENY: for a non-admin, on every readable live sheet with row-level read deny switched on
 *    (loadRowLevelReadDenyEnabled), the rows loadDeniedRecordIds denies — asked only about the rows that
 *    carry a candidate comment for this caller. Admins skip it, as on the sheet-addressed routes.
 *
 * The service applies the scope in SQL, in the WHERE of the COUNT and of the page query (before
 * LIMIT/OFFSET), so `total`, the unread counts and the pages all agree with what is listed.
 *
 * COST, once per request: 1 query for the candidate sheets (the distinct sheets holding a comment by
 * someone else that the caller has not read or is mentioned in), 1 liveness query, a fixed number of
 * batched readable-set queries (independent of the number of sheets; one more for an admin), then, for
 * a non-admin, one row-deny flag lookup per readable live candidate sheet (K) and — only when at least
 * one of them has row deny on — 1 query for their candidate rows plus one row-bounded
 * loadDeniedRecordIds per such sheet. K is at most the number of live sheets that hold a comment
 * addressed to the caller.
 */
async function resolveCommentInboxScope(
  req: Request,
  commentService: ICommentService,
): Promise<{ userId: string; scope: CommentInboxScope }> {
  const access = await resolveRequestAccess(req)
  const userId = access.userId
  if (userId.trim().length === 0) return { userId: '', scope: { sheetIds: [], deniedRows: [] } }
  const pool = poolManager.get()
  const query = pool.query.bind(pool)
  const candidateSheetIds = await commentService.listInboxCandidateSheetIds(userId)
  const liveness = await loadSheetLivenessBatch(query, candidateSheetIds)
  const liveSheetIds = candidateSheetIds.filter((sheetId) => liveness.get(sheetId) === 'live')
  const readableSheetIds = await resolveInboxReadableSheetIds(query, access, liveSheetIds)
  const deniedRows: CommentInboxDeniedRow[] = []
  if (!access.isAdminRole) {
    const rowDenySheetIds: string[] = []
    for (const sheetId of readableSheetIds) {
      if (await loadRowLevelReadDenyEnabled(query, sheetId)) rowDenySheetIds.push(sheetId)
    }
    const candidateRows = rowDenySheetIds.length > 0
      ? await commentService.listInboxCandidateRowIds(userId, rowDenySheetIds)
      : new Map<string, string[]>()
    for (const sheetId of rowDenySheetIds) {
      const rowIds = candidateRows.get(sheetId) ?? []
      if (rowIds.length === 0) continue
      for (const rowId of await loadDeniedRecordIds(query, sheetId, userId, rowIds)) {
        deniedRows.push({ spreadsheetId: sheetId, rowId })
      }
    }
  }
  return { userId, scope: { sheetIds: readableSheetIds, deniedRows } }
}

/** #5840 — the refusal for a mark-all-read that names someone other than the caller. Values-free. */
const MARK_READ_OTHER_USER_MESSAGE = 'Comments can only be marked read for the signed-in user'

/**
 * #5808 — whose comments on a list page get `mentionLabels` (see CommentService.getComments). Only an
 * interactive session caller's own comments, i.e. the comments the edit UI can open: an API-token
 * request (`apiTokenId`, set by apiTokenAuth) gets none — the token surface cannot reach the mention
 * search either, so labels there would be a new disclosure — and so does a request without an
 * authenticated user id.
 */
function mentionLabelsAuthorFor(req: Request, context: CommentReadContext): string | undefined {
  if (typeof req.apiTokenId === 'string' && req.apiTokenId.length > 0) return undefined
  const authorId = context.authenticatedUserId.trim()
  return authorId.length > 0 ? authorId : undefined
}

function isRowDenied(context: CommentReadContext, rowId?: string): boolean {
  return typeof rowId === 'string' && rowId.trim().length > 0 && context.deniedRowIds.has(rowId.trim())
}

function deniedRows(context: CommentReadContext): string[] {
  return [...context.deniedRowIds]
}

function filterDeniedRows(rowIds: string[] | undefined, context: CommentReadContext): string[] | undefined {
  if (!rowIds) return undefined
  return rowIds.filter((rowId) => !isRowDenied(context, rowId))
}

/**
 * #5795 — the ONE place both @-mention candidate routes apply their disclosure bounds (same three
 * bounds #5781 put on GET /api/multitable/sheets/:sheetId/person-fields/:fieldId/directory, same
 * response markers). Called only AFTER the route's existing gates (rbacGuard + the G-8 sheet-read
 * gate), so a caller that could not read the sheet still gets the same 403 as before.
 *
 *  (a) TERM REQUIRED. A term shorter than MENTION_CANDIDATES_MIN_QUERY_LENGTH (after trim) is answered
 *      with an empty page and `requiresQuery: true`, and the service is NOT called — zero hydration.
 *      A 200 marker rather than a 400 because the composer asks as soon as the user types a bare `@`;
 *      the UI renders the marker as "type to search", not as a failure. NOT a narrowing guarantee: a
 *      one-character term (almost) every row contains (`-` in every UUID-shaped id, `@` in every
 *      well-formed email address) still matches (almost) everyone, so against a deliberate caller (b)
 *      is the only per-request bound; (a) removes
 *      the UI's automatic term-less request (see comment-mention-bounds.ts).
 *  (b) CEILING. `limit` is clamped to MENTION_CANDIDATES_MAX_ITEMS and the service is asked for ONE
 *      row past it; `hasMore` is true iff that probe row came back (the queryRecordsWithCursor /
 *      #5781 convention — no second COUNT query).
 *  (c) NO DEPLOYMENT-WIDE COUNT. The service no longer computes one; callers report `total` as the
 *      clamped page size (the #5781 / sibling /permission-candidates convention), never a population.
 *
 * ELIGIBILITY IS UNCHANGED: who can be returned for a matching term is still every active user
 * (CommentService.listMentionCandidates's predicate is untouched). Narrowing that set — e.g. to the
 * sheet's readers — is a separate change and is NOT done here.
 *
 * #5809 — `exactEmail` (GET /api/comments/mention-candidates?match=exact-email) asks the service for
 * EMAIL EQUALITY instead of the substring search. (a)–(c) apply unchanged — a term is still required
 * and the ceiling still clamps — and the rows can only be fewer (see CommentService).
 */
async function loadBoundedMentionCandidates(
  commentService: ICommentService,
  spreadsheetId: string,
  rawQuery: string | undefined,
  requestedLimit: number,
  exactEmail = false,
): Promise<{
  items: CommentMentionCandidate[]
  limit: number
  query: string
  hasMore: boolean
  requiresQuery: boolean
  minQueryLength: number
}> {
  const limit = Math.min(requestedLimit, MENTION_CANDIDATES_MAX_ITEMS)
  const query = (rawQuery ?? '').trim()
  if (query.length < MENTION_CANDIDATES_MIN_QUERY_LENGTH) {
    return { items: [], limit, query: '', hasMore: false, requiresQuery: true, minQueryLength: MENTION_CANDIDATES_MIN_QUERY_LENGTH }
  }
  const result = await commentService.listMentionCandidates(
    spreadsheetId,
    exactEmail ? { q: query, limit: limit + 1, match: 'exact-email' } : { q: query, limit: limit + 1 },
  )
  const hasMore = result.items.length > limit
  const items = hasMore ? result.items.slice(0, limit) : result.items
  return { items, limit, query, hasMore, requiresQuery: false, minQueryLength: MENTION_CANDIDATES_MIN_QUERY_LENGTH }
}

export function commentsRouter(injector?: Injector): Router {
  const router = Router()
  const commentService = injector?.get(ICommentService)

  if (!commentService) {
    router.use('/api/comments', (_req, res) => {
      return res.status(500).json({
        ok: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'CommentService unavailable' },
      })
    })
    return router
  }

  router.get('/api/comments', apiTokenAuth, requireScope('comments:read'), rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    const schema = z.object({
      spreadsheetId: z.string().min(1).optional(),
      containerId: z.string().min(1).optional(),
      rowId: z.string().min(1).optional(),
      targetId: z.string().min(1).optional(),
      fieldId: z.string().min(1).optional(),
      targetFieldId: z.string().min(1).optional(),
      resolved: z.boolean().optional(),
      limit: z.number().int().nonnegative().optional(),
      offset: z.number().int().nonnegative().optional(),
    })
    const parsed = schema.safeParse({
      spreadsheetId: readQueryValue(req.query.spreadsheetId),
      containerId: readQueryValue(req.query.containerId),
      rowId: readQueryValue(req.query.rowId),
      targetId: readQueryValue(req.query.targetId),
      fieldId: readQueryValue(req.query.fieldId),
      targetFieldId: readQueryValue(req.query.targetFieldId),
      resolved: parseBoolean(readQueryValue(req.query.resolved)),
      limit: parseNumberParam(readQueryValue(req.query.limit)),
      offset: parseNumberParam(readQueryValue(req.query.offset)),
    })
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const spreadsheetId = pickFirstNonEmpty(parsed.data.containerId, parsed.data.spreadsheetId)
      if (!spreadsheetId) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'spreadsheetId or containerId required' } })
      }
      const context = await resolveCommentReadContext(req, res, spreadsheetId)
      if (!context) return // G-8 sheet-visibility gate
      const requestedRowId = pickFirstNonEmpty(parsed.data.targetId, parsed.data.rowId)
      if (isRowDenied(context, requestedRowId)) {
        const limit = clampLimit(parsed.data.limit)
        const offset = clampOffset(parsed.data.offset)
        return res.json({ ok: true, data: { items: [], total: 0, limit, offset } })
      }
      const limit = clampLimit(parsed.data.limit)
      const offset = clampOffset(parsed.data.offset)
      const options: CommentQueryOptions = {
        rowId: parsed.data.rowId,
        targetId: parsed.data.targetId,
        fieldId: parsed.data.fieldId,
        targetFieldId: parsed.data.targetFieldId,
        resolved: parsed.data.resolved,
        limit,
        offset,
        // B6: lets getComments compute reactedByMe on each comment's reactions.
        viewerId: context.userId,
        excludeRowIds: deniedRows(context),
      }
      const mentionLabelsAuthorId = mentionLabelsAuthorFor(req, context)
      if (mentionLabelsAuthorId) options.mentionLabelsAuthorId = mentionLabelsAuthorId
      const result = await commentService.getComments(spreadsheetId, options)
      return res.json({ ok: true, data: { items: result.items, total: result.total, limit, offset } })
    } catch (error) {
      logger.error('Failed to list comments', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list comments' } })
    }
  })

  router.get('/api/comments/mention-candidates', rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    const schema = z.object({
      spreadsheetId: z.string().min(1),
      q: z.string().optional(),
      limit: z.number().int().nonnegative().optional(),
    })
    const parsed = schema.safeParse({
      spreadsheetId: readQueryValue(req.query.spreadsheetId),
      q: readQueryValue(req.query.q),
      limit: parseNumberParam(readQueryValue(req.query.limit)),
    })
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }
    // #5809: opt-in email-equality lookup (legacy person import). Any other `match` value keeps the
    // substring search exactly as before.
    const exactEmail = readQueryValue(req.query.match) === 'exact-email'

    try {
      const context = await resolveCommentReadContext(req, res, parsed.data.spreadsheetId)
      if (!context) return // G-8 sheet-visibility gate
      // #5795: term required, clamped to the ceiling, no deployment-wide count — see
      // loadBoundedMentionCandidates. `total` is the size of THIS (clamped) page, never a population.
      const bounded = await loadBoundedMentionCandidates(
        commentService,
        parsed.data.spreadsheetId,
        parsed.data.q,
        clampLimit(parsed.data.limit),
        exactEmail,
      )
      return res.json({
        ok: true,
        data: {
          items: bounded.items,
          total: bounded.items.length,
          limit: bounded.limit,
          query: bounded.query,
          hasMore: bounded.hasMore,
          requiresQuery: bounded.requiresQuery,
          minQueryLength: bounded.minQueryLength,
        },
      })
    } catch (error) {
      logger.error('Failed to load comment mention candidates', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load comment mention candidates' } })
    }
  })

  router.get('/api/comments/inbox', rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    const schema = z.object({
      limit: z.number().int().nonnegative().optional(),
      offset: z.number().int().nonnegative().optional(),
    })
    const parsed = schema.safeParse({
      limit: parseNumberParam(readQueryValue(req.query.limit)),
      offset: parseNumberParam(readQueryValue(req.query.offset)),
    })
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const limit = clampLimit(parsed.data.limit)
      const offset = clampOffset(parsed.data.offset)
      // #5831 part B: only readable, live sheets and non-denied rows, filtered before COUNT/LIMIT.
      const inbox = await resolveCommentInboxScope(req, commentService)
      const result = await commentService.getInbox(inbox.userId, { limit, offset }, inbox.scope)
      return res.json({ ok: true, data: { items: result.items, total: result.total, limit, offset } })
    } catch (error) {
      logger.error('Failed to load comment inbox', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load comment inbox' } })
    }
  })

  router.get('/api/comments/unread-count', rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    try {
      // #5831 part B: counts the same comments the inbox can list (see resolveCommentInboxScope).
      const inbox = await resolveCommentInboxScope(req, commentService)
      const summary = await commentService.getUnreadSummary(inbox.userId, inbox.scope)
      return res.json({
        ok: true,
        data: {
          unreadCount: summary.unreadCount,
          mentionUnreadCount: summary.mentionUnreadCount,
          /** @deprecated Use `unreadCount` instead. Kept for backward compatibility. */
          count: summary.unreadCount,
        },
      })
    } catch (error) {
      logger.error('Failed to load unread comment count', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load unread comment count' } })
    }
  })

  router.get('/api/comments/mention-summary', rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    const schema = z.object({
      spreadsheetId: z.string().min(1).optional(),
      containerId: z.string().min(1).optional(),
    })
    const parsed = schema.safeParse({
      spreadsheetId: readQueryValue(req.query.spreadsheetId),
      containerId: readQueryValue(req.query.containerId),
    })
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const spreadsheetId = pickFirstNonEmpty(parsed.data.containerId, parsed.data.spreadsheetId)
      if (!spreadsheetId) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'spreadsheetId or containerId required' } })
      }
      const context = await resolveCommentReadContext(req, res, spreadsheetId)
      if (!context) return // G-8 sheet-visibility gate
      const result = await commentService.getMentionSummary(spreadsheetId, context.userId, deniedRows(context))
      return res.json({ ok: true, data: result })
    } catch (error) {
      logger.error('Failed to load mention summary', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load mention summary' } })
    }
  })

  // Shared by GET (ids in the query string) and POST (ids in the JSON body).
  // The POST variant exists because the grid sends every visible row id per
  // page — inlined in the query string the URL grows with page size toward
  // 414/URL-length limits. GET stays for rolling-deploy compat and keeps its
  // OAPI-1 `mst_`-token mount. The POST route is JWT-session-only BY GUARD
  // SHAPE: rbacGuard only, same as the deferred comment surfaces
  // (inbox/unread-count/mention-*). Mounting apiTokenAuth+requireScope here
  // without an allowlist entry would be a dead guard (an `mst_` bearer 401s
  // at the global gate first) — exactly what the #3365 allowlist⟺guard
  // tripwire rejects; widening the allowlist instead is an auth-boundary
  // change needing its own design review.
  // Bounds (Codex review): the id set must not become an unbounded PostgreSQL
  // IN list. The grid's visible page is at most a few hundred rows; 5000 ids /
  // 128 chars per id is generous headroom. Over-limit -> 400 before the
  // service is ever reached. Applies to GET and POST alike (shared schema).
  const SUMMARY_MAX_ROW_IDS = 5000
  const SUMMARY_MAX_ROW_ID_LENGTH = 128
  const handleCommentSummary = async (
    req: Request,
    res: Response,
    raw: { spreadsheetId?: unknown; containerId?: unknown; rowIds?: unknown; targetIds?: unknown },
  ) => {
    const schema = z.object({
      spreadsheetId: z.string().min(1).optional(),
      containerId: z.string().min(1).optional(),
      rowIds: z.array(z.string().min(1).max(SUMMARY_MAX_ROW_ID_LENGTH)).max(SUMMARY_MAX_ROW_IDS).optional(),
      targetIds: z.array(z.string().min(1).max(SUMMARY_MAX_ROW_ID_LENGTH)).max(SUMMARY_MAX_ROW_IDS).optional(),
    })
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const spreadsheetId = pickFirstNonEmpty(parsed.data.containerId, parsed.data.spreadsheetId)
      if (!spreadsheetId) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'spreadsheetId or containerId required' } })
      }
      const context = await resolveCommentReadContext(req, res, spreadsheetId)
      if (!context) return // G-8 sheet-visibility gate
      const rowIds = filterDeniedRows(parsed.data.targetIds ?? parsed.data.rowIds, context)
      const result = await commentService.getCommentPresenceSummary(
        spreadsheetId,
        rowIds,
        context.userId,
        deniedRows(context),
      )
      return res.json({ ok: true, data: { items: result.items, total: result.total } })
    } catch (error) {
      logger.error('Failed to list comment summaries', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list comment summaries' } })
    }
  }

  router.get('/api/comments/summary', apiTokenAuth, requireScope('comments:read'), rbacGuard('comments', 'read'), async (req: Request, res: Response) =>
    handleCommentSummary(req, res, {
      spreadsheetId: readQueryValue(req.query.spreadsheetId),
      containerId: readQueryValue(req.query.containerId),
      rowIds: readQueryValues(req.query.rowIds),
      targetIds: readQueryValues(req.query.targetIds),
    }))

  router.post('/api/comments/summary', rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    return handleCommentSummary(req, res, {
      spreadsheetId: body.spreadsheetId,
      containerId: body.containerId,
      rowIds: body.rowIds,
      targetIds: body.targetIds,
    })
  })

  router.post('/api/comments', apiTokenAuth, oapiWriteAuditBoundary('create', 'comments:write'), apiTokenWriteRateLimit, requireScope('comments:write'), rbacGuard('comments', 'write'), async (req: Request, res: Response) => {
    const schema = z.object({
      spreadsheetId: z.string().min(1).optional(),
      containerId: z.string().min(1).optional(),
      rowId: z.string().min(1).optional(),
      targetId: z.string().min(1).optional(),
      fieldId: z.string().min(1).optional(),
      targetFieldId: z.string().min(1).optional(),
      content: z.string().min(1),
      parentId: z.string().min(1).optional(),
      mentions: z.array(z.string().min(1)).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const spreadsheetId = pickFirstNonEmpty(parsed.data.containerId, parsed.data.spreadsheetId)
      const rowId = pickFirstNonEmpty(parsed.data.targetId, parsed.data.rowId)
      const fieldId = pickFirstNonEmpty(parsed.data.targetFieldId, parsed.data.fieldId)
      if (!spreadsheetId) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'spreadsheetId or containerId required' } })
      }
      if (!rowId) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'rowId or targetId required' } })
      }
      const context = await resolveCommentReadContext(req, res, spreadsheetId)
      if (!context) return // G-8 sheet-visibility gate (canComment && canRead)
      if (isRowDenied(context, rowId)) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Not permitted to comment on this record' } })
      }
      const comment = await commentService.createComment({
        spreadsheetId,
        containerId: spreadsheetId,
        rowId,
        targetId: rowId,
        fieldId,
        targetFieldId: fieldId,
        content: parsed.data.content,
        parentId: parsed.data.parentId,
        mentions: parsed.data.mentions,
        authorId: context.userId,
        oapiAudit: buildOapiAuditContext(req, 'create', 'comments:write'),
      })
      return res.status(201).json({ ok: true, data: { comment } })
    } catch (error) {
      logger.error('Failed to create comment', error as Error)
      return respondCommentError(res, error, 'Failed to create comment')
    }
  })

  router.patch('/api/comments/:commentId', rbacGuard('comments', 'write'), async (req: Request, res: Response) => {
    const commentId = req.params.commentId
    if (!commentId || commentId.trim().length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'commentId required' } })
    }

    const schema = z.object({
      content: z.string().min(1),
      mentions: z.array(z.string().min(1)).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const context = await resolveCommentIdContext(req, res, commentService, commentId)
      if (!context) return // #5831: the comment's own sheet — read gate, liveness, row deny
      const comment = await commentService.updateComment(commentId, getUserId(req), parsed.data)
      return res.json({ ok: true, data: { comment } })
    } catch (error) {
      logger.error('Failed to update comment', error as Error)
      return respondCommentError(res, error, 'Failed to update comment')
    }
  })

  router.delete('/api/comments/:commentId', rbacGuard('comments', 'write'), async (req: Request, res: Response) => {
    const commentId = req.params.commentId
    if (!commentId || commentId.trim().length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'commentId required' } })
    }

    try {
      const context = await resolveCommentIdContext(req, res, commentService, commentId)
      if (!context) return // #5831: the comment's own sheet — read gate, liveness, row deny
      await commentService.deleteComment(commentId, getUserId(req))
      return res.status(204).end()
    } catch (error) {
      logger.error('Failed to delete comment', error as Error)
      return respondCommentError(res, error, 'Failed to delete comment')
    }
  })

  router.post('/api/comments/:commentId/read', rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    const commentId = req.params.commentId
    if (!commentId || commentId.trim().length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'commentId required' } })
    }

    try {
      const context = await resolveCommentIdContext(req, res, commentService, commentId)
      if (!context) return // #5831: the comment's own sheet — read gate, liveness, row deny
      await commentService.markCommentRead(commentId, getUserId(req))
      return res.status(204).end()
    } catch (error) {
      logger.error('Failed to mark comment as read', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to mark comment as read' } })
    }
  })

  // B6 reactions. Gate = comments:write (a reaction is an attributed, persistent,
  // visible artifact = create-bucket, like createComment — NOT a read-receipt).
  // The emoji travels in the BODY for both add and remove (Express allows a
  // DELETE body) to sidestep multi-codepoint path-encoding drift (e.g. `❤️`).
  router.post('/api/comments/:commentId/reactions', rbacGuard('comments', 'write'), async (req: Request, res: Response) => {
    const commentId = req.params.commentId
    if (!commentId || commentId.trim().length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'commentId required' } })
    }
    const parsed = z.object({ emoji: z.string().min(1) }).safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const context = await resolveCommentIdContext(req, res, commentService, commentId)
      if (!context) return // #5831: the comment's own sheet — read gate, liveness, row deny
      await commentService.addReaction(commentId, getUserId(req), parsed.data.emoji)
      return res.status(201).json({ ok: true, data: {} })
    } catch (error) {
      logger.error('Failed to add comment reaction', error as Error)
      return respondCommentError(res, error, 'Failed to add comment reaction')
    }
  })

  router.delete('/api/comments/:commentId/reactions', rbacGuard('comments', 'write'), async (req: Request, res: Response) => {
    const commentId = req.params.commentId
    if (!commentId || commentId.trim().length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'commentId required' } })
    }
    const parsed = z.object({ emoji: z.string().min(1) }).safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const context = await resolveCommentIdContext(req, res, commentService, commentId)
      if (!context) return // #5831: the comment's own sheet — read gate, liveness, row deny
      await commentService.removeReaction(commentId, getUserId(req), parsed.data.emoji)
      return res.status(204).end()
    } catch (error) {
      logger.error('Failed to remove comment reaction', error as Error)
      return respondCommentError(res, error, 'Failed to remove comment reaction')
    }
  })

  router.post('/api/comments/mention-summary/mark-read', rbacGuard('comments', 'write'), async (req: Request, res: Response) => {
    const schema = z.object({
      spreadsheetId: z.string().min(1),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const context = await resolveCommentReadContext(req, res, parsed.data.spreadsheetId)
      if (!context) return // G-8 sheet-visibility gate
      await commentService.markMentionsRead(parsed.data.spreadsheetId, context.userId, deniedRows(context))
      return res.status(204).send()
    } catch (error) {
      logger.error('Failed to mark mentions read', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to mark mentions read' } })
    }
  })

  router.post('/api/comments/:commentId/resolve', rbacGuard('comments', 'write'), async (req: Request, res: Response) => {
    const commentId = req.params.commentId
    if (!commentId || commentId.trim().length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'commentId required' } })
    }

    try {
      // #5831 (coordinator decision): resolving needs read access to the comment's live sheet and row
      // (this gate) plus comments:write (rbacGuard above). A stricter rule is tracked in #5841.
      const context = await resolveCommentIdContext(req, res, commentService, commentId)
      if (!context) return // #5831: the comment's own sheet — read gate, liveness, row deny
      await commentService.resolveComment(commentId)
      return res.status(204).end()
    } catch (error) {
      logger.error('Failed to resolve comment', error as Error)
      return respondCommentError(res, error, 'Failed to resolve comment')
    }
  })

  // ── Multitable-namespaced routes (Week-2 collab UX) ─────────────────────

  /**
   * GET /api/multitable/:spreadsheetId/mention-candidates
   *
   * Search for @-mention candidates scoped to a spreadsheet.
   * Query params: q (search string), limit (max 10 by default for composer UX)
   *
   * #5795: same bounds as /api/comments/mention-candidates (loadBoundedMentionCandidates) — this route
   * reads the SAME service behind the SAME gate, so leaving it term-optional would have kept the
   * roster one request away. No in-repo UI calls it; the additive `limit`/`query`/`hasMore`/
   * `requiresQuery`/`minQueryLength` fields let an external caller tell "type to search" apart from
   * "no match".
   */
  router.get('/api/multitable/:spreadsheetId/mention-candidates', rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    const spreadsheetId = req.params.spreadsheetId?.trim()
    if (!spreadsheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'spreadsheetId required' } })
    }

    const schema = z.object({
      q: z.string().optional(),
      limit: z.number().int().nonnegative().optional(),
    })
    const parsed = schema.safeParse({
      q: readQueryValue(req.query.q),
      limit: parseNumberParam(readQueryValue(req.query.limit)),
    })
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const context = await resolveCommentReadContext(req, res, spreadsheetId)
      if (!context) return // G-8 sheet-visibility gate
      const bounded = await loadBoundedMentionCandidates(
        commentService,
        spreadsheetId,
        parsed.data.q,
        clampLimit(parsed.data.limit ?? 10),
      )
      // Map to { userId, displayName } shape expected by the mention composer
      const items = bounded.items.map((candidate) => ({
        userId: candidate.id,
        displayName: candidate.label,
        avatarUrl: undefined as string | undefined,
      }))
      return res.json({
        ok: true,
        data: {
          items,
          limit: bounded.limit,
          query: bounded.query,
          hasMore: bounded.hasMore,
          requiresQuery: bounded.requiresQuery,
          minQueryLength: bounded.minQueryLength,
        },
      })
    } catch (error) {
      logger.error('Failed to load mention candidates', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load mention candidates' } })
    }
  })

  /**
   * POST /api/multitable/:spreadsheetId/comments/mark-all-read
   * Body: { userId?: string } — optional and only accepted when it names the signed-in user.
   *
   * Batch-mark all unread comments in this spreadsheet as read for the signed-in user.
   *
   * #5840: the body `userId` used to pick WHOSE read state was written, so any comments:write holder who
   * could read the sheet could clear another user's unread comments (and the row deny applied was the
   * caller's, not the target's). The write now always targets the caller; a body `userId` naming anyone
   * else is refused with 403 (an authorization refusal — the request is well-formed but asks to act for
   * another principal) instead of being silently ignored, so a client relying on it notices.
   */
  router.post('/api/multitable/:spreadsheetId/comments/mark-all-read', rbacGuard('comments', 'write'), async (req: Request, res: Response) => {
    const spreadsheetId = req.params.spreadsheetId?.trim()
    if (!spreadsheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'spreadsheetId required' } })
    }

    const schema = z.object({
      userId: z.string().min(1).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const context = await resolveCommentReadContext(req, res, spreadsheetId)
      if (!context) return // G-8 sheet-visibility gate
      const requestedUserId = parsed.data.userId?.trim()
      if (requestedUserId && requestedUserId !== context.userId.trim()) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: MARK_READ_OTHER_USER_MESSAGE } })
      }
      const count = await commentService.markAllCommentsRead(spreadsheetId, context.userId, deniedRows(context))
      return res.json({ ok: true, data: { markedRead: count } })
    } catch (error) {
      logger.error('Failed to mark all comments as read', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to mark all comments as read' } })
    }
  })

  /**
   * GET /api/multitable/:spreadsheetId/comments/presence
   * Query params: rowIds, includeViewers (bool)
   *
   * Returns comment presence summary per row. When includeViewers=true the
   * response also includes a `viewers` array of users currently in the room.
   */
  router.get('/api/multitable/:spreadsheetId/comments/presence', apiTokenAuth, requireScope('comments:read'), rbacGuard('comments', 'read'), async (req: Request, res: Response) => {
    const spreadsheetId = req.params.spreadsheetId?.trim()
    if (!spreadsheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'spreadsheetId required' } })
    }

    const schema = z.object({
      rowIds: z.array(z.string().min(1)).optional(),
      includeViewers: z.boolean().optional(),
    })
    const parsed = schema.safeParse({
      rowIds: readQueryValues(req.query.rowIds),
      includeViewers: parseBoolean(readQueryValue(req.query.includeViewers ?? req.query.includViewers)),
    })
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const context = await resolveCommentReadContext(req, res, spreadsheetId)
      if (!context) return // G-8 sheet-visibility gate
      const result = await commentService.getCommentPresenceSummaryWithViewers(
        spreadsheetId,
        filterDeniedRows(parsed.data.rowIds, context),
        context.userId,
        // OAPI-1 comments:read — a token request can read presence counts but MUST NOT egress viewer
        // identities (a creator-acting token shouldn't surface who-is-viewing). Force includeViewers=false
        // on the token path regardless of the query param; session requests are unchanged.
        req.apiTokenScopes ? false : (parsed.data.includeViewers ?? false),
        deniedRows(context),
      )
      return res.json({ ok: true, data: result })
    } catch (error) {
      logger.error('Failed to load comment presence', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load comment presence' } })
    }
  })

  return router
}
