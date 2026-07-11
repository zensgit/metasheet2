/**
 * PLM-COLLAB Discussion Phase-3 WRITE relay (Lane C write-relay; taskbook
 * docs/development/plm-discussion-consumer-taskbook-20260709.md §4's Gate-2 REWORKED contract,
 * Yuantus provider #1188 ratified/merged).
 *
 * Wires PLMAdapter's 6 discussion write methods (+ exchangeDiscussionSession) into a dedicated
 * write surface under the SAME `/api/plm-embed/` prefix as the read relay (plm-embed.ts) --
 * whitelisted from the global session-JWT gate (jwt-middleware.ts's AUTH_WHITELIST prefix match)
 * and gated solely by `embedTokenAuth`.
 *
 * **Design: Option A (stateless, single-use per write) -- RATIFIED by the owner at Gate-2
 * 2026-07-11 (Option B, a server-side credential cache, remains deferred).**
 * Every write request carries its OWN freshly-minted BOM-review embed token
 * (`X-PLM-Embed-Token`, feature_key="bom_multitable"). The route:
 *   1. runs the SAME guards as the read relay (feature_key / embed_origin / data-source resolve
 *      + connect / tenant cross-check) and consumes the token's jti via the SAME shared single-use
 *      store the read relay uses -- one embed token authorizes exactly one relay call, read OR
 *      write, ever.
 *   2. exchanges the raw embed JWT (`req.embedTokenRaw`, set by embedTokenAuth -- see that file's
 *      docstring) for a Yuantus discussion-session credential via
 *      `PLMAdapter.exchangeDiscussionSession`.
 *   3. holds the credential's `access_token` in a LOCAL const for the lifetime of this handler
 *      only, passes it straight into the matching write method, and lets it fall out of scope
 *      when the handler returns. It is NEVER assigned to `req`, the adapter instance, module
 *      scope, or any cache -- so there is no new stateful credential-storage surface (that is
 *      explicitly deferred as "Option B", see the taskbook note this PR adds).
 *   4. returns ONLY the write result (`result.data[0]`) -- the credential itself never appears in
 *      any response body or header.
 *
 * A transient failure AFTER the jti is consumed (e.g. the provider write itself 5xx's) still
 * burns the embed token -- Option A's tradeoff is explicitly one-shot; the embed frontend must
 * re-mint and retry, not assume a second attempt is free.
 */
import { Router, type Request, type Response } from 'express'
import { getDataSourceManager } from './data-sources'
import { embedTokenAuth } from '../middleware/embed-token-auth'
import { embedAllowedOrigins, embedDataSourceId } from '../auth/embed-config'
import { consumeEmbedJti, embedJtiKey } from '../auth/embed-jti-store'
import type { QueryResult } from '../data-adapters/BaseAdapter'
import type {
  AddCommentRequest,
  CreateThreadRequest,
  DiscussionSessionCredential,
  DiscussionTargetType,
  DiscussionThreadDetail,
  EditCommentRequest,
  ThreadTransitionRequest,
} from '../data-adapters/PLMAdapter'
import type { EmbedTokenClaims } from '../auth/embed-token-verify'

const BOM_FEATURE_KEY = 'bom_multitable'
const TARGET_TYPES: ReadonlySet<DiscussionTargetType> = new Set([
  'item',
  'item_version',
  'file',
  'eco',
  'pdm_relationship',
])

interface PlmDiscussionWriteAdapter {
  exchangeDiscussionSession(embedToken: string): Promise<QueryResult<DiscussionSessionCredential>>
  createDiscussionThread(sessionToken: string, req: CreateThreadRequest): Promise<QueryResult<DiscussionThreadDetail>>
  addDiscussionComment(sessionToken: string, threadId: string, req: AddCommentRequest): Promise<QueryResult<DiscussionThreadDetail>>
  editDiscussionComment(sessionToken: string, threadId: string, commentId: string, req: EditCommentRequest): Promise<QueryResult<DiscussionThreadDetail>>
  deleteDiscussionComment(sessionToken: string, threadId: string, commentId: string): Promise<QueryResult<DiscussionThreadDetail>>
  resolveDiscussionThread(sessionToken: string, threadId: string, req?: ThreadTransitionRequest): Promise<QueryResult<DiscussionThreadDetail>>
  reopenDiscussionThread(sessionToken: string, threadId: string, req?: ThreadTransitionRequest): Promise<QueryResult<DiscussionThreadDetail>>
  // tenant/connect surface, same duck-type contract the read relay enforces
  getEffectiveTenantId(): string | undefined
  isConnected(): boolean
  connect(): Promise<void>
}

