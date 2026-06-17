import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, shallowRef, type App, type Ref } from 'vue'
import * as Y from 'yjs'

// Mock useYjsDocument at its boundary: return a fake api wrapping a real Y.Doc
// whose `synced`/`connected`/`error` we drive from the test. This exercises
// useYjsScalarCell's read/write/active/fallback logic against a real `fields`
// Y.Map without standing up Socket.IO.
let sharedDoc: Y.Doc
const docRef = shallowRef<Y.Doc | null>(null)
let syncedRef: Ref<boolean>
let connectedRef: Ref<boolean>
let errorRef: Ref<string | null>
const disposeMock = vi.fn()

vi.mock('../src/multitable/composables/useYjsDocument', () => ({
  useYjsDocument: vi.fn(() => ({
    doc: docRef,
    synced: syncedRef,
    connected: connectedRef,
    error: errorRef,
    activeUsers: ref([]),
    dispose: disposeMock,
    setActiveField: vi.fn(),
    getFieldCollaborators: vi.fn(() => []),
  })),
}))

async function flush(cycles = 14): Promise<void> {
  await vi.dynamicImportSettled()
  for (let i = 0; i < cycles; i += 1) { await Promise.resolve(); await nextTick() }
}

async function loadScalar() {
  return import('../src/multitable/composables/useYjsScalarCell')
}

// Mount a component that calls the composable, exposing the binding to the test.
async function mountBinding(recordId: string | null, fieldId: string | null) {
  const { useYjsScalarCell } = await loadScalar()
  let binding!: ReturnType<typeof useYjsScalarCell>
  const Comp = defineComponent({
    setup() {
      binding = useYjsScalarCell({ recordId: ref(recordId), fieldId: ref(fieldId), connectTimeoutMs: 200 })
      return () => h('div')
    },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(Comp)
  app.mount(container)
  await flush()
  return { binding, app, container }
}

describe('useYjsScalarCell', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    sharedDoc = new Y.Doc()
    docRef.value = sharedDoc
    syncedRef = ref(true)
    connectedRef = ref(true)
    errorRef = ref<string | null>(null)
    disposeMock.mockReset()
    vi.stubEnv('VITE_ENABLE_YJS_COLLAB', 'true')
    // useYjsScalarCell reads isYjsCollabEnabled, which in test mode falls back
    // to process.env — mirror what useYjsCellBinding's tests rely on.
    process.env.VITE_ENABLE_YJS_COLLAB = 'true'
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    delete process.env.VITE_ENABLE_YJS_COLLAB
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('binds a seeded scalar: active + reads the typed value (number)', async () => {
    sharedDoc.getMap('fields').set('fld_num', 42)
    const m = await mountBinding('rec1', 'fld_num')
    app = m.app; container = m.container
    expect(m.binding.active.value).toBe(true)
    expect(m.binding.value.value).toBe(42)
  })

  it('setValue writes the value (typed) into the fields Y.Map', async () => {
    sharedDoc.getMap('fields').set('fld_num', 1)
    const m = await mountBinding('rec1', 'fld_num')
    app = m.app; container = m.container
    m.binding.setValue(99)
    expect(sharedDoc.getMap('fields').get('fld_num')).toBe(99)
    // boolean + select preserve native type through the same path
    sharedDoc.getMap('fields').set('fld_bool', false)
    const m2 = await mountBinding('rec1', 'fld_bool')
    m2.binding.setValue(true)
    expect(sharedDoc.getMap('fields').get('fld_bool')).toBe(true)
    m2.app.unmount(); m2.container.remove()
  })

  it('two-client sync: a scalar set on one doc applies to another via Y.Map LWW', async () => {
    sharedDoc.getMap('fields').set('fld_sel', 'opt_a')
    const m = await mountBinding('rec1', 'fld_sel')
    app = m.app; container = m.container
    m.binding.setValue('opt_b')
    // Simulate a second connected client receiving the update.
    const doc2 = new Y.Doc()
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(sharedDoc))
    expect(doc2.getMap('fields').get('fld_sel')).toBe('opt_b')
  })

  it('absent key (unseeded scalar) stays inactive → caller keeps REST', async () => {
    // fields map has no 'fld_unseeded' key
    const m = await mountBinding('rec1', 'fld_unseeded')
    app = m.app; container = m.container
    expect(m.binding.active.value).toBe(false)
    expect(m.binding.value.value).toBeUndefined()
    // setValue is a no-op when inactive (never clobbers an unseeded key)
    m.binding.setValue(7)
    expect(sharedDoc.getMap('fields').has('fld_unseeded')).toBe(false)
  })

  it('remote update to the bound key refreshes the reactive value', async () => {
    sharedDoc.getMap('fields').set('fld_num', 5)
    const m = await mountBinding('rec1', 'fld_num')
    app = m.app; container = m.container
    expect(m.binding.value.value).toBe(5)
    sharedDoc.getMap('fields').set('fld_num', 8) // simulates an applied remote update
    await flush(4)
    expect(m.binding.value.value).toBe(8)
  })

  it('flag OFF → inert (no active, setValue no-op)', async () => {
    delete process.env.VITE_ENABLE_YJS_COLLAB
    vi.unstubAllEnvs()
    sharedDoc.getMap('fields').set('fld_num', 1)
    const m = await mountBinding('rec1', 'fld_num')
    app = m.app; container = m.container
    expect(m.binding.active.value).toBe(false)
    m.binding.setValue(2)
    expect(sharedDoc.getMap('fields').get('fld_num')).toBe(1) // unchanged
  })
})
