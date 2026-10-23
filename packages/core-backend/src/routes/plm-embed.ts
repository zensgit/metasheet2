/**
 * PLM-COLLAB-P3-D2: the DEDICATED embed relay (NOT the P3-C `/api/plm-workbench/...` route,
 * which is session-JWT gated). These paths are whitelisted from the global session gate and
 * authenticated solely by `embedTokenAuth` (the EdDSA embed token).
 *
 * Hard rules (owner-ratified):
 * - The data source is SERVER-configured (`PLM_EMBED_DATA_SOURCE_ID`), NEVER taken from the
 *   request — `DataSourceManager.getDataSource()` does no owner check and the embed token has
 *   no metasheet user identity, so an iframe must not be able to point at an arbitrary source.
 * - The part is the token-bound `part_id` claim, NEVER a request input.
 * - `embed_origin` must be in the allowlist (defence in depth on top of the edge CSP).
 * - Read-only; never 500s -> degrades.
 *
 * CSP frame-ancestors is computed here (fail-closed 'none' when unconfigured) and exposed via
 * `/config`; the actual `Content-Security-Policy` header on the embed HTML document is applied
 * at the deploy edge (Express does not serve the SPA HTML). The code-enforced controls are the
 * token verification + the embed_origin allowlist + the frontend postMessage origin pin.
 *
 * A proven unbound source keeps that token-only shared read when the request has no
 * Authorization header and no managed session cookie. A bound source stays on the
 * managed branch for the rest of the request: the dedicated cookie is verified by
 * jwtAuthMiddleware, and the personal relay publishes the snapshot. Embed claims are
 * compared with the persisted native subject, tenant, org, and root part.
 * embed_origin is the iframe/Meta origin and must match the persisted OAuth
 * client_origin. The frozen Native installation origin stays on the relay
 * fingerprint, in its own namespace. Embed claims are not a Meta user,
 * tenant, or org.
 */
import { Router, type Request, type Response } from 'express'
import { getDataSourceManager } from './data-sources'
import { embedTokenAuth } from '../middleware/embed-token-auth'
import { jwtAuthMiddleware } from '../auth/jwt-middleware'
import type { EmbedTokenClaims } from '../auth/embed-token-verify'
import {
  classifyManagedSource,
  isPlmManagedCompanionEnabled,
  MANAGED_SESSION_COOKIE,
  readRequestCookie,
  type ManagedBindingRow,
} from '../services/plm-managed-companion'
import { relayManagedBomContext } from '../services/plm-managed-companion-flow'
import { embedAllowedOrigins, embedDataSourceId, frameAncestorsValue, isPlmEmbedVisualPreviewEnabled } from '../auth/embed-config'
import { consumeEmbedJti, embedJtiKey } from '../auth/embed-jti-store'
import type { BomMultitableContextResult } from '../data-adapters/PLMAdapter'

const BOM_FEATURE_KEY = 'bom_multitable'

interface PlmBomAdapter {
  getBomMultitableContext(partId: string): Promise<BomMultitableContextResult>
  // the tenant/org actually served (x-tenant-id/x-org-id), cross-checked against the embed token
  getEffectiveTenantId(): string | undefined
  getEffectiveOrgId(): string | undefined
  isConnected(): boolean
  connect(): Promise<void>
}
function isPlmBomAdapter(adapter: unknown): adapter is PlmBomAdapter {
  const a = adapter as Partial<PlmBomAdapter> | null
  return typeof a?.getBomMultitableContext === 'function'
    && typeof a?.getEffectiveTenantId === 'function'
    && typeof a?.getEffectiveOrgId === 'function'
    && typeof a?.isConnected === 'function'
    && typeof a?.connect === 'function'
}

function refuse(res: Response, status: number, code: string, message: string): Response {
  return res.status(status).json({ ok: false, error: { code, message } })
}

function presentedAuthorization(req: Request): boolean {
  const header = req.headers.authorization
  const value = Array.isArray(header) ? header.join(',') : header
  return typeof value === 'string' && value.trim().length > 0
}

function presentedManagedCookie(req: Request): boolean {
  return Boolean(readRequestCookie(req.headers.cookie, MANAGED_SESSION_COOKIE))
}

function nativeEmbedMatches(claims: EmbedTokenClaims, row: ManagedBindingRow): boolean {
  const subject = typeof claims.sub === 'string' ? claims.sub : ''
  const tenant = typeof claims.tenant_id === 'string' ? claims.tenant_id : ''
  const org = typeof claims.org_id === 'string' ? claims.org_id : ''
  const part = claims.part_id
  const origin = typeof claims.embed_origin === 'string' ? claims.embed_origin : ''
  return subject.length > 0
    && origin.length > 0
    && subject === row.native_auth_user_id
    && tenant === row.native_tenant_id
    && org === row.native_org_id
    && part === row.root_part_id
    && part === row.frozen_root_part_id
    && origin === row.client_origin
}

