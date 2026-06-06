import { beforeEach, describe, expect, it, vi } from 'vitest'

// Exercise the REAL plmEmbed service (the embed component spec mocks this module away, so without
// this file the security-relevant parsing -- '*' stripping, fail-closed config, the {ok,data}
// envelope, and the transient-reason-vs-empty distinction -- would run in zero tests).
const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: (...args: unknown[]) => apiFetchMock(...args),
}))

import { getPlmEmbedConfig, getPlmEmbedBomContext } from '../src/services/integration/plmEmbed'

function rawJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

// identical shape to the P3-C service spec's fixture -- known to pass isPlmBomMultitableContext
const CONTEXT = {
  part: { part_id: 'P1', item_number: 'P-001', name: 'Assembly', state: 'Released', generation: 3 },
  lines: [
    { bom_line_id: 'R1', part_id: 'C1', item_number: 'C-001', name: 'Bracket', state: 'Draft', generation: 1, quantity: 2, uom: 'EA', find_num: '10', refdes: 'R1,R2', level: 1, path: ['P1'], path_labels: ['P-001'], source_version: 1, source_updated_at: '2026-06-05T00:00:00', sync_status: 'snapshot' },
  ],
  source_version: 3,
  source_updated_at: '2026-06-05T00:00:00',
  sync_status: 'snapshot',
  template_key: 'bom_review',
}

describe('getPlmEmbedConfig (P3-D2 — single-source allowlist, fail-closed)', () => {
  beforeEach(() => apiFetchMock.mockReset())

  it('reads the allowlist + frame-ancestors from the {ok,data} envelope', async () => {
    apiFetchMock.mockResolvedValue(
      rawJsonResponse({ ok: true, data: { allowed_origins: ['https://plm.example.com'], frame_ancestors: 'frame-ancestors https://plm.example.com' } }),
    )
    const c = await getPlmEmbedConfig()
    // token-only iframe: must opt out of apiFetch's 401/403 -> handleUnauthorized login redirect
    expect(apiFetchMock).toHaveBeenCalledWith('/api/plm-embed/config', { suppressUnauthorizedRedirect: true })
    expect(c).toEqual({ allowedOrigins: ['https://plm.example.com'], frameAncestors: 'frame-ancestors https://plm.example.com' })
  })

  it("strips '*', empty, and non-string entries from allowed_origins", async () => {
    apiFetchMock.mockResolvedValue(
      rawJsonResponse({ ok: true, data: { allowed_origins: ['*', '', 'https://plm.example.com', 42], frame_ancestors: 'frame-ancestors *' } }),
    )
    const c = await getPlmEmbedConfig()
    expect(c.allowedOrigins).toEqual(['https://plm.example.com'])
  })

  it('fails closed (empty allowlist + frame-ancestors none) on a non-ok response', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ ok: false }, 500))
    const c = await getPlmEmbedConfig()
    expect(c).toEqual({ allowedOrigins: [], frameAncestors: "frame-ancestors 'none'" })
  })

  it('fails closed on a malformed (no data) response', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ ok: true }))
    const c = await getPlmEmbedConfig()
    expect(c).toEqual({ allowedOrigins: [], frameAncestors: "frame-ancestors 'none'" })
  })

  it('fails closed when apiFetch throws', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('network'))
    const c = await getPlmEmbedConfig()
    expect(c).toEqual({ allowedOrigins: [], frameAncestors: "frame-ancestors 'none'" })
  })
})

describe('getPlmEmbedBomContext (P3-D2 — header-only token + envelope + transient-vs-empty)', () => {
  beforeEach(() => apiFetchMock.mockReset())

  it('sends the token ONLY in the X-PLM-Embed-Token header (never the URL) and suppresses the login redirect', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ ok: true, data: { available: true, entitled: true, context: CONTEXT, part_id: 'P1' } }))
    await getPlmEmbedBomContext('tok-xyz')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/plm-embed/bom-review/context', {
      headers: { 'X-PLM-Embed-Token': 'tok-xyz' },
      // 401/403 must degrade in-place, not redirect the token-only iframe to /login
      suppressUnauthorizedRedirect: true,
    })
    expect(apiFetchMock.mock.calls[0][0]).not.toContain('tok-xyz')
  })

  it('entitled + valid context -> available/entitled/context', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ ok: true, data: { available: true, entitled: true, context: CONTEXT, part_id: 'P1' } }))
    const r = await getPlmEmbedBomContext('t')
    expect(r).toEqual({ available: true, entitled: true, context: CONTEXT })
  })

  it('entitled:false -> upgrade shape (null context)', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ ok: true, data: { available: true, entitled: false, context: null, part_id: 'P1' } }))
    const r = await getPlmEmbedBomContext('t')
    expect(r).toEqual({ available: true, entitled: false, context: null })
  })

  it('entitled + null context + reason -> keeps reason (transient, not empty)', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ ok: true, data: { available: true, entitled: true, context: null, reason: 'unavailable', part_id: 'P1' } }))
    const r = await getPlmEmbedBomContext('t')
    expect(r).toEqual({ available: true, entitled: true, context: null, reason: 'unavailable' })
  })

  it('entitled + null context + NO reason -> no reason (empty/not-found)', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ ok: true, data: { available: true, entitled: true, context: null, part_id: 'P1' } }))
    const r = await getPlmEmbedBomContext('t')
    expect(r).toEqual({ available: true, entitled: true, context: null })
    expect('reason' in r).toBe(false)
  })

  it('drops an entitled context that fails validation -> null context', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ ok: true, data: { available: true, entitled: true, context: { not: 'a-context' }, part_id: 'P1' } }))
    const r = await getPlmEmbedBomContext('t')
    expect(r).toEqual({ available: true, entitled: true, context: null })
  })

  it('does not trust a context when entitled is false even if one is present', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ ok: true, data: { available: true, entitled: false, context: CONTEXT, part_id: 'P1' } }))
    const r = await getPlmEmbedBomContext('t')
    expect(r).toEqual({ available: true, entitled: false, context: null })
  })

  it('non-200 (e.g. 401 invalid token) -> unavailable', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ ok: false, error: { code: 'INVALID_EMBED_TOKEN' } }, 401))
    const r = await getPlmEmbedBomContext('t')
    expect(r).toEqual({ available: false, reason: 'unavailable' })
  })

  it('malformed envelope -> unavailable', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ ok: true }))
    const r = await getPlmEmbedBomContext('t')
    expect(r).toEqual({ available: false, reason: 'unavailable' })
  })

  it('apiFetch throws -> unavailable', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('network'))
    const r = await getPlmEmbedBomContext('t')
    expect(r).toEqual({ available: false, reason: 'unavailable' })
  })
})
