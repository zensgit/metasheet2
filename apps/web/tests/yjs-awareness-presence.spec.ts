import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { useYjsDocument } from '../src/multitable/composables/useYjsDocument'
import { useYjsTextField } from '../src/multitable/composables/useYjsTextField'
import MetaYjsPresenceChip from '../src/multitable/components/MetaYjsPresenceChip.vue'

type Handler = (...args: any[]) => void

const handlers = new Map<string, Handler>()
const emitMock = vi.fn()
const disconnectMock = vi.fn()
const ioMock = vi.fn(() => ({
  connected: true,
  on: (event: string, handler: Handler) => {
    handlers.set(event, handler)
  },
  emit: emitMock,
  disconnect: disconnectMock,
}))

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: vi.fn(() => 'jwt-token'),
    getCurrentUserId: vi.fn().mockResolvedValue('user_self'),
  }),
}))

async function flushUi(cycles = 6): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('Yjs awareness presence', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    handlers.clear()
    emitMock.mockReset()
    disconnectMock.mockReset()
    ioMock.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('tracks collaborators per field and emits active field presence', async () => {
    const recordId = ref('rec_yjs_1')
    let activeCollaboratorCount: { value: number } = ref(0)
    let getFieldCollaborators: (fieldId: string) => Array<{ id: string; fieldIds: string[] }> = () => []

    app = createApp(defineComponent({
      setup() {
        const yjs = useYjsDocument(recordId)
        useYjsTextField(yjs.doc, 'fld_body', { setActiveField: yjs.setActiveField })
        activeCollaboratorCount = yjs.activeCollaboratorCount
        getFieldCollaborators = yjs.getFieldCollaborators
        return () => h('div')
      },
    }))
    app.mount(container!)
    await flushUi()

    expect(ioMock).toHaveBeenCalledTimes(1)
    handlers.get('connect')?.()
    await flushUi(2)

    expect(emitMock).toHaveBeenCalledWith('yjs:subscribe', { recordId: 'rec_yjs_1' })

    // Backend seeds Y.Text entries for string fields on fresh-doc
    // create. Simulate that by pushing a SyncStep2 carrying a primer
    // Y.Doc with `fld_body` already present. Without this, the seed
    // guard in useYjsTextField keeps it inactive and never emits
    // `yjs:presence`.
    const encodingModule = await import('lib0/encoding')
    const Y = await import('yjs')
    const primer = new Y.Doc()
    const seededBody = new Y.Text()
    primer.getMap('fields').set('fld_body', seededBody)
    const primerUpdate = Y.encodeStateAsUpdate(primer)
    primer.destroy()
    const encoder = encodingModule.createEncoder()
    encodingModule.writeVarUint(encoder, 0)
    encodingModule.writeVarUint(encoder, 1)
    encodingModule.writeVarUint8Array(encoder, primerUpdate)
    handlers.get('yjs:message')?.({
      recordId: 'rec_yjs_1',
      data: Array.from(encodingModule.toUint8Array(encoder)),
    })
    await flushUi(3)

    expect(emitMock).toHaveBeenCalledWith('yjs:presence', {
      recordId: 'rec_yjs_1',
      fieldId: 'fld_body',
    })

    handlers.get('yjs:presence')?.({
      recordId: 'rec_yjs_1',
      activeCount: 3,
      users: [
        { id: 'user_self', fieldIds: ['fld_body'] },
        { id: 'user_other', fieldIds: ['fld_body'] },
        { id: 'user_viewer', fieldIds: [] },
      ],
    })
    await flushUi(2)

    expect(activeCollaboratorCount.value).toBe(2)
    expect(getFieldCollaborators('fld_body').map((user) => user.id)).toEqual(['user_other'])

    app.unmount()
    app = null
    await flushUi(2)

    expect(emitMock).toHaveBeenCalledWith('yjs:presence', {
      recordId: 'rec_yjs_1',
      fieldId: null,
    })
  })

  it('renders a compact chip for filtered collaborators', async () => {
    app = createApp(defineComponent({
      setup() {
        return () => h(MetaYjsPresenceChip, {
          label: 'Editing now',
          currentUserId: 'user_self',
          fieldId: 'fld_body',
          users: [
            { id: 'user_self', fieldIds: ['fld_body'] },
            { id: 'user_alpha', fieldIds: ['fld_body'] },
            { id: 'user_beta', fieldIds: ['fld_body'] },
            { id: 'user_gamma', fieldIds: [] },
          ],
        })
      },
    }))
    app.mount(container!)
    await flushUi(2)

    expect(container?.textContent).toContain('Editing now')
    expect(container?.textContent).toContain('user_alpha, user_beta')
    expect(container?.textContent).not.toContain('user_self')
    expect(container?.textContent).not.toContain('user_gamma')
  })
})
