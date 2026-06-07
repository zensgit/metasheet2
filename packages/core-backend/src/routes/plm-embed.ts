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
 */
import { Router, type Request, type Response } from 'express'
import { getDataSourceManager } from './data-sources'
import { embedTokenAuth } from '../middleware/embed-token-auth'
import { embedAllowedOrigins, embedDataSourceId, frameAncestorsValue } from '../auth/embed-config'
import type { BomMultitableContextResult } from '../data-adapters/PLMAdapter'

const BOM_FEATURE_KEY = 'bom_multitable'

interface PlmBomAdapter {
  getBomMultitableContext(partId: string): Promise<BomMultitableContextResult>
  // the tenant actually served (x-tenant-id), used to cross-check the embed token's tenant_id
  getEffectiveTenantId(): string | undefined
  isConnected(): boolean
  connect(): Promise<void>
}
function isPlmBomAdapter(adapter: unknown): adapter is PlmBomAdapter {
  const a = adapter as Partial<PlmBomAdapter> | null
  return typeof a?.getBomMultitableContext === 'function'
    && typeof a?.getEffectiveTenantId === 'function'
    && typeof a?.isConnected === 'function'
    && typeof a?.connect === 'function'
}

export default function plmEmbedRouter(): Router {
  const router = Router()

  // Public config the embed iframe fetches to learn its parent-origin allowlist (single source:
  // PLM_EMBED_ALLOWED_ORIGINS) + the frame-ancestors value the deploy edge should apply. NOT
  // derived from the iframe URL, so an attacker can't widen the allowlist.
  router.get('/api/plm-embed/config', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      data: { allowed_origins: embedAllowedOrigins(), frame_ancestors: frameAncestorsValue() },
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
