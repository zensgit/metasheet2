/**
 * PLM-COLLAB Discussion read-auth line, metasheet2 sub-slice 2: the discussion READ relay.
 * Companion to the WRITE relay (`./plm-embed-discussion.ts` -- READ IT FIRST, this file mirrors
 * its guard sequence, transport, and error-mapping conventions deliberately). Calls the Yuantus
 * provider contract built + Opus-verified in sub-slice 1b:
 *   - `POST /api/v1/auth/embed/discussion-read-session` -- exchanges a verified embed token for a
 *     `typ=discussion_read` credential (short TTL, part-scoped). Pre-auth. Fail-closed uniform 401
 *     (dark-flag-off and a bad token are indistinguishable).
 *   - `GET /api/v1/discussions?target_type=item&target_id=<part_id>` -- list. The provider
 *     ENFORCES target_type=="item" and target_id==the credential's bound part; include_children is
 *     FORBIDDEN. Any mismatch -> uniform 404.
 *   - `GET /api/v1/discussions/{thread_id}` -- detail. The provider enforces the thread resolves
 *     back to the bound part -> uniform 404 otherwise.
 *
 * **Guard reuse: COPIED, not imported, from the write relay.** `runEmbedWriteGuards` in
 * `plm-embed-discussion.ts` is typed against `PlmDiscussionWriteAdapter` (its type guard checks
 * for all 6 write methods + `exchangeDiscussionSession`), which does not duck-type match the read
 * adapter surface this file needs (`exchangeDiscussionReadSession` +
 * `getDiscussionsWithReadToken`/`getDiscussionThreadWithReadToken`). Genericizing the shared guard
 * to accept an injected type-guard predicate would require editing the already-shipped/ratified
 * write-relay file and re-running its full test surface for a routine addition -- the guard logic
 * that actually varies by adapter shape is a single `isPlmDiscussionWriteAdapter` call, so a
 * faithful copy (`runEmbedReadGuards` below) is the lower-risk option explicitly sanctioned by the
 * taskbook. The single-use property is NOT duplicated by this copy: both relays import the SAME
 * `consumeEmbedJti`/`embedJtiKey` from `../auth/embed-jti-store`, which is backed by the shared
 * Redis store -- so a jti consumed by a write call is unavailable to a read call and vice versa,
 * regardless of which file's guard code ran. No guard is weakened relative to the write relay: same
 * feature_key check, same origin allowlist, same data-source resolve+connect+tenant cross-check,
 * same jti ttl/consume ordering (guards first, jti burned last, before any exchange/call).
 *
 * Unlike the write relay, the read credential exchange happens on EVERY GET, and the LIST route
 * never trusts a client-supplied target -- it always resolves `{ targetType: 'item', targetId:
 * claims.part_id }` from the verified embed-token claims, never from a query string, so a caller
 * cannot widen the read past the part the embed token was minted for (the provider independently
 * enforces the same binding, so this is defense in depth, not the only gate).
 */
import { Router, type Request, type Response } from 'express'
import { getDataSourceManager } from './data-sources'
import { embedTokenAuth } from '../middleware/embed-token-auth'
import { embedAllowedOrigins, embedDataSourceId } from '../auth/embed-config'
import { consumeEmbedJti, embedJtiKey } from '../auth/embed-jti-store'
import type { QueryResult } from '../data-adapters/BaseAdapter'
import type {
  DiscussionSessionCredential,
  DiscussionThreadDetail,
  DiscussionThreadListResult,
} from '../data-adapters/PLMAdapter'
import type { EmbedTokenClaims } from '../auth/embed-token-verify'

const BOM_FEATURE_KEY = 'bom_multitable'

interface PlmDiscussionReadAdapter {
  exchangeDiscussionReadSession(embedToken: string): Promise<QueryResult<DiscussionSessionCredential>>
  getDiscussionsWithReadToken(readToken: string, target: { targetType: string; targetId: string }): Promise<QueryResult<DiscussionThreadListResult>>
  getDiscussionThreadWithReadToken(readToken: string, threadId: string): Promise<QueryResult<DiscussionThreadDetail>>
  // tenant/connect surface, same duck-type contract the write relay enforces
  getEffectiveTenantId(): string | undefined
  isConnected(): boolean
  connect(): Promise<void>
}

function isPlmDiscussionReadAdapter(adapter: unknown): adapter is PlmDiscussionReadAdapter {
  const a = adapter as Partial<PlmDiscussionReadAdapter> | null
  return typeof a?.exchangeDiscussionReadSession === 'function'
    && typeof a?.getDiscussionsWithReadToken === 'function'
    && typeof a?.getDiscussionThreadWithReadToken === 'function'
    && typeof a?.getEffectiveTenantId === 'function'
    && typeof a?.isConnected === 'function'
    && typeof a?.connect === 'function'
}

/**
 * Faithful copy of the write relay's `runEmbedWriteGuards` (feature_key -> embed_origin ->
 * data-source resolve -> connect -> tenant cross-check -> single-use jti consume), adapted to the
 * read adapter duck-type. See the file docstring for why this is a copy rather than a shared
 * import. On failure it has already written the response and returns `null` -- callers must
 * return immediately without touching the response again.
 */
