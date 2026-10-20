import type { Response } from 'express'
import type { VisualPreviewImage } from '../services/plm-visual-preview-transport'

/** Emit only the signed public descriptor and bounded raster produced by the Native protocol. */
export function sendVisualPreviewImage(res: Response, image: VisualPreviewImage): Response {
  if (image.render !== 'available') return res.json({ ok: true, data: { render: 'unavailable' } })
  // The Native transport constructs this descriptor only from a verified provider JWT.
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
}
