// PLM-COLLAB P3-D2 (frontend): client for the token-bound BOM-review embed surface.
//
// Two endpoints, both under /api/plm-embed/ (NOT the /api/integration/* envelope helpers):
//   GET /config                  -- PUBLIC. The single source of the parent-origin allowlist.
//                                   The iframe MUST trust this over any URL parameter, and the
//                                   backend never emits '*' (it is stripped server-side).
//   GET /bom-review/context      -- requires the X-PLM-Embed-Token header. The part is bound to
//                                   the token's part_id claim on the server; there is NO part
//                                   input. The token travels ONLY in the header -- never the URL,
//                                   never a log line.
//
// Both responses use the bare {ok,data} envelope. Any non-200 / malformed response degrades to an
// "unavailable" result for the read-only viewer (the specific 401/403/503 codes are deliberately
// not surfaced to the embedded reader -- it is a viewer, not an auth console).
import { apiFetch, getApiBase } from '../../utils/api'
import { isPlmBomMultitableContext, type PlmBomMultitableContext } from './workbench'

export interface PlmEmbedConfig {
  // exact-match allowlist of parent origins permitted to deliver the embed token (never '*')
  allowedOrigins: string[]
  // the CSP frame-ancestors directive value the edge layer should set on the embed HTML document
  frameAncestors: string
  visualPreviewEnabled: boolean
}

export type PlmEmbedBomResult =
  | { available: true; entitled: boolean; context: PlmBomMultitableContext | null; partId?: string; reason?: string }
  | { available: false; reason?: string }

const FAIL_CLOSED_CONFIG: PlmEmbedConfig = { allowedOrigins: [], frameAncestors: "frame-ancestors 'none'", visualPreviewEnabled: false }

export async function getPlmEmbedConfig(): Promise<PlmEmbedConfig> {
  try {
    // This is a token-only, requiresAuth:false iframe. A 401/403 here must degrade to fail-closed,
    // NOT trigger apiFetch's default handleUnauthorized (which clears the session and redirects the
    // whole frame to /login).
    const response = await apiFetch('/api/plm-embed/config', { suppressUnauthorizedRedirect: true })
    const body = await response.json().catch(() => null)
    if (response.ok && body && body.ok === true && body.data && typeof body.data === 'object') {
      const data = body.data as Record<string, unknown>
      const allowedOrigins = Array.isArray(data.allowed_origins)
        ? data.allowed_origins.filter(
            (origin: unknown): origin is string =>
              typeof origin === 'string' && origin.length > 0 && origin !== '*',
          )
        : []
      const frameAncestors =
        typeof data.frame_ancestors === 'string' && data.frame_ancestors.trim()
          ? data.frame_ancestors
          : FAIL_CLOSED_CONFIG.frameAncestors
      return { allowedOrigins, frameAncestors, visualPreviewEnabled: data.visual_preview_enabled === true }
    }
  } catch {
    /* fall through to fail-closed */
  }
  return { ...FAIL_CLOSED_CONFIG }
}

export async function getPlmEmbedBomContext(token: string): Promise<PlmEmbedBomResult> {
  try {
    const response = await apiFetch('/api/plm-embed/bom-review/context', {
      headers: { 'X-PLM-Embed-Token': token },
      // a 401 (invalid/expired token) or 403 (feature/origin mismatch) must show unavailable/error
      // in the embed, never redirect the token-only iframe to the metasheet login page
      suppressUnauthorizedRedirect: true,
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || !body || body.ok !== true || !body.data || typeof body.data !== 'object') {
      return { available: false, reason: 'unavailable' }
    }
    return parsePlmEmbedBomData(body.data as Record<string, unknown>)
  } catch {
    return { available: false, reason: 'unavailable' }
  }
}

/**
 * Managed BOM refresh. Sends the single-use embed token and the purpose cookie only.
 * An ordinary stored bearer or tenant hint is not attached. A 401 stays in the embed.
 * 409 is not a successful read.
 */
export async function getPlmEmbedManagedBomContext(token: string): Promise<PlmEmbedBomResult> {
  if (typeof token !== 'string' || token.length === 0) return { available: false, reason: 'unavailable' }
  try {
    const page = typeof window !== 'undefined' ? window.location.origin : ''
    let apiOrigin = ''
    try {
      apiOrigin = new URL(getApiBase(), page || undefined).origin
    } catch {
      apiOrigin = ''
    }
    if (!page || page === 'null' || apiOrigin !== page) return { available: false, reason: 'unavailable' }
    const response = await fetch(new URL('/api/plm-embed/bom-review/context', page).toString(), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json', 'X-PLM-Embed-Token': token },
    })
    if (response.status === 409 || !response.ok) return { available: false, reason: 'unavailable' }
    const body = await response.json().catch(() => null)
    if (!body || body.ok !== true || !body.data || typeof body.data !== 'object') {
      return { available: false, reason: 'unavailable' }
    }
    return parsePlmEmbedBomData(body.data as Record<string, unknown>)
  } catch {
    return { available: false, reason: 'unavailable' }
  }
}

export function parsePlmEmbedBomData(data: Record<string, unknown>): PlmEmbedBomResult {
  const entitled = data.entitled === true
  // context is trusted only when entitled AND it validates as a part+lines object
  const context = entitled && isPlmBomMultitableContext(data.context) ? data.context : null
  // A reason on entitled+null-context denotes provider failure, not an empty BOM.
  // The legacy one-shot caller must re-mint rather than replaying its spent token.
  const reason = typeof data.reason === 'string' && data.reason.trim() ? data.reason.trim() : undefined
  const partId = entitled && typeof data.part_id === 'string' && data.part_id ? data.part_id : undefined
  return { available: true, entitled, context, ...(partId ? { partId } : {}), ...(reason ? { reason } : {}) }
}
