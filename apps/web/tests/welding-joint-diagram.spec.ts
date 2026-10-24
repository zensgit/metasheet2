import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import Preview from '../src/views/welding/WeldingJointDiagramPreview.vue'
import type { ResourceMaintenanceRecord } from '../src/services/welding/resourceContracts'
import type { RequestScope } from '../src/services/welding/planClient'
import { EXPLICIT_SESSION_ORG_KEY } from '../src/utils/explicitSessionOrg'

const nativeUrl = URL
class ImageStub {
  static images: ImageStub[] = []
  naturalWidth = 2; naturalHeight = 3; src = ''; onload: (() => void) | null = null; onerror: (() => void) | null = null
  constructor() { ImageStub.images.push(this) }
}
const fixed = (): ResourceMaintenanceRecord => ({ resource_id: 'r', item_version_id: 'v', name: 'Joint', number: 'J1', kind: 'joint_diagram', content_hash: 'a'.repeat(64), state: 'Draft', version_label: 'A',
  payload: { schema_version: 1, kind: 'joint_diagram', suggested_fields: {}, document: { item_id: 'd', version_id: 'dv', file_id: 'f', file_role: 'reference', expected_fingerprint: 'c'.repeat(64) } },
  sources: { document: { item_id: 'd', version_id: 'dv', file_id: 'f', file_role: 'reference', fingerprint: 'c'.repeat(64), checksum: 'b'.repeat(64), title: 'Joint', file_name: 'joint.png', version_label: 'A', state: 'Draft', is_released: false },
    diagram: { schema: 'yuantus.welding_joint_diagram/1', actual_sha256: 'b'.repeat(64), byte_size: 3, mime_type: 'image/png', format: 'png', width: 2, height: 3, exif_orientation: 6 } } })
let app: App<Element> | undefined, root: HTMLDivElement
const revoked = vi.fn(), created = vi.fn(() => 'blob:test')
function mount(load = vi.fn(async (scope: RequestScope) => ({ record: fixed(), blob: new Blob(['abc'], { type: 'image/png' }), scope }))) {
  const state = reactive({ stamp: 'fixed', disabled: false }), ready = vi.fn()
  root = document.createElement('div'); document.body.append(root)
  app = createApp({ render: () => h(Preview, { ...state, load, onReady: ready }) }); app.mount(root)
  return { state, ready, load }
}
async function start() { root.querySelector('button')!.click(); await vi.waitFor(() => expect(ImageStub.images).toHaveLength(1)); return ImageStub.images[0] }
beforeEach(() => {
  ImageStub.images = []; revoked.mockClear(); created.mockClear(); localStorage.setItem('auth_token', 'native')
  vi.stubGlobal('Image', ImageStub)
  vi.stubGlobal('URL', class extends nativeUrl { static createObjectURL = created; static revokeObjectURL = revoked })
})
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('fixed diagram Blob lifecycle (mock image, not native decode qualification)', () => {
  it('publishes only after display dimensions match and revokes on edit even if reverted', async () => {
    const f = mount(), image = await start()
    expect(root.querySelector('img')).toBeNull(); expect(f.ready).toHaveBeenLastCalledWith(null)
    image.onload!(); await vi.waitFor(() => expect(root.querySelector('img')).not.toBeNull())
    const proof = f.ready.mock.calls.at(-1)![0]; expect(proof.record.item_version_id).toBe('v'); expect(proof.scope.accepts()).toBe(true)
    f.state.stamp = 'edited'; await nextTick(); expect(root.querySelector('img')).toBeNull(); expect(revoked).toHaveBeenCalledTimes(1); expect(proof.scope.accepts()).toBe(false)
    f.state.stamp = 'fixed'; await nextTick(); expect(root.querySelector('img')).toBeNull()
  })
  it('rejects wrong orientation dimensions and decode failure without a ready proof', async () => {
    const f = mount(), image = await start(); image.naturalWidth = 3; image.naturalHeight = 2; image.onload!()
    await vi.waitFor(() => expect(root.textContent).toContain('尺寸不匹配')); expect(root.querySelector('img')).toBeNull(); expect(revoked).toHaveBeenCalledTimes(1)
    root.querySelector('button')!.click(); await vi.waitFor(() => expect(ImageStub.images).toHaveLength(2)); ImageStub.images[1].onerror!()
    await vi.waitFor(() => expect(root.textContent).toContain('无法显示')); expect(f.ready.mock.calls.every(([value]) => value === null)).toBe(true)
  })
  it('discards a late image event after target changes and after unmount', async () => {
    const f = mount(), image = await start(), late = image.onload!
    f.state.stamp = 'other-target'; await nextTick(); late(); await nextTick()
    expect(root.querySelector('img')).toBeNull(); expect(f.ready.mock.calls.every(([value]) => value === null)).toBe(true)
    root.querySelector('button')!.click(); await vi.waitFor(() => expect(ImageStub.images).toHaveLength(2))
    const afterUnmount = ImageStub.images[1].onload!; app!.unmount(); app = undefined; afterUnmount(); await nextTick()
    expect(revoked).toHaveBeenCalledTimes(2)
  })
  it('does not create a Blob URL for a late fetch after selection changed', async () => {
    let finish!: () => void
    const load = vi.fn((scope: RequestScope) => new Promise<{ record: ResourceMaintenanceRecord; blob: Blob; scope: RequestScope }>(resolve => { finish = () => resolve({ record: fixed(), blob: new Blob(['abc'], { type: 'image/png' }), scope }) }))
    const f = mount(load); root.querySelector('button')!.click(); await vi.waitFor(() => expect(load).toHaveBeenCalled())
    f.state.stamp = 'other'; await nextTick(); finish(); await nextTick(); await nextTick(); expect(created).not.toHaveBeenCalled()
  })
  it('clears displayed bytes immediately on explicit organization StorageEvent', async () => {
    const f = mount(), image = await start(); image.onload!(); await vi.waitFor(() => expect(root.querySelector('img')).not.toBeNull())
    window.dispatchEvent(new StorageEvent('storage', { key: EXPLICIT_SESSION_ORG_KEY, newValue: 'changing' })); await nextTick()
    expect(root.querySelector('img')).toBeNull(); expect(f.ready).toHaveBeenLastCalledWith(null); expect(revoked).toHaveBeenCalledTimes(1)
  })
  it('bounds stalled display decoding and revokes the pending URL', async () => {
    vi.useFakeTimers(); mount(); await start(); await vi.advanceTimersByTimeAsync(15001)
    expect(root.textContent).toContain('15 秒'); expect(root.querySelector('img')).toBeNull()
  })
  it('bounds a loader whose fresh authority never returns', async () => {
    vi.useFakeTimers()
    const load = vi.fn((_scope: RequestScope) => new Promise<{ record: ResourceMaintenanceRecord; blob: Blob; scope: RequestScope }>(() => {}))
    mount(load); root.querySelector('button')!.click(); await vi.advanceTimersByTimeAsync(30001)
    expect(root.textContent).toContain('30 秒'); expect(created).not.toHaveBeenCalled(); expect(root.querySelector('button')!.disabled).toBe(false)
  })
})