function isPlmDiscussionWriteAdapter(adapter: unknown): adapter is PlmDiscussionWriteAdapter {
  const a = adapter as Partial<PlmDiscussionWriteAdapter> | null
  return typeof a?.exchangeDiscussionSession === 'function'
    && typeof a?.createDiscussionThread === 'function'
    && typeof a?.addDiscussionComment === 'function'
    && typeof a?.editDiscussionComment === 'function'
    && typeof a?.deleteDiscussionComment === 'function'
    && typeof a?.resolveDiscussionThread === 'function'
    && typeof a?.reopenDiscussionThread === 'function'
    && typeof a?.getEffectiveTenantId === 'function'
    && typeof a?.isConnected === 'function'
    && typeof a?.connect === 'function'
}

/**
 * Runs the read relay's exact guard sequence (feature_key -> embed_origin -> data-source resolve
 * -> connect -> tenant cross-check -> single-use jti consume) and, on success, returns the
 * verified claims + a connected adapter. On failure it has already written the response and
 * returns `null` -- callers must return immediately without touching the response again.
 */
async function runEmbedWriteGuards(req: Request, res: Response): Promise<{ claims: EmbedTokenClaims; adapter: PlmDiscussionWriteAdapter } | null> {
  const claims = req.embedToken!

  if (claims.feature_key !== BOM_FEATURE_KEY) {
    res.status(403).json({ ok: false, error: { code: 'EMBED_FEATURE_MISMATCH', message: 'token not scoped to bom_multitable' } })
    return null
  }
  const origin = typeof claims.embed_origin === 'string' ? claims.embed_origin : ''
  if (!origin || !embedAllowedOrigins().includes(origin)) {
    res.status(403).json({ ok: false, error: { code: 'EMBED_ORIGIN_NOT_ALLOWED', message: 'embed origin not allowed' } })
    return null
  }

  const dataSourceId = embedDataSourceId()
  if (!dataSourceId) {
    res.status(503).json({ ok: false, error: { code: 'EMBED_UNAVAILABLE', message: 'embed data source not configured' } })
    return null
  }

  let adapter: unknown
  try {
    adapter = getDataSourceManager().getDataSource(dataSourceId)
  } catch {
    res.status(503).json({ ok: false, error: { code: 'EMBED_UNAVAILABLE', message: 'embed data source unavailable' } })
    return null
  }
  if (!isPlmDiscussionWriteAdapter(adapter)) {
    res.status(503).json({ ok: false, error: { code: 'EMBED_UNAVAILABLE', message: 'embed data source unsupported' } })
    return null
  }

  try {
    if (!adapter.isConnected()) await adapter.connect()
  } catch {
    res.status(503).json({ ok: false, error: { code: 'EMBED_UNAVAILABLE', message: 'embed data source unavailable' } })
    return null
  }

  // Same fail-closed cross-check as the read relay: compare against the tenant ACTUALLY served,
  // before consuming the jti or doing any write.
  const servedTenantId = adapter.getEffectiveTenantId()
  if (!servedTenantId || claims.tenant_id !== servedTenantId) {
    res.status(403).json({ ok: false, error: { code: 'EMBED_TENANT_MISMATCH', message: 'token tenant does not match the embed data source tenant' } })
    return null
  }

  // Single-use, Option A: one embed token authorizes exactly one relay call (read OR write).
  // Consumed AFTER all other guards, BEFORE the session exchange / write -- mirrors the read
  // relay's ordering so a 403 above never burns the token.
  const jti = typeof claims.jti === 'string' ? claims.jti : ''
  if (!jti) {
    res.status(401).json({ ok: false, error: { code: 'INVALID_EMBED_TOKEN', message: 'missing jti' } })
    return null
  }
  const now = Math.floor(Date.now() / 1000)
  const ttl = Math.min(typeof claims.exp === 'number' ? claims.exp - now : 0, 600)
  if (ttl < 1) {
    res.status(401).json({ ok: false, error: { code: 'INVALID_EMBED_TOKEN', message: 'token expired' } })
    return null
  }
  let firstUse: boolean
  try {
    firstUse = await consumeEmbedJti(
      embedJtiKey({
        aud: claims.aud ?? '',
        feature_key: claims.feature_key ?? '',
        tenant_id: claims.tenant_id ?? '',
        part_id: claims.part_id,
        jti,
      }),
      ttl,
    )
  } catch {
    res.status(503).json({ ok: false, error: { code: 'EMBED_UNAVAILABLE', message: 'embed replay store unavailable' } })
    return null
  }
  if (!firstUse) {
    res.status(401).json({ ok: false, error: { code: 'EMBED_TOKEN_REPLAYED', message: 'embed token already used' } })
    return null
  }

  return { claims, adapter }
}

