import { isCurrentVisualSource } from './plm-embed-visual-source'
import { Router, type Request, type Response } from 'express'
import { getDataSourceManager } from './data-sources'
import { embedTokenAuth } from '../middleware/embed-token-auth'
import { embedAllowedOrigins, embedDataSourceId } from '../auth/embed-config'
import { consumeEmbedJti, embedJtiKey } from '../auth/embed-jti-store'
import type { QueryResult } from '../data-adapters/BaseAdapter'
import type { VisualPreviewFileList, VisualPreviewImage } from '../data-adapters/PLMAdapter'

interface PreviewAdapter {
  listVisualPreviewFiles(token: string): Promise<QueryResult<VisualPreviewFileList>>
  getVisualPreviewImage(token: string, fileId: string, versionId: string, origin: string): Promise<VisualPreviewImage>
  isVisualReviewEnabled(tenantId: string): boolean
  getEffectiveTenantId(): string | undefined
  isConnected(): boolean
  connect(): Promise<void>
}

function isPreviewAdapter(value: unknown): value is PreviewAdapter {
  const a = value as Partial<PreviewAdapter> | null
  return typeof a?.listVisualPreviewFiles === 'function'
    && typeof a?.getVisualPreviewImage === 'function'
    && typeof a?.isVisualReviewEnabled === 'function'
    && typeof a?.getEffectiveTenantId === 'function'
    && typeof a?.isConnected === 'function'
    && typeof a?.connect === 'function'
}

function unavailable(res: Response): null {
  res.status(503).json({ ok: false, error: { code: 'EMBED_UNAVAILABLE' } })
  return null
}

async function guardedAdapter(req: Request, res: Response): Promise<PreviewAdapter | null> {
  const claims = req.embedToken!
  if (claims.feature_key !== 'bom_multitable' || !claims.embed_origin
    || !embedAllowedOrigins().includes(claims.embed_origin)) {
    res.status(403).json({ ok: false, error: { code: 'EMBED_SCOPE_MISMATCH' } })
    return null
  }
  const sourceId = embedDataSourceId()
  if (!sourceId) return unavailable(res)
  let adapter: unknown
  try { adapter = getDataSourceManager().getDataSource(sourceId) } catch { return unavailable(res) }
  if (!isPreviewAdapter(adapter)) return unavailable(res)
  if (!adapter.isVisualReviewEnabled(claims.tenant_id) || !await isCurrentVisualSource(adapter, claims.tenant_id)) return unavailable(res)
  try { if (!adapter.isConnected()) await adapter.connect() } catch { return unavailable(res) }
  if (!await isCurrentVisualSource(adapter, claims.tenant_id)) return unavailable(res)
  const tenant = adapter.getEffectiveTenantId()
  if (!tenant || tenant !== claims.tenant_id) {
    res.status(403).json({ ok: false, error: { code: 'EMBED_TENANT_MISMATCH' } })
    return null
  }
  const now = Math.floor(Date.now() / 1000)
  const ttl = Math.min(typeof claims.exp === 'number' ? claims.exp - now : 0, 600)
  if (!claims.jti || ttl < 1) {
    res.status(401).json({ ok: false, error: { code: 'INVALID_EMBED_TOKEN' } })
    return null
  }
  try {
    const firstUse = await consumeEmbedJti(embedJtiKey({
      aud: claims.aud ?? '', feature_key: claims.feature_key,
      tenant_id: claims.tenant_id, part_id: claims.part_id, jti: claims.jti,
    }), ttl)
    if (!firstUse) {
      res.status(401).json({ ok: false, error: { code: 'EMBED_TOKEN_REPLAYED' } })
      return null
    }
  } catch { return unavailable(res) }
  return adapter
}

export default function plmEmbedVisualPreviewRouter(): Router {
  const router = Router()
  router.use('/api/plm-embed/visual-preview', (req, res, next) => {
    if (process.env.PLM_EMBED_VISUAL_PREVIEW_ENABLED !== 'true') {
      return res.status(404).json({ ok: false, error: { code: 'EMBED_UNAVAILABLE' } })
    }
    next()
  })

  router.post('/api/plm-embed/visual-preview/files', embedTokenAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const adapter = await guardedAdapter(req, res)
    if (!adapter) return
    const result = await adapter.listVisualPreviewFiles(req.embedTokenRaw!)
    if (!await isCurrentVisualSource(adapter, req.embedToken!.tenant_id)) return unavailable(res)
    const listing = result.data[0]
    if (result.error || !listing || !Array.isArray(listing.files) || listing.files.length > 50
      || !listing.files.every((file) => typeof file.file_id === 'string' && file.file_id
        && typeof file.version_id === 'string' && file.version_id && typeof file.filename === 'string')) {
      return unavailable(res)
    }
    return res.json({ ok: true, data: { files: listing.files.map((file) => ({ file_id: file.file_id, version_id: file.version_id,
      filename: file.filename, version_is_current: file.version_is_current === true })), has_more: listing.has_more === true } })
  })

  router.post('/api/plm-embed/visual-preview/image', embedTokenAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const fileId = req.body?.file_id
    const versionId = req.body?.version_id
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).length !== 2
      || typeof fileId !== 'string' || !fileId || fileId.length > 128 || fileId.trim() !== fileId
      || typeof versionId !== 'string' || !versionId || versionId.length > 128 || versionId.trim() !== versionId) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_PREVIEW_SELECTION' } })
    }
    const adapter = await guardedAdapter(req, res)
    if (!adapter) return
    const image = await adapter.getVisualPreviewImage(req.embedTokenRaw!, fileId, versionId, req.embedToken!.embed_origin)
    if (!await isCurrentVisualSource(adapter, req.embedToken!.tenant_id)) return unavailable(res)
    if (image.render !== 'available') return res.json({ ok: true, data: { render: 'unavailable' } })
    // The adapter constructs this descriptor only from a verified provider JWT.
    const descriptor = image.descriptor
    const header = Buffer.from(JSON.stringify({
      schema_version: descriptor.schema_version, part_id: descriptor.part_id,
      file_id: descriptor.file_id, file_version: descriptor.file_version,
      content_checksum: descriptor.content_checksum, preview_checksum: descriptor.preview_checksum,
      page: descriptor.page, preview_width: descriptor.preview_width, preview_height: descriptor.preview_height,
      version_is_current: descriptor.version_is_current,
    })).toString('base64url')
    res.setHeader('X-PLM-Preview-Descriptor', header)
    const exposed = String(res.getHeader('Access-Control-Expose-Headers') ?? '')
      .split(',').map((value) => value.trim()).filter(Boolean)
    if (!exposed.some((value) => value.toLowerCase() === 'x-plm-preview-descriptor')) exposed.push('X-PLM-Preview-Descriptor')
    res.setHeader('Access-Control-Expose-Headers', exposed.join(', '))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'")
    res.type(image.mediaType)
    return res.send(image.bytes)
  })
  return router
}