async function consumeEmbedToken(res: Response, claims: EmbedTokenClaims): Promise<boolean> {
  const jti = typeof claims.jti === 'string' ? claims.jti : ''
  if (!jti) {
    refuse(res, 401, 'INVALID_EMBED_TOKEN', 'missing jti')
    return false
  }
  const now = Math.floor(Date.now() / 1000)
  const ttl = Math.min(typeof claims.exp === 'number' ? claims.exp - now : 0, 600)
  if (ttl < 1) {
    refuse(res, 401, 'INVALID_EMBED_TOKEN', 'token expired')
    return false
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
    refuse(res, 503, 'EMBED_UNAVAILABLE', 'embed replay store unavailable')
    return false
  }
  if (!firstUse) {
    refuse(res, 401, 'EMBED_TOKEN_REPLAYED', 'embed token already used')
    return false
  }
  return true
}

async function serveManagedEmbed(req: Request, res: Response, dataSourceId: string, row: ManagedBindingRow): Promise<void> {
  try {
    if (res.headersSent) return
    const claims = req.embedToken
    if (!claims || !nativeEmbedMatches(claims, row)) {
      refuse(res, 403, 'PLM_MANAGED_IDENTITY_REFUSED', 'Embed native identity does not match the managed binding')
      return
    }
    const userId = typeof req.user?.id === 'string' ? req.user.id : ''
    if (!userId) {
      refuse(res, 403, 'PLM_MANAGED_SESSION_REQUIRED', 'Managed embed requires the current managed cookie')
      return
    }
    if (!(await consumeEmbedToken(res, claims))) return
    const result = await relayManagedBomContext({ userId, dataSourceId, partId: claims.part_id })
    if (res.headersSent) return
    if (result.kind === 'legacy') {
      refuse(res, 403, 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED', 'Managed source cannot use the shared embed transport')
      return
    }
    if (result.kind === 'refusal') {
      refuse(res, result.status, result.code, 'Managed embed read refused')
      return
    }
    const partId = claims.part_id
    res.json({
      ok: true,
      data: {
        available: true,
        entitled: result.entitled,
        context: result.entitled ? result.context : null,
        part_id: partId,
      },
    })
  } catch {
    if (!res.headersSent) {
      refuse(res, 403, 'PLM_MANAGED_READ_REFUSED', 'Managed embed read refused')
    }
  }
}

export default function plmEmbedRouter(): Router {
  const router = Router()

  // Public config the embed iframe fetches to learn its parent-origin allowlist (single source:
  // PLM_EMBED_ALLOWED_ORIGINS) + the frame-ancestors value the deploy edge should apply. NOT
  // derived from the iframe URL, so an attacker can't widen the allowlist.
  router.get('/api/plm-embed/config', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      data: { allowed_origins: embedAllowedOrigins(), frame_ancestors: frameAncestorsValue(),
        visual_preview_enabled: isPlmEmbedVisualPreviewEnabled() },
    })
  })

  // The gated embed data route. Bound to the configured source + the token's part.
  router.get(
    '/api/plm-embed/bom-review/context',
    embedTokenAuth,
    async (req: Request, res: Response) => {
      const claims = req.embedToken!
      // the embed token must be scoped to THIS feature: a same-audience/typ embed token minted
      // for another PLM feature must NOT be accepted by the BOM review relay.
      if (claims.feature_key !== BOM_FEATURE_KEY) {
        return res.status(403).json({ ok: false, error: { code: 'EMBED_FEATURE_MISMATCH', message: 'token not scoped to bom_multitable' } })
      }
      const origin = typeof claims.embed_origin === 'string' ? claims.embed_origin : ''
      if (!origin || !embedAllowedOrigins().includes(origin)) {
        return res.status(403).json({ ok: false, error: { code: 'EMBED_ORIGIN_NOT_ALLOWED', message: 'embed origin not allowed' } })
      }

      const dataSourceId = embedDataSourceId()
      if (!dataSourceId) {
        return res.status(503).json({ ok: false, error: { code: 'EMBED_UNAVAILABLE', message: 'embed data source not configured' } })
      }
      // Classify once and keep that result for the rest of this request. A later
      // unbound classification inside the personal relay is a refusal, not a
      // switch onto the shared adapter.
      const managedClass = await classifyManagedSource(dataSourceId)
      if (managedClass.kind === 'schema-missing' || managedClass.kind === 'unavailable') {
        const code = managedClass.kind === 'schema-missing'
          ? 'PLM_MANAGED_SCHEMA_MISSING'
          : 'PLM_MANAGED_BINDING_UNAVAILABLE'
        return refuse(res, 403, code, 'Managed source cannot use the shared embed transport')
      }
      if (managedClass.kind === 'bound') {
        if (presentedAuthorization(req)) {
          return refuse(res, 403, 'PLM_MANAGED_BEARER_REFUSED', 'Managed embed refuses ordinary or mixed credentials')
        }
        if (!presentedManagedCookie(req)) {
          return refuse(res, 403, 'PLM_MANAGED_SESSION_REQUIRED', 'Managed embed requires the current managed cookie')
        }
        // Exact flag before middleware. verifyManagedCompanionToken collapses every
        // other flag value to a missing session, which this route must not do.
        if (!isPlmManagedCompanionEnabled()) {
          return refuse(res, 403, 'PLM_MANAGED_DISABLED', 'Managed companion is not enabled')
        }
        const row = managedClass.row
        return jwtAuthMiddleware(req, res, () => {
          void serveManagedEmbed(req, res, dataSourceId, row)
        })
      }
      if (presentedAuthorization(req)) {
        return refuse(res, 403, 'PLM_MANAGED_BEARER_REFUSED', 'Managed embed refuses ordinary or mixed credentials')
      }
      if (presentedManagedCookie(req)) {
        return refuse(res, 403, 'PLM_MANAGED_READ_REFUSED', 'Embed credential conflict')
      }

      let adapter: unknown
      try {
        adapter = getDataSourceManager().getDataSource(dataSourceId)
      } catch {
        return res.status(503).json({ ok: false, error: { code: 'EMBED_UNAVAILABLE', message: 'embed data source unavailable' } })
      }
      if (!isPlmBomAdapter(adapter)) {
        return res.status(503).json({ ok: false, error: { code: 'EMBED_UNAVAILABLE', message: 'embed data source unsupported' } })
      }

      // Ensure the adapter is connected so its effective tenant (resolved in connect()) is readable.
      try {
        if (!adapter.isConnected()) await adapter.connect()
      } catch {
        return res.status(503).json({ ok: false, error: { code: 'EMBED_UNAVAILABLE', message: 'embed data source unavailable' } })
      }
      // Cross-check the token's tenant against the tenant whose data is ACTUALLY served (the
      // x-tenant-id the adapter sends), BEFORE querying BOM context. Fail-closed: a missing or
      // mismatched served tenant -> 403, and the resource is NEVER queried (no cross-tenant fetch).
      // Comparing against the served tenant -- not a lower-precedence config fallback that the
      // resolution chain can override -- is what makes this sound (avoids false closure).
      const servedTenantId = adapter.getEffectiveTenantId()
      if (!servedTenantId || claims.tenant_id !== servedTenantId) {
        return res.status(403).json({ ok: false, error: { code: 'EMBED_TENANT_MISMATCH', message: 'token tenant does not match the embed data source tenant' } })
      }
      // The context is read with the source's own credentials, so a matching tenant is not enough:
      // a token minted in another org of the same tenant must never read the served org's BOM.
      const servedOrgId = adapter.getEffectiveOrgId()
      if (!servedOrgId || claims.org_id !== servedOrgId) {
        return res.status(403).json({ ok: false, error: { code: 'EMBED_ORG_MISMATCH', message: 'token org does not match the embed data source org' } })
      }

      // Single-use: atomically consume the token's jti against the SHARED store BEFORE querying, so a
      // replay of a still-valid token cannot fetch data a second time. A jti is required (an absent
      // jti cannot be tracked). The store being unavailable fails CLOSED (503) -- never fail open, and
      // never a per-instance fallback. Cost (accepted): one data call per token; after the transient
      // provider-failure degrade below, the parent must RE-MINT + re-post (a retry is NOT a re-call).
      if (!(await consumeEmbedToken(res, claims))) return

      const partId = claims.part_id // token-bound; never a request input
      let result: BomMultitableContextResult
      try {
        result = await adapter.getBomMultitableContext(partId)
      } catch {
        // never 500 -> degrade (transient provider failure)
        return res.json({ ok: true, data: { available: true, entitled: true, context: null, reason: 'unavailable', part_id: partId } })
      }
      const entitled = result.entitled === true
      return res.json({ ok: true, data: { available: true, entitled, context: entitled ? result.context : null, part_id: partId } })
    },
  )

  return router
}