/**
 * Exchanges the request's raw embed token for a discussion-session credential and returns ONLY
 * its `access_token`, as a value the caller must keep local. Never logs, never returns the
 * credential object itself. A failed/empty exchange is a uniform 401 -- the adapter already
 * collapses "dark-flag off" and "bad token" into the same shape upstream, so this must not
 * re-introduce a distinction (no oracle).
 */
async function exchangeForAccessToken(req: Request, res: Response, adapter: PlmDiscussionWriteAdapter): Promise<string | null> {
  const rawToken = req.embedTokenRaw
  if (!rawToken) {
    // Should be unreachable (embedTokenAuth always sets it on success), but fail closed.
    res.status(401).json({ ok: false, error: { code: 'EMBED_SESSION_EXCHANGE_FAILED', message: 'discussion session exchange failed' } })
    return null
  }
  const cred = await adapter.exchangeDiscussionSession(rawToken)
  const credential = cred.data[0]
  if (cred.error || !credential || !credential.access_token) {
    res.status(401).json({ ok: false, error: { code: 'EMBED_SESSION_EXCHANGE_FAILED', message: 'discussion session exchange failed' } })
    return null
  }
  return credential.access_token
}

/** Reads a provider HTTP status off a QueryResult.error, mirroring routes/plm-workbench.ts's providerErrorStatus. */
function providerErrorStatus(error: unknown): number | null {
  const candidate = error as { response?: { status?: unknown } } | null
  const status = candidate?.response?.status
  return typeof status === 'number' ? status : null
}

const KNOWN_PROVIDER_STATUSES = new Set([400, 401, 403, 404, 409, 422])

/**
 * Maps a write method's QueryResult.error to a relay HTTP response. The provider's own status is
 * authoritative (taskbook §2's "Yuantus 401/403/404/422 responses are authoritative" rule) for
 * the small set of statuses this relay understands; anything else (network failure, unexpected
 * status) degrades to a generic 502 -- a write must never silently succeed on failure, and the
 * relay must never echo the raw upstream error body/message (no oracle on internals).
 */
