import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ requestToken: vi.fn(), dispose: vi.fn(), list: vi.fn(), image: vi.fn() }))
vi.mock('../src/services/integration/plmEmbedWriteToken', () => ({
  createPlmEmbedVisualPreviewTokenClient: () => ({ requestToken: calls.requestToken, dispose: calls.dispose }),
  PlmEmbedReadTokenError: class PlmEmbedReadTokenError extends Error {},
}))
vi.mock('../src/services/integration/plmEmbedVisualPreview', () => ({
  VisualPreviewAccessError: class VisualPreviewAccessError extends Error {
    readonly reason: 'denied' | 'offline'
    constructor(reason: 'denied' | 'offline') { super(reason); this.reason = reason }
  },
  listVisualPreviewFiles: (...args: unknown[]) => calls.list(...args),
  loadVisualPreview: (...args: unknown[]) => calls.image(...args),
}))

import PlmEmbedVisualPreviewPanel from '../src/components/plm/PlmEmbedVisualPreviewPanel.vue'
import { PlmEmbedReadTokenError } from '../src/services/integration/plmEmbedWriteToken'
import { VisualPreviewAccessError } from '../src/services/integration/plmEmbedVisualPreview'

const FILE = { file_id: 'real-file', version_id: 'real-version', filename: 'drawing.png', version_is_current: true }
const DESCRIPTOR = { schema_version: 1 as const, part_id: 'P1', file_id: FILE.file_id, file_version: FILE.version_id,
  content_checksum: 'a'.repeat(64), preview_checksum: 'b'.repeat(64), page: 0 as const,
  preview_width: 100, preview_height: 80, version_is_current: true }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('embedded visual preview panel', () => {
  let app: App<Element> | null = null
  let host: HTMLDivElement | null = null
  beforeEach(() => {
    for (const fn of Object.values(calls)) fn.mockReset()
    calls.requestToken.mockResolvedValueOnce('fresh-list-token').mockResolvedValueOnce('fresh-image-token')
    calls.list.mockResolvedValue({ files: [FILE], hasMore: false })
    calls.image.mockResolvedValue({ render: 'available', blob: new Blob(['png'], { type: 'image/png' }), descriptor: DESCRIPTOR })
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 100, height: 80, close: vi.fn() })))
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:preview'),
      revokeObjectURL: vi.fn(),
    })
    host = document.createElement('div')
    document.body.appendChild(host)
  })
  afterEach(() => {
    app?.unmount()
    host?.remove()
    app = null
    host = null
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('lists real file/version pairs and uses a fresh token for the selected image', async () => {
    app = createApp(PlmEmbedVisualPreviewPanel, { parentOrigin: 'https://plm.example.com', partId: 'P1' })
    app.mount(host!)
    await flush(); await nextTick()
    expect(calls.list).toHaveBeenCalledWith('fresh-list-token', expect.any(AbortSignal), undefined)
    expect(host!.querySelector('select option')?.textContent).toContain('drawing.png')
    expect(host!.querySelector('input')).toBeNull()
    ;(host!.querySelector('button') as HTMLButtonElement).click()
    await flush(); await nextTick()
    expect(calls.requestToken).toHaveBeenCalledTimes(2)
    expect(calls.image).toHaveBeenCalledWith('fresh-image-token', FILE, 'P1', expect.any(AbortSignal), undefined)
    expect(host!.querySelector('img')?.getAttribute('src')).toBe('blob:preview')
    app.unmount(); app = null
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
    expect(calls.dispose).toHaveBeenCalled()
  })

  it('shows honest unavailability when the provider has no raster', async () => {
    calls.image.mockResolvedValue({ render: 'unavailable' })
    app = createApp(PlmEmbedVisualPreviewPanel, { parentOrigin: 'https://plm.example.com', partId: 'P1' })
    app.mount(host!)
    await flush(); await nextTick()
    ;(host!.querySelector('button') as HTMLButtonElement).click()
    await flush(); await nextTick()
    expect(host!.querySelector('[data-testid="plm-visual-preview-missing"]')).not.toBeNull()
    expect(host!.querySelector('img')).toBeNull()
  })

  it.each(['denied', 'offline'] as const)('shows a distinct %s state while leaving retry available', async (reason) => {
    calls.list.mockRejectedValue(new VisualPreviewAccessError(reason))
    app = createApp(PlmEmbedVisualPreviewPanel, { parentOrigin: 'https://plm.example.com', partId: 'P1' })
    app.mount(host!)
    await flush(); await nextTick()
    expect(host!.querySelector(`[data-testid="plm-visual-preview-${reason}"]`)).not.toBeNull()
    expect(host!.querySelector('button')?.textContent).toBe('重新加载')
    expect(host!.querySelector('img')).toBeNull()
    expect(host!.querySelector('[data-testid="markup-stage"]')).toBeNull()
  })

  it('retries one exact parent rate limit, then lists without a user click', async () => {
    calls.requestToken.mockReset().mockRejectedValueOnce(new PlmEmbedReadTokenError('rate_limited')).mockResolvedValueOnce('retry-token')
    vi.useFakeTimers()
    app = createApp(PlmEmbedVisualPreviewPanel, { parentOrigin: 'https://plm.example.com', partId: 'P1' })
    app.mount(host!)
    await nextTick(); await Promise.resolve()
    expect(calls.requestToken).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6100)
    await nextTick()
    expect(calls.requestToken).toHaveBeenCalledTimes(2)
    expect(calls.list).toHaveBeenCalledWith('retry-token', expect.any(AbortSignal), undefined)
    expect(host!.querySelector('select option')?.textContent).toContain('drawing.png')
  })

  it('does not issue the delayed request after a Part change or unmount', async () => {
    calls.requestToken.mockReset().mockRejectedValueOnce(new PlmEmbedReadTokenError('rate_limited')).mockResolvedValueOnce('new-part-token')
    const part = ref('P1')
    vi.useFakeTimers()
    app = createApp({ render: () => h(PlmEmbedVisualPreviewPanel, { parentOrigin: 'https://plm.example.com', partId: part.value }) })
    app.mount(host!)
    await nextTick(); await Promise.resolve()
    part.value = 'P2'
    await nextTick(); await Promise.resolve()
    expect(calls.requestToken).toHaveBeenCalledTimes(2)
    app.unmount(); app = null
    await vi.advanceTimersByTimeAsync(6100)
    expect(calls.requestToken).toHaveBeenCalledTimes(2)
    expect(calls.list).not.toHaveBeenCalled() // resolved credential was discarded after unmount
  })
  it('binds a keyboard draft to the verified descriptor and shows loaded matching annotations', async () => {
    const draft = vi.fn()
    const annotation = { id: 'c1', body: '<script>inert</script>', markup: { binding_state: 'bound' as const,
      id: 'm1', descriptor: DESCRIPTOR, markup: { schema_version: 1 as const, markup_type: 'pin' as const,
        geometry: { x: 0.25, y: 0.75 }, file_id: FILE.file_id, viewport: { width: 100, height: 80, rotation: 0 as const } } } }
    app = createApp(PlmEmbedVisualPreviewPanel, { parentOrigin: 'https://plm.example.com', partId: 'P1', comments: [annotation], onDraft: draft })
    app.mount(host!)
    await flush(); await nextTick()
    ;(host!.querySelector('button') as HTMLButtonElement).click()
    await flush(); await nextTick()
    const stage = host!.querySelector('[data-testid="markup-stage"]')!
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(draft).toHaveBeenLastCalledWith({ descriptor: DESCRIPTOR, tool: 'pin', geometry: { x: 0.5, y: 0.5 } })
    expect(host!.querySelector('[data-testid="markup-option"]')?.textContent).toContain('<script>inert</script>')
    expect(host!.querySelector('script')).toBeNull()
  })

  it.each([false, 'invalidated'])('keeps historical or newly stale previews read-only (%s)', async (current) => {
    calls.image.mockResolvedValue({ render: 'available', blob: new Blob(['png']), descriptor: { ...DESCRIPTOR, version_is_current: current !== false } })
    const draft = vi.fn()
    app = createApp(PlmEmbedVisualPreviewPanel, { parentOrigin: 'https://plm.example.com', partId: 'P1', onDraft: draft })
    const panel = app.mount(host!) as unknown as { invalidate(): void }
    await flush(); await nextTick()
    ;(host!.querySelector('button') as HTMLButtonElement).click()
    await flush(); await nextTick()
    if (current === 'invalidated') { panel.invalidate(); await nextTick() }
    expect(host!.querySelector('[data-testid="plm-visual-stale"]')).not.toBeNull()
    expect((host!.querySelector('[data-testid="markup-tool-pin"]') as HTMLButtonElement).disabled).toBe(true)
    host!.querySelector('[data-testid="markup-stage"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(draft.mock.calls.every(([value]) => value === null)).toBe(true)
  })

  it('refuses a raster whose decoded size differs from its authenticated binding', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 101, height: 80, close: vi.fn() })))
    app = createApp(PlmEmbedVisualPreviewPanel, { parentOrigin: 'https://plm.example.com', partId: 'P1' })
    app.mount(host!)
    await flush(); await nextTick()
    ;(host!.querySelector('button') as HTMLButtonElement).click()
    await flush(); await nextTick()
    expect(host!.querySelector('[data-testid="plm-visual-preview-missing"]')).not.toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('removes cached pixels and annotations when a later request reports denied access', async () => {
    const draft = vi.fn()
    app = createApp(PlmEmbedVisualPreviewPanel, { parentOrigin: 'https://plm.example.com', partId: 'P1', onDraft: draft })
    const panel = app.mount(host!) as unknown as { invalidate(reason: 'denied'): void }
    await flush(); await nextTick()
    ;(host!.querySelector('button') as HTMLButtonElement).click()
    await flush(); await nextTick()
    expect(host!.querySelector('img')).not.toBeNull()
    panel.invalidate('denied')
    await nextTick()
    expect(host!.querySelector('[data-testid="plm-visual-preview-denied"]')).not.toBeNull()
    expect(host!.querySelector('img')).toBeNull()
    expect(host!.querySelector('[data-testid="markup-stage"]')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
    expect(draft).toHaveBeenLastCalledWith(null)
  })

  it('keeps other-version and legacy annotations in text history without overlaying them', async () => {
    const bound = { id: 'c2', body: 'old version', markup: { binding_state: 'bound' as const, id: 'm2',
      descriptor: { ...DESCRIPTOR, file_version: 'old' }, markup: { schema_version: 1 as const, markup_type: 'pin' as const,
        geometry: { x: 0.2, y: 0.3 }, file_id: FILE.file_id, viewport: { width: 100, height: 80, rotation: 0 as const } } } }
    app = createApp(PlmEmbedVisualPreviewPanel, { parentOrigin: 'https://plm.example.com', partId: 'P1',
      comments: [bound, { id: 'c3', body: 'legacy', markup: { binding_state: 'legacy_unbound' } }] })
    app.mount(host!)
    await flush(); await nextTick()
    ;(host!.querySelector('button') as HTMLButtonElement).click()
    await flush(); await nextTick()
    expect(host!.querySelectorAll('[data-testid="markup-option"]')).toHaveLength(0)
    expect(host!.querySelectorAll('[data-testid="plm-visual-unplaced"] li')).toHaveLength(2)
  })

})