async function runEmbedReadGuards(req: Request, res: Response): Promise<{ claims: EmbedTokenClaims; adapter: PlmDiscussionReadAdapter } | null> {
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
  if (!isPlmDiscussionReadAdapter(adapter)) {
    res.status(503).json({ ok: false, error: { code: 'EMBED_UNAVAILABLE', message: 'embed data source unsupported' } })
    return null
  }

  try {
    if (!adapter.isConnected()) await adapter.connect()
  } catch {
    res.status(503).json({ ok: false, error: { code: 'EMBED_UNAVAILABLE', message: 'embed data source unavailable' } })
    return null
  }

  // Same fail-closed cross-check as the write relay: compare against the tenant ACTUALLY served,
  // before consuming the jti or doing any read.
  const servedTenantId = adapter.getEffectiveTenantId()
  if (!servedTenantId || claims.tenant_id !== servedTenantId) {
    res.status(403).json({ ok: false, error: { code: 'EMBED_TENANT_MISMATCH', message: 'token tenant does not match the embed data source tenant' } })
    return null
  }

  // Single-use, shared with the write relay: one embed token authorizes exactly one relay call
  // (read OR write), ever -- the SAME consumeEmbedJti/embedJtiKey backed by the shared Redis
  // store. Consumed AFTER all other guards, BEFORE the session exchange / read.
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
 * Exchanges the request's raw embed token for a discussion READ credential and returns ONLY its
 * `access_token`, as a value the caller must keep local -- never assigned to `req`, the adapter
 * instance, module scope, or any cache. A failed/empty exchange is a uniform 401 (mirrors the
 * write relay's `exchangeForAccessToken`): the adapter already collapses "dark-flag off" and "bad
 * token" into the same shape upstream, so this must not re-introduce a distinction (no oracle).
 */
async function exchangeForReadToken(req: Request, res: Response, adapter: PlmDiscussionReadAdapter): Promise<string | null> {
  const rawToken = req.embedTokenRaw
  if (!rawToken) {
    // Should be unreachable (embedTokenAuth always sets it on success), but fail closed.
    res.status(401).json({ ok: false, error: { code: 'EMBED_SESSION_EXCHANGE_FAILED', message: 'discussion read session exchange failed' } })
    return null
  }
  const cred = await adapter.exchangeDiscussionReadSession(rawToken)
  const credential = cred.data[0]
  if (cred.error || !credential || !credential.access_token) {
    res.status(401).json({ ok: false, error: { code: 'EMBED_SESSION_EXCHANGE_FAILED', message: 'discussion read session exchange failed' } })
    return null
  }
  return credential.access_token
}

/** Reads a provider HTTP status off a QueryResult.error, mirroring the write relay's providerErrorStatus. */
function providerErrorStatus(error: unknown): number | null {
  const candidate = error as { response?: { status?: unknown } } | null
  const status = candidate?.response?.status
  return typeof status === 'number' ? status : null
}

const KNOWN_PROVIDER_STATUSES = new Set([400, 401, 403, 404, 409, 422])

/**
 * Maps a read method's QueryResult.error to a relay HTTP response. Mirrors the write relay's
 * `respondWriteError`: the provider's own status is authoritative for the small set of statuses
 * this relay understands (incl. the provider's uniform 404 for an unreadable/unbound target or
 * thread -- never re-derived or distinguished here); anything else (network failure, unexpected
 * status) degrades to a generic 502. The relay must never echo the raw upstream error body/message
 * (no oracle on internals).
 */
function respondReadError(res: Response, error: Error): void {
  const status = providerErrorStatus(error)
  if (status !== null && KNOWN_PROVIDER_STATUSES.has(status)) {
    res.status(status).json({ ok: false, error: { code: 'EMBED_DISCUSSION_READ_REJECTED', message: 'the discussion read was rejected' } })
    return
  }
  res.status(502).json({ ok: false, error: { code: 'EMBED_DISCUSSION_READ_UNAVAILABLE', message: 'the discussion read could not be completed' } })
}

export default function plmEmbedDiscussionReadRouter(): Router {
  const router = Router()

  // GET /api/plm-embed/discussion/threads -- list threads bound to the embed token's part.
  // The target is ALWAYS derived from the verified claims (targetType 'item', targetId
  // claims.part_id) -- any client-supplied target_type/target_id/include_children query param is
  // ignored entirely, never read.
  router.get('/api/plm-embed/discussion/threads', embedTokenAuth, async (req: Request, res: Response) => {
    const guarded = await runEmbedReadGuards(req, res)
    if (!guarded) return

    const readToken = await exchangeForReadToken(req, res, guarded.adapter)
    if (!readToken) return
    const result = await guarded.adapter.getDiscussionsWithReadToken(readToken, {
      targetType: 'item',
      targetId: guarded.claims.part_id,
    })
    if (result.error) return respondReadError(res, result.error)
    return res.json({ ok: true, data: result.data[0] ?? null })
  })

  // GET /api/plm-embed/discussion/threads/:threadId -- one thread with its comments. The
  // provider independently enforces the thread resolves back to the credential's bound part.
  router.get('/api/plm-embed/discussion/threads/:threadId', embedTokenAuth, async (req: Request, res: Response) => {
    const guarded = await runEmbedReadGuards(req, res)
    if (!guarded) return

    const threadId = req.params.threadId
    const readToken = await exchangeForReadToken(req, res, guarded.adapter)
    if (!readToken) return
    const result = await guarded.adapter.getDiscussionThreadWithReadToken(readToken, threadId)
    if (result.error) return respondReadError(res, result.error)
    return res.json({ ok: true, data: result.data[0] ?? null })
  })

  return router
}
