/** Managed identity/source admission plus the existing Native Discussion session engine.
 * The browser's read session identifies its link; only a fresh signed embed token
 * and Native purpose-specific exchange authorize the actual Discussion operation.
 */
import type { Request } from 'express'
import { z } from 'zod'
import { transaction } from '../db/pg'
import { verifyEmbedToken } from '../auth/embed-token-verify'
import { embedAudience, embedPublicKeysByKid } from '../auth/embed-config'
import { projectVisualMarkups } from '../auth/visual-review-markup'
import { consumeEmbedJti, embedJtiKey } from '../auth/embed-jti-store'
import { currentManagedRequest } from './plm-managed-request-context'
import { lockManagedBomAuthority } from './plm-managed-bom-authority'
import { assertManagedOrigin } from './plm-managed-companion-flow'
import { ManagedCompanionRefusal as Refusal } from './plm-managed-companion'
import { resolvePersistedPlmSource } from './plm-personal-bom-write-wire'

const text = z.string().min(1)
const mentions = z.array(z.number().int()).optional()
const comment = z.object({ body: text, parent_comment_id: text.optional(), mentioned_user_ids: mentions }).strict()
const transition = z.object({ comment: z.string().optional(), mentioned_user_ids: mentions }).strict()
export const managedDiscussionInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('context'), parentOrigin: text }).strict(),
  z.object({ operation: z.literal('list') }).strict(),
  z.object({ operation: z.literal('thread'), threadId: text }).strict(),
  z.object({ operation: z.literal('create'), body: z.object({
    target_type: z.enum(['item', 'item_version', 'file', 'eco', 'pdm_relationship']),
    target_id: text, body: text, title: z.string().optional(), mentioned_user_ids: mentions,
  }).strict() }).strict(),
  z.object({ operation: z.literal('comment'), threadId: text, body: comment }).strict(),
  z.object({ operation: z.literal('edit'), threadId: text, commentId: text,
    body: z.object({ body: text }).strict() }).strict(),
  z.object({ operation: z.literal('delete'), threadId: text, commentId: text }).strict(),
  z.object({ operation: z.literal('resolve'), threadId: text, body: transition }).strict(),
  z.object({ operation: z.literal('reopen'), threadId: text, body: transition }).strict(),
])
const credentialSchema = z.object({ access_token: text, token_type: z.literal('bearer'),
  expires_in: z.number().finite().positive(), aud: z.literal('discussion') })
const nativeStatuses = new Set([400, 401, 403, 404, 409, 422])

