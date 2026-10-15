import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/api', () => ({ apiFetch }))
import { listVisualPreviewFiles, loadVisualPreview } from '../src/services/integration/plmEmbedVisualPreview'

const file = { file_id: 'F1', version_id: 'V1', filename: 'real.png', version_is_current: true }
const descriptor = { schema_version: 1, part_id: 'P1', file_id: 'F1', file_version: 'V1',
  content_checksum: 'a'.repeat(64), preview_checksum: 'b'.repeat(64), page: 0,
  preview_width: 100, preview_height: 80, version_is_current: true }
function raster(type: string, bytes: Uint8Array, binding: unknown = descriptor) {
  return {
    ok: true,
    headers: { get: (name: string) => name === 'content-type' ? type : binding === null ? null : Buffer.from(JSON.stringify(binding)).toString('base64url') },
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } }),
  }
}

describe('visual preview response validation', () => {
  beforeEach(() => apiFetch.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it.each([401, 403, 404])('reports access refusal %s before reading provider data', async (status) => {
    const json = vi.fn()
    apiFetch.mockResolvedValue({ ok: false, status, json })
    await expect(listVisualPreviewFiles('fresh')).rejects.toMatchObject({ reason: 'denied' })
    await expect(loadVisualPreview('fresh', file, 'P1')).rejects.toMatchObject({ reason: 'denied' })
    expect(json).not.toHaveBeenCalled()
  })

  it('reports offline only when the browser itself declares it offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(listVisualPreviewFiles('fresh')).rejects.toMatchObject({ reason: 'offline' })
    await expect(loadVisualPreview('fresh', file, 'P1')).rejects.toMatchObject({ reason: 'offline' })
  })

  it('uses the token header and only accepts real file/version list pairs', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: { files: [file], has_more: false } }) })
    expect(await listVisualPreviewFiles('fresh')).toEqual({ files: [file], hasMore: false })
    expect(apiFetch.mock.calls[0][1].headers['X-PLM-Embed-Token']).toBe('fresh')
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: { files: [{ file_id: 'F1' }] } }) })
    expect(await listVisualPreviewFiles('other')).toBeNull()
  })

  it.each([null, { ...descriptor, part_id: 'other' }, { ...descriptor, file_id: 'other' },
    { ...descriptor, file_version: 'other' }, { ...descriptor, extra: true }])('refuses unbound or mismatched raster %j', async (binding) => {
    apiFetch.mockResolvedValue(raster('image/png', Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), binding))
    expect((await loadVisualPreview('fresh', file, 'P1')).render).toBe('unavailable')
  })

  it('projects missing version currentness to historical read-only', async () => {
    const { version_is_current: _flag, ...oldFile } = file
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: { files: [oldFile] } }) })
    expect(await listVisualPreviewFiles('fresh')).toEqual({ files: [{ ...oldFile, version_is_current: false }], hasMore: false })
  })

  it('accepts bounded PNG bytes and rejects wrong MIME, magic, and oversize data', async () => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    apiFetch.mockResolvedValue(raster('image/png', png))
    const accepted = await loadVisualPreview('fresh', file, 'P1')
    expect(accepted).toMatchObject({ render: 'available', descriptor })
    expect(apiFetch.mock.calls[0][1].body).toBe(JSON.stringify({ file_id: 'F1', version_id: 'V1' }))

    apiFetch.mockResolvedValue(raster('text/html', png))
    expect((await loadVisualPreview('fresh', file, 'P1')).render).toBe('unavailable')
    apiFetch.mockResolvedValue(raster('image/png', Uint8Array.from([1, 2, 3])))
    expect((await loadVisualPreview('fresh', file, 'P1')).render).toBe('unavailable')
    apiFetch.mockResolvedValue(raster('image/png', new Uint8Array(8 * 1024 * 1024 + 1)))
    expect((await loadVisualPreview('fresh', file, 'P1')).render).toBe('unavailable')
  })
})