function respondWriteError(res: Response, error: Error): void {
  const status = providerErrorStatus(error)
  if (status !== null && KNOWN_PROVIDER_STATUSES.has(status)) {
    res.status(status).json({ ok: false, error: { code: 'EMBED_DISCUSSION_WRITE_REJECTED', message: 'the discussion write was rejected' } })
    return
  }
  res.status(502).json({ ok: false, error: { code: 'EMBED_DISCUSSION_WRITE_UNAVAILABLE', message: 'the discussion write could not be completed' } })
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function optionalMentionedUserIds(body: Record<string, unknown>): number[] | undefined {
  const v = body.mentioned_user_ids
  if (v === undefined) return undefined
  return Array.isArray(v) && v.every((x) => typeof x === 'number') ? v : undefined
}

function optionalAnchor(body: Record<string, unknown>): Record<string, unknown> | null | undefined {
  const v = body.anchor
  if (v === undefined) return undefined
  if (v === null) return null
  return typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function badBody(res: Response, message: string): void {
  res.status(422).json({ ok: false, error: { code: 'EMBED_DISCUSSION_INVALID_BODY', message } })
}

export default function plmEmbedDiscussionWriteRouter(): Router {
  const router = Router()

  // POST /api/plm-embed/discussion/threads -- open a new thread.
  router.post('/api/plm-embed/discussion/threads', embedTokenAuth, async (req: Request, res: Response) => {
    const guarded = await runEmbedWriteGuards(req, res)
    if (!guarded) return

    const body = (req.body ?? {}) as Record<string, unknown>
    const targetType = body.target_type
    if (typeof targetType !== 'string' || !TARGET_TYPES.has(targetType as DiscussionTargetType)) {
      return badBody(res, 'target_type must be one of item, item_version, file, eco, pdm_relationship')
    }
    if (!isNonEmptyString(body.target_id)) return badBody(res, 'target_id is required')
    if (!isNonEmptyString(body.body)) return badBody(res, 'body is required')
    // Distinguish an ABSENT optional field (omit it) from a PRESENT-but-wrong-typed one
    // (reject 422). Silently coercing a bad value to `undefined` and omitting it would let a
    // malformed mention/anchor/title write succeed DEGRADED (no mention / no anchor / no title)
    // when the caller should have gotten a 422 -- mirrors parseTransitionRequest's guard below.
    if (body.title !== undefined && typeof body.title !== 'string') {
      return badBody(res, 'title must be a string when present')
    }
    const title = typeof body.title === 'string' ? body.title : undefined
    const mentioned_user_ids = optionalMentionedUserIds(body)
    if (body.mentioned_user_ids !== undefined && mentioned_user_ids === undefined) {
      return badBody(res, 'mentioned_user_ids must be number[] when present')
    }
    const anchor = optionalAnchor(body)
    if (body.anchor !== undefined && anchor === undefined) {
      return badBody(res, 'anchor must be an object or null when present')
    }
    const createReq: CreateThreadRequest = {
      target_type: targetType as DiscussionTargetType,
      target_id: body.target_id as string,
      body: body.body as string,
      ...(title !== undefined ? { title } : {}),
      ...(mentioned_user_ids !== undefined ? { mentioned_user_ids } : {}),
      ...(anchor !== undefined ? { anchor } : {}),
    }

    const accessToken = await exchangeForAccessToken(req, res, guarded.adapter)
    if (!accessToken) return
    const result = await guarded.adapter.createDiscussionThread(accessToken, createReq)
    if (result.error) return respondWriteError(res, result.error)
    return res.json({ ok: true, data: result.data[0] ?? null })
  })

  // POST /api/plm-embed/discussion/threads/:threadId/comments -- reply on a thread.
  router.post('/api/plm-embed/discussion/threads/:threadId/comments', embedTokenAuth, async (req: Request, res: Response) => {
    const guarded = await runEmbedWriteGuards(req, res)
    if (!guarded) return

    const threadId = req.params.threadId
    const body = (req.body ?? {}) as Record<string, unknown>
    if (!isNonEmptyString(body.body)) return badBody(res, 'body is required')
    // Present-but-wrong-typed optional fields reject 422 (never silently omit) -- see the
    // create-thread route above for the rationale.
    if (body.parent_comment_id !== undefined && typeof body.parent_comment_id !== 'string') {
      return badBody(res, 'parent_comment_id must be a string when present')
    }
    const parent_comment_id = typeof body.parent_comment_id === 'string' ? body.parent_comment_id : undefined
    const mentioned_user_ids = optionalMentionedUserIds(body)
    if (body.mentioned_user_ids !== undefined && mentioned_user_ids === undefined) {
      return badBody(res, 'mentioned_user_ids must be number[] when present')
    }
    const anchor = optionalAnchor(body)
    if (body.anchor !== undefined && anchor === undefined) {
      return badBody(res, 'anchor must be an object or null when present')
    }
    const commentReq: AddCommentRequest = {
      body: body.body as string,
      ...(parent_comment_id !== undefined ? { parent_comment_id } : {}),
      ...(mentioned_user_ids !== undefined ? { mentioned_user_ids } : {}),
      ...(anchor !== undefined ? { anchor } : {}),
    }

    const accessToken = await exchangeForAccessToken(req, res, guarded.adapter)
    if (!accessToken) return
    const result = await guarded.adapter.addDiscussionComment(accessToken, threadId, commentReq)
    if (result.error) return respondWriteError(res, result.error)
    return res.json({ ok: true, data: result.data[0] ?? null })
  })

  // PATCH /api/plm-embed/discussion/threads/:threadId/comments/:commentId -- edit a comment body.
  router.patch('/api/plm-embed/discussion/threads/:threadId/comments/:commentId', embedTokenAuth, async (req: Request, res: Response) => {
    const guarded = await runEmbedWriteGuards(req, res)
    if (!guarded) return

    const { threadId, commentId } = req.params
    const body = (req.body ?? {}) as Record<string, unknown>
    if (!isNonEmptyString(body.body)) return badBody(res, 'body is required')
    const editReq: EditCommentRequest = { body: body.body as string }

    const accessToken = await exchangeForAccessToken(req, res, guarded.adapter)
    if (!accessToken) return
    const result = await guarded.adapter.editDiscussionComment(accessToken, threadId, commentId, editReq)
    if (result.error) return respondWriteError(res, result.error)
    return res.json({ ok: true, data: result.data[0] ?? null })
  })

  // DELETE /api/plm-embed/discussion/threads/:threadId/comments/:commentId -- soft-delete a comment.
  router.delete('/api/plm-embed/discussion/threads/:threadId/comments/:commentId', embedTokenAuth, async (req: Request, res: Response) => {
    const guarded = await runEmbedWriteGuards(req, res)
    if (!guarded) return

    const { threadId, commentId } = req.params
    const accessToken = await exchangeForAccessToken(req, res, guarded.adapter)
    if (!accessToken) return
    const result = await guarded.adapter.deleteDiscussionComment(accessToken, threadId, commentId)
    if (result.error) return respondWriteError(res, result.error)
    return res.json({ ok: true, data: result.data[0] ?? null })
  })

  // POST /api/plm-embed/discussion/threads/:threadId/resolve -- transition a thread to resolved.
  router.post('/api/plm-embed/discussion/threads/:threadId/resolve', embedTokenAuth, async (req: Request, res: Response) => {
    const guarded = await runEmbedWriteGuards(req, res)
    if (!guarded) return

    const threadId = req.params.threadId
    const transitionReq = parseTransitionRequest(req.body)
    if (transitionReq === undefined) return badBody(res, 'comment must be a string and mentioned_user_ids must be number[] when present')

    const accessToken = await exchangeForAccessToken(req, res, guarded.adapter)
    if (!accessToken) return
    const result = await guarded.adapter.resolveDiscussionThread(accessToken, threadId, transitionReq)
    if (result.error) return respondWriteError(res, result.error)
    return res.json({ ok: true, data: result.data[0] ?? null })
  })

  // POST /api/plm-embed/discussion/threads/:threadId/reopen -- transition a resolved thread back to open.
  router.post('/api/plm-embed/discussion/threads/:threadId/reopen', embedTokenAuth, async (req: Request, res: Response) => {
    const guarded = await runEmbedWriteGuards(req, res)
    if (!guarded) return

    const threadId = req.params.threadId
    const transitionReq = parseTransitionRequest(req.body)
    if (transitionReq === undefined) return badBody(res, 'comment must be a string and mentioned_user_ids must be number[] when present')

    const accessToken = await exchangeForAccessToken(req, res, guarded.adapter)
    if (!accessToken) return
    const result = await guarded.adapter.reopenDiscussionThread(accessToken, threadId, transitionReq)
    if (result.error) return respondWriteError(res, result.error)
    return res.json({ ok: true, data: result.data[0] ?? null })
  })

  return router
}

/** `undefined` body -> {} (both resolve/reopen take an optional transition). `null` return = invalid shape. */
function parseTransitionRequest(rawBody: unknown): ThreadTransitionRequest | null | undefined {
  const body = (rawBody ?? {}) as Record<string, unknown>
  if (body.comment !== undefined && typeof body.comment !== 'string') return undefined
  const mentioned_user_ids = optionalMentionedUserIds(body)
  if (body.mentioned_user_ids !== undefined && mentioned_user_ids === undefined) return undefined
  const req: ThreadTransitionRequest = {}
  if (typeof body.comment === 'string') req.comment = body.comment
  if (mentioned_user_ids !== undefined) req.mentioned_user_ids = mentioned_user_ids
  return req
}