export async function relayManagedDiscussion(req: Request, sourceId?: string): Promise<unknown> {
  const parsed = managedDiscussionInput.safeParse(req.body)
  if (!parsed.success) throw new Refusal(422, 'PLM_MANAGED_DISCUSSION_BODY_REFUSED')
  const input = parsed.data
  if (sourceId === undefined && input.operation !== 'context') throw new Refusal(422, 'PLM_MANAGED_DISCUSSION_BODY_REFUSED')
  const raw = req.headers['x-plm-embed-token']
  if (typeof raw !== 'string' || !raw) throw new Refusal(401, 'PLM_MANAGED_DISCUSSION_TOKEN_REQUIRED')
  const publicKeysByKid = embedPublicKeysByKid()
  if (!Object.keys(publicKeysByKid).length) throw new Refusal(503, 'PLM_MANAGED_DISCUSSION_UNAVAILABLE')
  let claims: ReturnType<typeof verifyEmbedToken>
  try { claims = verifyEmbedToken(raw, { publicKeysByKid, audience: embedAudience() }) }
  catch { throw new Refusal(401, 'PLM_MANAGED_DISCUSSION_TOKEN_REFUSED') }
  if (claims.feature_key !== 'bom_multitable' || !claims.jti || typeof claims.exp !== 'number') {
    throw new Refusal(403, 'PLM_MANAGED_DISCUSSION_SCOPE_REFUSED')
  }
  return transaction(async client => {
    let resolvedSourceId = sourceId
    if (resolvedSourceId === undefined) {
      const store = currentManagedRequest()
      if (!store?.sessionId || store.conflict || store.userId !== req.user?.id) {
        throw new Refusal(403, 'PLM_MANAGED_DISCUSSION_CONTEXT_REFUSED')
      }
      const session = (await client.query('SELECT data_source_id FROM plm_managed_sessions WHERE id=$1 AND meta_user_id=$2',
        [store.sessionId, store.userId])).rows[0]
      if (typeof session?.data_source_id !== 'string' || !session.data_source_id) {
        throw new Refusal(403, 'PLM_MANAGED_DISCUSSION_CONTEXT_REFUSED')
      }
      resolvedSourceId = session.data_source_id
    }
    const current = await lockManagedBomAuthority(client.query.bind(client), req, resolvedSourceId, claims.part_id)
    assertManagedOrigin(req, current.reg.origin)
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json'
      || claims.sub !== current.source.auth_user_id || claims.tenant_id !== current.source.tenant_id
      || claims.org_id !== current.source.org_id || claims.embed_origin !== current.reg.origin) {
      throw new Refusal(403, 'PLM_MANAGED_DISCUSSION_SCOPE_REFUSED')
    }
    let source: ReturnType<typeof resolvePersistedPlmSource>
    try { source = resolvePersistedPlmSource({ ...(current.row.config as object), type: 'plm' }) }
    catch { throw new Refusal(403, 'PLM_MANAGED_DISCUSSION_SOURCE_CHANGED') }
    if (source.origin.href !== new URL(current.reg.nativeBaseUrl).href
      || source.origin.origin !== current.row.frozen_origin
      || source.tenantId !== current.source.tenant_id || source.orgId !== current.source.org_id) {
      throw new Refusal(403, 'PLM_MANAGED_DISCUSSION_SOURCE_CHANGED')
    }
    if (input.operation === 'context' && input.parentOrigin !== source.origin.origin) {
      throw new Refusal(403, 'PLM_MANAGED_DISCUSSION_CONTEXT_REFUSED')
    }
    const ttl = Math.min(claims.exp! - Math.floor(Date.now() / 1000), 600)
    if (ttl < 1) throw new Refusal(401, 'PLM_MANAGED_DISCUSSION_TOKEN_REFUSED')
    let first: boolean
    try { first = await consumeEmbedJti(embedJtiKey({ aud: claims.aud ?? '', feature_key: claims.feature_key ?? '',
      tenant_id: claims.tenant_id ?? '', part_id: claims.part_id, jti: claims.jti as string }), ttl) }
    catch { throw new Refusal(503, 'PLM_MANAGED_DISCUSSION_UNAVAILABLE') }
    if (!first) throw new Refusal(401, 'PLM_MANAGED_DISCUSSION_TOKEN_REPLAYED')
    if (input.operation === 'context') return { sourceId: resolvedSourceId, partId: claims.part_id, parentOrigin: source.origin.origin }

    async function call(path: string, method: string, body?: unknown, bearer?: string): Promise<unknown> {
      let response: Response
      try {
        response = await fetch(source.origin.href.replace(/\/$/, '') + path, {
          method, redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      } catch { throw new Refusal(502, 'PLM_MANAGED_DISCUSSION_UNAVAILABLE') }
      if (!response.ok) throw new Refusal(nativeStatuses.has(response.status) ? response.status : 502,
        'PLM_MANAGED_DISCUSSION_REJECTED')
      try {
        const data = await response.json()
        // This plain Discussion surface has not admitted the separate Visual source/purpose gates.
        return path.startsWith('/api/v1/discussions') ? projectVisualMarkups(data, false, claims.part_id) : data
      }
      catch { throw new Refusal(502, 'PLM_MANAGED_DISCUSSION_UNAVAILABLE') }
    }
    const read = input.operation === 'list' || input.operation === 'thread'
    const exchange = await call('/api/v1/auth/embed/' + (read ? 'discussion-read-session' : 'discussion-session'),
      'POST', { embed_token: raw })
    const credential = credentialSchema.safeParse(exchange)
    if (!credential.success) throw new Refusal(502, 'PLM_MANAGED_DISCUSSION_UNAVAILABLE')
    const token = credential.data.access_token
    const base = '/api/v1/discussions'
    switch (input.operation) {
      case 'list': return call(base + '?' + new URLSearchParams({ target_type: 'item', target_id: claims.part_id,
        include_resolved: 'true' }), 'GET', undefined, token)
      case 'thread': return call(base + '/' + encodeURIComponent(input.threadId), 'GET', undefined, token)
      case 'create': return call(base, 'POST', input.body, token)
      case 'comment': return call(base + '/' + encodeURIComponent(input.threadId) + '/comments', 'POST', input.body, token)
      case 'edit': return call(base + '/' + encodeURIComponent(input.threadId) + '/comments/' + encodeURIComponent(input.commentId), 'PATCH', input.body, token)
      case 'delete': return call(base + '/' + encodeURIComponent(input.threadId) + '/comments/' + encodeURIComponent(input.commentId), 'DELETE', undefined, token)
      case 'resolve': case 'reopen': return call(base + '/' + encodeURIComponent(input.threadId) + '/' + input.operation, 'POST', input.body, token)
    }
  })
}
