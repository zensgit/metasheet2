import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import Panel from '../src/components/plm/PlmEmbedVisualPreviewPanel.vue'
import { listVisualPreviewFiles, loadVisualPreview, VisualPreviewAccessError } from '../src/services/integration/plmEmbedVisualPreview'
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), base: '' }))
vi.mock('../src/utils/api', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args), getApiBase: () => mocks.base }))
const origin = 'https://native.example.test'
const file = { file_id: 'file', version_id: 'version', filename: 'owned.png', version_is_current: true }
const descriptor = { schema_version: 1, part_id: 'part', file_id: 'file', file_version: 'version',
  content_checksum: 'a'.repeat(64), preview_checksum: 'b'.repeat(64), page: 0,
  preview_width: 1, preview_height: 1, version_is_current: true }
let app: App | undefined, host: HTMLElement
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
beforeEach(() => {
  mocks.fetch.mockReset(); mocks.base = ''
  mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, data: { files: [file], has_more: false } }) })
  host = document.createElement('div'); document.body.appendChild(host)
})
afterEach(() => { app?.unmount(); app = undefined; host.remove(); vi.restoreAllMocks() })
it('sends explicit managed operations only to same-origin cookie endpoints', async () => {
  expect(await listVisualPreviewFiles('fresh', undefined, 'source/with space')).toEqual({ files: [file], hasMore: false })
  expect(mocks.fetch.mock.calls[0]).toEqual(['/api/plm/managed-login/sources/source%2Fwith%20space/discussion', expect.objectContaining({
    credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-PLM-Embed-Token': 'fresh' }, body: JSON.stringify({ operation: 'preview-files' }),
  })])
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  mocks.fetch.mockResolvedValue(new Response(bytes, { headers: { 'Content-Type': 'image/png',
    'X-PLM-Preview-Descriptor': btoa(JSON.stringify(descriptor)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') } }))
  expect(await loadVisualPreview('new-image-token', file, 'part', undefined, 'owned')).toMatchObject({ render: 'available', descriptor })
  expect(mocks.fetch.mock.calls[1][1]).toMatchObject({ credentials: 'include', body: JSON.stringify({ operation: 'preview-image', fileId: 'file', versionId: 'version' }) })
})
it.each(['', ' source', 'source '])('refuses invalid managed source %s without a legacy fallback', async source => {
  await expect(listVisualPreviewFiles('secret', undefined, source)).rejects.toBeInstanceOf(VisualPreviewAccessError)
  await expect(loadVisualPreview('secret', file, 'part', undefined, source)).rejects.toBeInstanceOf(VisualPreviewAccessError)
  expect(mocks.fetch).not.toHaveBeenCalled()
})
it('refuses cross-origin API before sending credentials', async () => {
  mocks.base = 'https://sink.example.test'
  await expect(listVisualPreviewFiles('secret', undefined, 'owned')).rejects.toMatchObject({ reason: 'denied' })
  await expect(loadVisualPreview('secret', file, 'part', undefined, 'owned')).rejects.toMatchObject({ reason: 'denied' })
  expect(mocks.fetch).not.toHaveBeenCalled()
})
it('preserves ordinary Visual transport when managed source is absent', async () => {
  await listVisualPreviewFiles('legacy')
  expect(mocks.fetch.mock.calls[0][0]).toBe('/api/plm-embed/visual-preview/files')
  expect(mocks.fetch.mock.calls[0][1].credentials).toBeUndefined()
  expect(mocks.fetch.mock.calls[0][1].body).toBeUndefined()
})
it('uses fresh signed frame-read requests and discards a previous-source listing', async () => {
  let release!: (value: unknown) => void
  mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const posted = vi.spyOn(window.parent, 'postMessage').mockImplementation((message: any, targetOrigin: any) => {
    expect(message.purpose).toBe('discussion-read'); expect(targetOrigin).toBe(origin)
    queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { source: window.parent, origin,
      data: { type: 'plm-embed:token-response', nonce: message.nonce, token: 'fresh-' + message.nonce } })))
  })
  const props = reactive({ parentOrigin: origin, partId: 'part', managedSourceId: 'source-A' })
  app = createApp({ render: () => h(Panel, props) }); app.mount(host); await settle()
  props.managedSourceId = 'source-B'; await settle()
  release({ ok: true, status: 200, json: async () => ({ ok: true, data: { files: [{ ...file, filename: 'stale-A.png' }], has_more: false } }) }); await settle()
  expect(host.textContent).not.toContain('stale-A.png'); expect(host.textContent).toContain('owned.png')
  expect(posted).toHaveBeenCalledTimes(2)
  expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual(['/api/plm/managed-login/sources/source-A/discussion', '/api/plm/managed-login/sources/source-B/discussion'])
})
