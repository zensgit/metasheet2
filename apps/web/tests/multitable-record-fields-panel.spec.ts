/**
 * W2 S1 (design-lock: docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
 * §7 S1, §8.2): MetaRecordFieldsPanel.vue standalone coverage. This is the NEW component-level safety
 * net for the panel extracted from MetaRecordDrawer.vue's `details` tab body — the pre-existing
 * drawer specs (multitable-record-drawer*.spec.ts, meta-record-drawer-*.spec.ts,
 * multitable-ai-shortcut-drawer.spec.ts, multitable-{barcode,datetime,location,multiselect,
 * qrcode}-field.spec.ts) already re-verify byte-for-byte behavior equivalence through the drawer
 * (frozen-baseline discipline — the P2-2a pattern). This file instead pins the panel's OWN public
 * contract in isolation: props in -> fields render (incl. the load-bearing visibleFields mask), and
 * each of the panel's 7 emits fires upward with the exact payload shape the drawer relays unchanged.
 * Attachment patches also carry the id of the record the write was made on, and a remove or clear-all that
 * ends after the drawer moved on also carries the ids it took out (cells at the end of the file).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App, type VNodeChild } from 'vue'
import MetaRecordFieldsPanel from '../src/multitable/components/MetaRecordFieldsPanel.vue'
import type { AiShortcutState } from '../src/multitable/composables/useAiShortcut'
import type { MetaAttachment, MetaField, MetaFieldPermission, MetaRecord, MetaRowActions } from '../src/multitable/types'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const AI_CONFIG = { kind: 'summarize', sourceFieldIds: ['fld_src'] }

interface HarnessOptions {
  record?: MetaRecord
  fields?: MetaField[]
  canEdit?: boolean
  canComment?: boolean
  fieldPermissions?: Record<string, MetaFieldPermission>
  rowActions?: MetaRowActions | null
  aiShortcut?: AiShortcutState | null
  aiAvailable?: boolean
  onPatch?: (fieldId: string, value: unknown) => void
  onAiPreview?: (field: MetaField) => void
  onAiRun?: (field: MetaField) => void
  onCommentField?: (field: MetaField) => void
  onOpenLinkPicker?: (field: MetaField) => void
  onOpenPersonPicker?: (field: MetaField) => void
  onRunButton?: (payload: { recordId: string; field: MetaField }) => void
}

const DEFAULT_RECORD = { id: 'rec_1', version: 1, data: { fld_title: 'Alpha' } } as unknown as MetaRecord
const DEFAULT_FIELDS = [{ id: 'fld_title', name: 'Title', type: 'string' }] as unknown as MetaField[]

// The one `createApp({ render })` in this file (vue/one-component-per-file counts each such literal).
function mountApp(render: () => VNodeChild): { container: HTMLElement; app: App } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render })
  app.mount(container)
  return { container, app }
}

function mountPanel(options: HarnessOptions = {}): { container: HTMLElement; app: App } {
  return mountApp(() =>
      h(MetaRecordFieldsPanel, {
        record: 'record' in options ? options.record : DEFAULT_RECORD,
        fields: options.fields ?? DEFAULT_FIELDS,
        canEdit: options.canEdit ?? true,
        canComment: options.canComment ?? false,
        fieldPermissions: options.fieldPermissions,
        rowActions: options.rowActions,
        aiShortcut: options.aiShortcut ?? null,
        ...(options.aiAvailable !== undefined ? { aiAvailable: options.aiAvailable } : {}),
        ...(options.onPatch ? { onPatch: options.onPatch } : {}),
        ...(options.onAiPreview ? { onAiPreview: options.onAiPreview } : {}),
        ...(options.onAiRun ? { onAiRun: options.onAiRun } : {}),
        ...(options.onCommentField ? { onCommentField: options.onCommentField } : {}),
        ...(options.onOpenLinkPicker ? { onOpenLinkPicker: options.onOpenLinkPicker } : {}),
        ...(options.onOpenPersonPicker ? { onOpenPersonPicker: options.onOpenPersonPicker } : {}),
        ...(options.onRunButton ? { onRunButton: options.onRunButton } : {}),
      }),
  )
}

describe('MetaRecordFieldsPanel (W2 S1 extraction)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  describe('props in -> fields render', () => {
    it('renders a visible field label + editable control from record/fields/fieldPermissions', async () => {
      const { container, app } = mountPanel()
      await flushUi()
      expect(container.querySelector('.meta-record-drawer__label')?.textContent).toBe('Title')
      const input = container.querySelector('.meta-record-drawer__input') as HTMLInputElement | null
      expect(input).not.toBeNull()
      expect(input?.value).toBe('Alpha')
      app.unmount()
    })

    it('masks a property-hidden field out of visibleFields (load-bearing — mirrors the server visible mask)', async () => {
      const fields = [
        { id: 'fld_shown', name: 'Shown', type: 'string' },
        { id: 'fld_hidden', name: 'Hidden', type: 'string' },
      ] as unknown as MetaField[]
      const record = { id: 'rec_mask', version: 1, data: { fld_shown: 'a', fld_hidden: 'b' } } as unknown as MetaRecord
      const { container, app } = mountPanel({
        record,
        fields,
        fieldPermissions: {
          fld_shown: { visible: true, readOnly: false },
          fld_hidden: { visible: false, readOnly: false },
        },
      })
      await flushUi()
      expect(container.textContent).toContain('Shown')
      expect(container.textContent).not.toContain('Hidden')
      app.unmount()
    })

    it('renders a readOnly field as display-only text, not an editable control', async () => {
      const { container, app } = mountPanel({
        fieldPermissions: { fld_title: { visible: true, readOnly: true } },
      })
      await flushUi()
      expect(container.querySelector('.meta-record-drawer__input')).toBeNull()
      expect(container.querySelector('.meta-record-drawer__text')?.textContent).toContain('Alpha')
      app.unmount()
    })

    it('renders nothing when record is absent (root v-if="record" guard)', async () => {
      const { container, app } = mountPanel({ record: undefined })
      await flushUi()
      expect(container.querySelector('.meta-record-drawer__fields')).toBeNull()
      app.unmount()
    })
  })

  describe('emit parity — exact event name + payload shape, relayed upward unchanged by the drawer', () => {
    it('emits patch(fieldId, value) on a string field change', async () => {
      const patchSpy = vi.fn()
      const { container, app } = mountPanel({ onPatch: patchSpy })
      await flushUi()
      const input = container.querySelector('.meta-record-drawer__input') as HTMLInputElement
      input.value = 'Beta'
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi()
      expect(patchSpy).toHaveBeenCalledTimes(1)
      expect(patchSpy).toHaveBeenCalledWith('fld_title', 'Beta')
      app.unmount()
    })

    it('emits ai-preview(field) and ai-run(field) with the full MetaField object', async () => {
      const previewSpy = vi.fn()
      const runSpy = vi.fn()
      const fields = [{ id: 'fld_ai', name: 'Summary', type: 'string', property: { aiShortcut: AI_CONFIG } }] as unknown as MetaField[]
      const record = { id: 'rec_ai', version: 1, data: { fld_ai: 'v' } } as unknown as MetaRecord
      const { container, app } = mountPanel({
        record,
        fields,
        aiAvailable: true, // A11: the buttons render only when the server reports AI available
        onAiPreview: previewSpy,
        onAiRun: runSpy,
      })
      await flushUi()
      ;(container.querySelector('[data-ai-preview="fld_ai"]') as HTMLButtonElement).click()
      ;(container.querySelector('[data-ai-run="fld_ai"]') as HTMLButtonElement).click()
      expect(previewSpy).toHaveBeenCalledTimes(1)
      expect(previewSpy).toHaveBeenCalledWith(fields[0])
      expect(runSpy).toHaveBeenCalledTimes(1)
      expect(runSpy).toHaveBeenCalledWith(fields[0])
      app.unmount()
    })

    it('emits comment-field(field) when the per-field comment anchor is clicked', async () => {
      const commentSpy = vi.fn()
      const { container, app } = mountPanel({ canComment: true, onCommentField: commentSpy })
      await flushUi()
      const anchor = container.querySelector('[data-comment-field="fld_title"]') as HTMLButtonElement
      expect(anchor).not.toBeNull()
      anchor.click()
      await flushUi()
      expect(commentSpy).toHaveBeenCalledTimes(1)
      expect(commentSpy).toHaveBeenCalledWith(DEFAULT_FIELDS[0])
      app.unmount()
    })

    it('does not render the comment anchor when resolvedCanComment is false (rowActions overrides canComment)', async () => {
      const { container, app } = mountPanel({
        canComment: true,
        rowActions: { canEdit: true, canDelete: true, canComment: false },
      })
      await flushUi()
      expect(container.querySelector('[data-comment-field="fld_title"]')).toBeNull()
      app.unmount()
    })

    it('emits open-link-picker(field) when a link field button is clicked', async () => {
      const linkSpy = vi.fn()
      const fields = [{ id: 'fld_link', name: 'Vendor', type: 'link' }] as unknown as MetaField[]
      const record = { id: 'rec_link', version: 1, data: { fld_link: [] } } as unknown as MetaRecord
      const { container, app } = mountPanel({ record, fields, onOpenLinkPicker: linkSpy })
      await flushUi()
      ;(container.querySelector('.meta-record-drawer__link-btn') as HTMLButtonElement).click()
      await flushUi()
      expect(linkSpy).toHaveBeenCalledTimes(1)
      expect(linkSpy).toHaveBeenCalledWith(fields[0])
      app.unmount()
    })

    it('emits open-person-picker(field) (not open-link-picker) when a person field button is clicked', async () => {
      const linkSpy = vi.fn()
      const personSpy = vi.fn()
      const fields = [{ id: 'fld_owner', name: 'Owner', type: 'person' }] as unknown as MetaField[]
      const record = { id: 'rec_person', version: 1, data: { fld_owner: [] } } as unknown as MetaRecord
      const { container, app } = mountPanel({
        record,
        fields,
        onOpenLinkPicker: linkSpy,
        onOpenPersonPicker: personSpy,
      })
      await flushUi()
      ;(container.querySelector('[data-test="drawer-person-picker-open"]') as HTMLButtonElement).click()
      await flushUi()
      expect(personSpy).toHaveBeenCalledTimes(1)
      expect(personSpy).toHaveBeenCalledWith(fields[0])
      expect(linkSpy).not.toHaveBeenCalled()
      app.unmount()
    })

    it('emits run-button({ recordId, field }) for a button field, matching the grid\'s payload shape', async () => {
      const runButtonSpy = vi.fn()
      const fields = [{ id: 'fld_run', name: 'Run', type: 'button', property: {} }] as unknown as MetaField[]
      const record = { id: 'rec_button', version: 1, data: {} } as unknown as MetaRecord
      const { container, app } = mountPanel({ record, fields, onRunButton: runButtonSpy })
      await flushUi()
      ;(container.querySelector('[data-test="drawer-button"]') as HTMLButtonElement).click()
      await flushUi()
      expect(runButtonSpy).toHaveBeenCalledTimes(1)
      expect(runButtonSpy).toHaveBeenCalledWith({ recordId: 'rec_button', field: fields[0] })
      app.unmount()
    })
  })

  describe('HI-1 — zero new data paths', () => {
    it('makes no fetch calls of its own (pure presentation over props already on the drawer)', async () => {
      // The panel accepts no apiClient prop at all (TS contract) — this test documents/pins that
      // absence at runtime too: mounting and interacting never touches window.fetch.
      const originalFetch = (globalThis as any).fetch
      const fetchCalls: unknown[] = []
      ;(globalThis as any).fetch = (...args: unknown[]) => {
        fetchCalls.push(args)
        return Promise.reject(new Error('unexpected fetch in MetaRecordFieldsPanel'))
      }
      const { container, app } = mountPanel({ canComment: true })
      await flushUi()
      const input = container.querySelector('.meta-record-drawer__input') as HTMLInputElement
      input.value = 'Gamma'
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi()
      expect(fetchCalls).toHaveLength(0)
      ;(globalThis as any).fetch = originalFetch
      app.unmount()
    })
  })
})

// --- record binding of attachment writes ------------------------------------------------------------
// The panel is reused when the drawer moves to another record, and an upload or delete can end after
// that. These cells mount it over reactive props so `record` can change mid-write.

const F_FILES = { id: 'fld_files', name: 'Files', type: 'attachment' } as unknown as MetaField
const filesRecord = (id: string, ids: string[], version = 1) =>
  ({ id, version, data: { fld_files: ids } }) as unknown as MetaRecord
const REC_A = filesRecord('rec_A', ['att_a1'])
const REC_B = filesRecord('rec_B', ['att_b1'])
const CTX_A = { recordId: 'rec_A', fieldId: 'fld_files' }

const boundApps: App[] = []
type PanelProps = Record<string, unknown>
function mountBoundPanel(initial: PanelProps): { container: HTMLElement; set: (patch: PanelProps) => void } {
  const state = ref<PanelProps>({ fields: [F_FILES], canEdit: true, canComment: false, ...initial })
  const { container, app } = mountApp(() => h(MetaRecordFieldsPanel, { ...state.value }))
  boundApps.push(app)
  return { container, set: (patch) => { state.value = { ...state.value, ...patch } } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function attachment(id: string, filename: string): MetaAttachment {
  return {
    id,
    filename,
    mimeType: 'application/pdf',
    size: 1024,
    url: `/api/multitable/attachments/${id}`,
    thumbnailUrl: null,
    uploadedAt: '2026-07-15T00:00:00.000Z',
  }
}

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('.meta-record-drawer__file-input') as HTMLInputElement
}

function pickFiles(container: HTMLElement, names: string[]): File[] {
  const files = names.map((name) => new File(['x'], name, { type: 'application/pdf' }))
  const input = fileInput(container)
  Object.defineProperty(input, 'files', {
    value: {
      ...files,
      length: files.length,
      item: (index: number) => files[index] ?? null,
      [Symbol.iterator]: function* iterator() { yield* files },
    },
    configurable: true,
  })
  input.dispatchEvent(new Event('change'))
  return files
}

function shownNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.meta-attachment-list__name')).map((el) => el.textContent ?? '')
}

function uploadingText(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.meta-record-drawer__uploading')
}

function errorText(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.meta-record-drawer__error')
}

describe('MetaRecordFieldsPanel — attachment writes stay on the record they started on', () => {
  afterEach(() => {
    while (boundApps.length) boundApps.pop()!.unmount()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  describe('upload', () => {
    it('an upload that ends after the drawer moved to B patches A, with A\'s list', async () => {
      const upload = deferred<MetaAttachment>()
      const uploadFn = vi.fn(() => upload.promise)
      const onPatch = vi.fn()
      const { container, set } = mountBoundPanel({ record: REC_A, uploadFn, onPatch })
      await flushUi()

      const [file] = pickFiles(container, ['new.pdf'])
      await flushUi()
      expect(uploadFn).toHaveBeenCalledWith(file, CTX_A)
      set({ record: REC_B })
      await flushUi()
      upload.resolve(attachment('att_new', 'new.pdf'))
      await flushUi()

      expect(onPatch).toHaveBeenCalledTimes(1)
      expect(onPatch).toHaveBeenCalledWith('fld_files', ['att_a1', 'att_new'], 'rec_A')
      for (const call of onPatch.mock.calls) {
        expect(call).not.toContain('rec_B')
        expect(call[1]).not.toContain('att_b1')
      }
    })

    it('a file sent after the switch still names A in its upload context', async () => {
      const first = deferred<MetaAttachment>()
      const second = deferred<MetaAttachment>()
      const uploadFn = vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
      const onPatch = vi.fn()
      const { container, set } = mountBoundPanel({ record: REC_A, uploadFn, onPatch })
      await flushUi()

      const [, file2] = pickFiles(container, ['one.pdf', 'two.pdf'])
      await flushUi()
      // Switch while the first file is in flight; the second call is made after it resolves.
      set({ record: REC_B })
      await flushUi()
      first.resolve(attachment('att_n1', 'one.pdf'))
      await flushUi()

      expect(uploadFn).toHaveBeenCalledTimes(2)
      expect(uploadFn.mock.calls[1]).toEqual([file2, CTX_A])
      second.resolve(attachment('att_n2', 'two.pdf'))
      await flushUi()
      expect(onPatch).toHaveBeenCalledWith('fld_files', ['att_a1', 'att_n1', 'att_n2'], 'rec_A')
    })

    it('same record, no switch: patches A and clears the uploading state', async () => {
      const upload = deferred<MetaAttachment>()
      const onPatch = vi.fn()
      const { container } = mountBoundPanel({ record: REC_A, uploadFn: vi.fn(() => upload.promise), onPatch })
      await flushUi()

      pickFiles(container, ['new.pdf'])
      await flushUi()
      expect(fileInput(container).disabled).toBe(true)
      expect(uploadingText(container)).not.toBeNull()
      upload.resolve(attachment('att_new', 'new.pdf'))
      await flushUi()

      expect(onPatch).toHaveBeenCalledTimes(1)
      expect(onPatch).toHaveBeenCalledWith('fld_files', ['att_a1', 'att_new'], 'rec_A')
      expect(fileInput(container).disabled).toBe(false)
      expect(uploadingText(container)).toBeNull()
    })

    it('a new object for the same record (version bumped) mid-upload still patches A', async () => {
      const upload = deferred<MetaAttachment>()
      const onPatch = vi.fn()
      const { container, set } = mountBoundPanel({ record: REC_A, uploadFn: vi.fn(() => upload.promise), onPatch })
      await flushUi()

      pickFiles(container, ['new.pdf'])
      await flushUi()
      set({ record: filesRecord('rec_A', ['att_a1'], 2) })
      await flushUi()
      upload.resolve(attachment('att_new', 'new.pdf'))
      await flushUi()

      expect(onPatch).toHaveBeenCalledTimes(1)
      expect(onPatch).toHaveBeenCalledWith('fld_files', ['att_a1', 'att_new'], 'rec_A')
    })

    it('a new object for the same record still counts as shown: a failure shows its error (ids are compared, not objects)', async () => {
      const upload = deferred<MetaAttachment>()
      const { container, set } = mountBoundPanel({ record: REC_A, uploadFn: vi.fn(() => upload.promise), onPatch: vi.fn() })
      await flushUi()

      pickFiles(container, ['new.pdf'])
      await flushUi()
      set({ record: filesRecord('rec_A', ['att_a1'], 2) })
      await flushUi()
      upload.reject(new Error('Quota exceeded'))
      await flushUi()

      expect(errorText(container)?.textContent).toBe('Quota exceeded')
    })
  })

  describe('clear all and remove', () => {
    it('clear all, switched mid-delete: every delete names A and the patch empties A', async () => {
      const d1 = deferred<void>()
      const d2 = deferred<void>()
      const deleteAttachmentFn = vi.fn()
        .mockReturnValueOnce(d1.promise)
        .mockReturnValueOnce(d2.promise)
      const onPatch = vi.fn()
      const { container, set } = mountBoundPanel({
        record: filesRecord('rec_A', ['att_a1', 'att_a2']),
        deleteAttachmentFn,
        onPatch,
      })
      await flushUi()

      ;(container.querySelector('.meta-record-drawer__attachment-clear') as HTMLButtonElement).click()
      await flushUi()
      set({ record: REC_B })
      await flushUi()
      d1.resolve()
      await flushUi()
      d2.resolve()
      await flushUi()

      expect(deleteAttachmentFn.mock.calls).toEqual([['att_a1', CTX_A], ['att_a2', CTX_A]])
      expect(onPatch).toHaveBeenCalledTimes(1)
      expect(onPatch).toHaveBeenCalledWith('fld_files', [], 'rec_A', ['att_a1', 'att_a2'])
    })

    it('remove, switched mid-delete: patches A with the list it started from, minus the id', async () => {
      const del = deferred<void>()
      const deleteAttachmentFn = vi.fn(() => del.promise)
      const onPatch = vi.fn()
      const { container, set } = mountBoundPanel({
        record: filesRecord('rec_A', ['att_a1', 'att_a2']),
        deleteAttachmentFn,
        onPatch,
      })
      await flushUi()

      ;(container.querySelectorAll('.meta-attachment-list__remove')[0] as HTMLButtonElement).click()
      await flushUi()
      expect(deleteAttachmentFn).toHaveBeenCalledWith('att_a1', CTX_A)
      set({ record: REC_B })
      await flushUi()
      del.resolve()
      await flushUi()

      expect(onPatch).toHaveBeenCalledTimes(1)
      expect(onPatch).toHaveBeenCalledWith('fld_files', ['att_a2'], 'rec_A', ['att_a1'])
    })

    it('remove, same record: the current list wins over the one it started from', async () => {
      const del = deferred<void>()
      const onPatch = vi.fn()
      const { container, set } = mountBoundPanel({
        record: filesRecord('rec_A', ['att_a1', 'att_a2']),
        deleteAttachmentFn: vi.fn(() => del.promise),
        onPatch,
      })
      await flushUi()

      ;(container.querySelectorAll('.meta-attachment-list__remove')[0] as HTMLButtonElement).click()
      await flushUi()
      // A reload during the delete brings a third file onto the same record.
      set({ record: filesRecord('rec_A', ['att_a1', 'att_a2', 'att_a3'], 2) })
      await flushUi()
      del.resolve()
      await flushUi()

      expect(onPatch).toHaveBeenCalledTimes(1)
      expect(onPatch).toHaveBeenCalledWith('fld_files', ['att_a2', 'att_a3'], 'rec_A')
    })
  })

  describe('B\'s panel state is left alone by A\'s late upload', () => {
    it('A ending does not clear B\'s own upload in flight', async () => {
      const uploadA = deferred<MetaAttachment>()
      const uploadB = deferred<MetaAttachment>()
      const uploadFn = vi.fn()
        .mockReturnValueOnce(uploadA.promise)
        .mockReturnValueOnce(uploadB.promise)
      const onPatch = vi.fn()
      const { container, set } = mountBoundPanel({ record: REC_A, uploadFn, onPatch })
      await flushUi()

      pickFiles(container, ['a.pdf'])
      await flushUi()
      set({ record: REC_B })
      await flushUi()
      // The record change resets the activity, so B can start its own upload.
      expect(fileInput(container).disabled).toBe(false)
      pickFiles(container, ['b.pdf'])
      await flushUi()
      expect(uploadFn.mock.calls[1][1]).toEqual({ recordId: 'rec_B', fieldId: 'fld_files' })

      uploadA.resolve(attachment('att_new', 'a.pdf'))
      await flushUi()
      expect(onPatch).toHaveBeenCalledWith('fld_files', ['att_a1', 'att_new'], 'rec_A')
      expect(fileInput(container).disabled).toBe(true)
      expect(uploadingText(container)).not.toBeNull()

      uploadB.resolve(attachment('att_b2', 'b.pdf'))
      await flushUi()
      expect(onPatch).toHaveBeenLastCalledWith('fld_files', ['att_b1', 'att_b2'], 'rec_B')
      expect(fileInput(container).disabled).toBe(false)
      expect(uploadingText(container)).toBeNull()
    })

    it('A failing after the switch shows no error under B', async () => {
      const upload = deferred<MetaAttachment>()
      const onPatch = vi.fn()
      const { container, set } = mountBoundPanel({ record: REC_A, uploadFn: vi.fn(() => upload.promise), onPatch })
      await flushUi()

      pickFiles(container, ['new.pdf'])
      await flushUi()
      set({ record: REC_B })
      await flushUi()
      upload.reject(new Error('Quota exceeded'))
      await flushUi()

      expect(errorText(container)).toBeNull()
      expect(onPatch).not.toHaveBeenCalled()
    })

    it('same record: a failure shows the error and clears the uploading state', async () => {
      const upload = deferred<MetaAttachment>()
      const { container } = mountBoundPanel({ record: REC_A, uploadFn: vi.fn(() => upload.promise), onPatch: vi.fn() })
      await flushUi()

      pickFiles(container, ['new.pdf'])
      await flushUi()
      upload.reject(new Error('Quota exceeded'))
      await flushUi()

      expect(errorText(container)?.textContent).toBe('Quota exceeded')
      expect(fileInput(container).disabled).toBe(false)
      expect(uploadingText(container)).toBeNull()
    })

    it('A\'s late summary is not added to B\'s local summaries', async () => {
      const upload = deferred<MetaAttachment>()
      const onPatch = vi.fn()
      const { container, set } = mountBoundPanel({ record: REC_A, uploadFn: vi.fn(() => upload.promise), onPatch })
      await flushUi()

      pickFiles(container, ['new.pdf'])
      await flushUi()
      // B holds an id with no summary of its own, so it renders the id as the name.
      set({ record: filesRecord('rec_B', ['att_new']) })
      await flushUi()
      expect(shownNames(container)).toEqual(['att_new'])
      upload.resolve(attachment('att_new', 'new.pdf'))
      await flushUi()

      expect(onPatch).toHaveBeenCalledWith('fld_files', ['att_a1', 'att_new'], 'rec_A')
      expect(shownNames(container)).toEqual(['att_new'])
    })
  })

  describe('B\'s panel state is left alone by A\'s late clear-all', () => {
    it.each(['ends', 'fails'] as const)('A\'s clear-all that %s after the switch leaves B\'s own upload in flight and shows no error under B', async (outcome) => {
      const del = deferred<void>()
      const uploadB = deferred<MetaAttachment>()
      const onPatch = vi.fn()
      const { container, set } = mountBoundPanel({
        record: REC_A,
        deleteAttachmentFn: vi.fn(() => del.promise),
        uploadFn: vi.fn(() => uploadB.promise),
        onPatch,
      })
      await flushUi()

      ;(container.querySelector('.meta-record-drawer__attachment-clear') as HTMLButtonElement).click()
      await flushUi()
      set({ record: REC_B })
      await flushUi()
      pickFiles(container, ['b.pdf'])
      await flushUi()
      expect(fileInput(container).disabled).toBe(true)

      if (outcome === 'ends') del.resolve()
      else del.reject(new Error('Delete refused'))
      await flushUi()
      expect(onPatch.mock.calls).toEqual(outcome === 'ends' ? [['fld_files', [], 'rec_A', ['att_a1']]] : [])
      expect(fileInput(container).disabled).toBe(true)
      expect(uploadingText(container)).not.toBeNull()
      expect(errorText(container)).toBeNull()
    })
  })

  describe('B\'s panel state is left alone by A\'s late remove', () => {
    // A's delete settling must not end B's upload ('ends': the success guard; 'fails': the catch guard).
    it.each(['ends', 'fails'] as const)('A\'s remove that %s after the switch leaves B\'s own upload in flight and shows no error under B', async (outcome) => {
      const del = deferred<void>()
      const uploadB = deferred<MetaAttachment>()
      const onPatch = vi.fn()
      const { container, set } = mountBoundPanel({
        record: filesRecord('rec_A', ['att_a1', 'att_a2']),
        deleteAttachmentFn: vi.fn(() => del.promise),
        uploadFn: vi.fn(() => uploadB.promise),
        onPatch,
      })
      await flushUi()

      ;(container.querySelectorAll('.meta-attachment-list__remove')[0] as HTMLButtonElement).click()
      await flushUi()
      set({ record: REC_B })
      await flushUi()
      pickFiles(container, ['b.pdf'])
      await flushUi()
      expect(fileInput(container).disabled).toBe(true)

      if (outcome === 'ends') del.resolve()
      else del.reject(new Error('Delete refused'))
      await flushUi()
      expect(onPatch.mock.calls).toEqual(outcome === 'ends' ? [['fld_files', ['att_a2'], 'rec_A', ['att_a1']]] : [])
      expect(fileInput(container).disabled).toBe(true)
      expect(uploadingText(container)).not.toBeNull()
      expect(errorText(container)).toBeNull()
    })
  })

  describe('the removed ids go with the patch only once the drawer has moved on', () => {
    const clickRemove = (container: HTMLElement) =>
      (container.querySelectorAll('.meta-attachment-list__remove')[0] as HTMLButtonElement).click()
    const clickClear = (container: HTMLElement) =>
      (container.querySelector('.meta-record-drawer__attachment-clear') as HTMLButtonElement).click()

    it.each([['a remove', clickRemove], ['a clear-all', clickClear]] as const)('%s while still shown emits exactly (fieldId, value, recordId)', async (_name, act) => {
      const del = deferred<void>()
      const onPatch = vi.fn()
      const { container } = mountBoundPanel({
        record: filesRecord('rec_A', ['att_a1', 'att_a2']),
        deleteAttachmentFn: vi.fn(() => del.promise),
        onPatch,
      })
      await flushUi()

      act(container)
      await flushUi()
      del.resolve()
      await flushUi()

      expect(onPatch).toHaveBeenCalledTimes(1)
      expect(onPatch.mock.calls[0]).toHaveLength(3)
    })

    it.each([['a remove', clickRemove], ['a clear-all', clickClear]] as const)('%s that ends after the switch emits exactly four arguments, the ids it took out last', async (_name, act) => {
      const del = deferred<void>()
      const onPatch = vi.fn()
      const { container, set } = mountBoundPanel({
        record: filesRecord('rec_A', ['att_a1']),
        deleteAttachmentFn: vi.fn(() => del.promise),
        onPatch,
      })
      await flushUi()

      act(container)
      await flushUi()
      set({ record: REC_B })
      await flushUi()
      del.resolve()
      await flushUi()

      expect(onPatch).toHaveBeenCalledTimes(1)
      expect(onPatch.mock.calls[0]).toHaveLength(4)
      expect(onPatch.mock.calls[0][3]).toEqual(['att_a1'])
    })
  })

  describe('other emits keep two arguments', () => {
    it('a text field patch has exactly (fieldId, value)', async () => {
      const onPatch = vi.fn()
      const { container } = mountBoundPanel({
        record: { id: 'rec_A', version: 1, data: { fld_title: 'Alpha', fld_files: ['att_a1'] } } as unknown as MetaRecord,
        fields: [...DEFAULT_FIELDS, F_FILES],
        uploadFn: vi.fn(),
        onPatch,
      })
      await flushUi()

      const input = container.querySelector('.meta-record-drawer__input') as HTMLInputElement
      input.value = 'Beta'
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi()

      expect(onPatch).toHaveBeenCalledTimes(1)
      expect(onPatch.mock.calls[0]).toHaveLength(2)
      expect(onPatch.mock.calls[0]).toEqual(['fld_title', 'Beta'])
    })

    it('without an uploadFn the upload emits at once with (fieldId, names)', async () => {
      const onPatch = vi.fn()
      const { container } = mountBoundPanel({ record: REC_A, onPatch })
      await flushUi()

      pickFiles(container, ['new.pdf'])

      expect(onPatch).toHaveBeenCalledTimes(1)
      expect(onPatch.mock.calls[0]).toEqual(['fld_files', ['att_a1', 'new.pdf']])
    })
  })
})

describe('MetaRecordFieldsPanel — a control reused for the next record shows that record\'s value', () => {
  // The drawer blurs the focused control and moves on in the same tick; both records hold the same value here, so
  // the value the control is given does not change, only the record.
  const F_RICH = { id: 'fld_rich', name: 'Notes', type: 'longText', property: { rich: true } } as unknown as MetaField
  const F_AT = { id: 'fld_at', name: 'When', type: 'dateTime' } as unknown as MetaField
  const sameRecord = (id: string) => ({ id, version: 1, data: { fld_rich: 'same', fld_at: null } }) as unknown as MetaRecord

  afterEach(() => {
    while (boundApps.length) boundApps.pop()!.unmount()
    document.body.innerHTML = ''
  })

  it('the rich text editor: typed on A, then B (same value) shows its own value, and passing through it again commits nothing', async () => {
    const onPatch = vi.fn()
    const { container, set } = mountBoundPanel({ fields: [F_RICH], record: sameRecord('rec_A'), onPatch })
    await flushUi()
    const editable = container.querySelector<HTMLElement>('[data-test="rich-longtext-editor"]')!
    editable.dispatchEvent(new Event('focus'))
    editable.innerHTML = 'same typed on A'
    editable.dispatchEvent(new Event('blur'))
    set({ record: sameRecord('rec_B') })
    await flushUi()
    expect(onPatch.mock.calls).toEqual([['fld_rich', 'same typed on A']])
    expect(editable.innerHTML).toBe('same')
    editable.dispatchEvent(new Event('focus'))
    editable.dispatchEvent(new Event('blur'))
    await flushUi()
    expect(onPatch).toHaveBeenCalledTimes(1)
  })

  it('the date-time box: a draft typed on A is dropped when B (same, empty value) is shown', async () => {
    const { container, set } = mountBoundPanel({ fields: [F_AT], record: sameRecord('rec_A'), onPatch: vi.fn() })
    await flushUi()
    const input = container.querySelector<HTMLInputElement>('#drawer_field_fld_at')!
    input.value = '2031-05-06 07:08'
    input.dispatchEvent(new Event('input'))
    await flushUi()
    set({ record: sameRecord('rec_B') })
    await flushUi()
    expect(input.value).toBe('')
  })
})

describe('MetaRecordFieldsPanel — a text box keeps its typing across its own commit', () => {
  // The box's commit (an earlier blur) is still in flight; the user is back in the box and typing; the server then
  // accepts it, and the record comes back with the committed value.
  const F_TEXT = { id: 'fld_text', name: 'Text', type: 'string' } as unknown as MetaField
  const F_NOTES = { id: 'fld_notes', name: 'Notes', type: 'longText' } as unknown as MetaField
  const F_NUM = { id: 'fld_num', name: 'Amount', type: 'number' } as unknown as MetaField
  const textRecord = (id: string, value: string, version = 1) =>
    ({ id, version, data: { fld_text: value, fld_notes: value, fld_num: 5 } }) as unknown as MetaRecord

  afterEach(() => {
    while (boundApps.length) boundApps.pop()!.unmount()
    document.body.innerHTML = ''
  })

  // Every box the drawer edits by typing: [field, stored, typed since, the value that lands meanwhile, committed]
  const BOXES = [
    ['a text input', F_TEXT, 'n2', 'n2XQQ', 'n2X', 'n2XQQ'],
    ['a textarea', F_NOTES, 'n2', 'n2XQQ', 'n2X', 'n2XQQ'],
    ['a barcode box', { id: 'fld_bar', name: 'Barcode', type: 'barcode' }, 'n2', 'n2XQQ', 'n2X', 'n2XQQ'],
    ['a QR code box', { id: 'fld_qr', name: 'QR', type: 'qrcode' }, 'n2', 'n2XQQ', 'n2X', 'n2XQQ'],
    ['a location box', { id: 'fld_loc', name: 'Place', type: 'location' }, 'n2', 'n2XQQ', 'n2X', { address: 'n2XQQ' }],
    ['a number box', F_NUM, 12, '123', 1, 123],
    ['a date box', { id: 'fld_day', name: 'Day', type: 'date' }, '2031-01-02', '2031-01-09', '2031-01-05', '2031-01-09'],
  ] as const
  const boxRecord = (field: { id: string; type: string }, id: string, stored: unknown, version = 1) =>
    ({ id, version, data: { [field.id]: field.type === 'location' ? { address: stored } : stored } }) as unknown as MetaRecord

  it.each(BOXES)('%s: a value that lands while it is focused and typed in leaves the typing, which the next blur commits', async (_label, field, stored, typed, landing, committed) => {
    const onPatch = vi.fn()
    const { container, set } = mountBoundPanel({ fields: [field as unknown as MetaField], record: boxRecord(field, 'rec_A', stored), onPatch })
    await flushUi()
    const box = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#drawer_field_${field.id}`)!
    box.focus()
    box.value = typed
    set({ record: boxRecord(field, 'rec_A', landing, 2) })
    await flushUi()
    expect(box.value).toBe(typed)
    box.dispatchEvent(new Event('change'))
    expect(onPatch.mock.calls).toEqual([[field.id, committed]])
    // The commit supersedes the value that landed: leaving does not bring it back.
    box.blur()
    await flushUi()
    expect(box.value).toBe(typed)
  })

  it.each(BOXES)('%s: a move to another record writes that record\'s value, also over typing', async (_label, field, stored, typed, landing) => {
    const { container, set } = mountBoundPanel({ fields: [field as unknown as MetaField], record: boxRecord(field, 'rec_A', stored), onPatch: vi.fn() })
    await flushUi()
    const box = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#drawer_field_${field.id}`)!
    box.focus()
    box.value = typed
    set({ record: boxRecord(field, 'rec_B', landing) })
    await flushUi()
    expect(box.value).toBe(String(landing))
  })

  // Counts what is written into the box from now on.
  function countWrites(box: HTMLInputElement) {
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
    let writes = 0
    Object.defineProperty(box, 'value', {
      configurable: true,
      get() { return native.get!.call(this) },
      set(next: string) { writes += 1; native.set!.call(this, next) },
    })
    return () => writes
  }

  it('after a commit, a redraw that brings the same value leaves the box alone (a date box commits while it is still being typed in)', async () => {
    const { container, set } = mountBoundPanel({ fields: [F_TEXT], record: textRecord('rec_A', 'n2'), onPatch: vi.fn() })
    await flushUi()
    const box = container.querySelector<HTMLInputElement>('#drawer_field_fld_text')!
    box.focus()
    box.value = 'n2X'
    box.dispatchEvent(new Event('change'))
    const writes = countWrites(box)
    set({ record: textRecord('rec_A', 'n2X', 2) })
    await flushUi()
    expect(writes()).toBe(0)
    // one that differs (a rollback) is written
    set({ record: textRecord('rec_A', 'n2', 3) })
    await flushUi()
    expect(writes()).toBe(1)
    expect(box.value).toBe('n2')
  })

  it('a draft the box cannot read (a half-typed date, a number box\'s "-") is typing: a value that lands, or the redraw after its own commit, does not clear it', async () => {
    const F_DAY = { id: 'fld_day', name: 'Day', type: 'date' } as unknown as MetaField
    const dayRecord = (day: string | null, version: number) => ({ id: 'rec_A', version, data: { fld_day: day } }) as unknown as MetaRecord
    const onPatch = vi.fn()
    const { container, set } = mountBoundPanel({ fields: [F_DAY], record: dayRecord('2031-01-02', 1), onPatch })
    await flushUi()
    const box = container.querySelector<HTMLInputElement>('#drawer_field_fld_day')!
    const validity = { badInput: false }
    Object.defineProperty(box, 'validity', { get: () => validity, configurable: true })
    box.focus()
    // the day half-typed: the box reads "" and fires its change (the drawer saves "", as before)
    validity.badInput = true
    box.value = ''
    box.dispatchEvent(new Event('change'))
    expect(onPatch.mock.calls).toEqual([['fld_day', '']])
    const writes = countWrites(box)
    // the server's answer (the date it took), then a value from elsewhere
    set({ record: dayRecord(null, 2) })
    await flushUi()
    set({ record: dayRecord('2031-03-04', 3) })
    await flushUi()
    expect(writes()).toBe(0)
    // typed in full: committed
    validity.badInput = false
    box.value = '2031-01-09'
    box.dispatchEvent(new Event('change'))
    expect(onPatch.mock.calls).toEqual([['fld_day', ''], ['fld_day', '2031-01-09']])
  })

  it('a date box cleared in full (not half-typed) commits the empty date', async () => {
    const onPatch = vi.fn()
    const F_DAY = { id: 'fld_day', name: 'Day', type: 'date' } as unknown as MetaField
    const { container } = mountBoundPanel({ fields: [F_DAY], record: { id: 'rec_A', version: 1, data: { fld_day: '2031-01-02' } } as unknown as MetaRecord, onPatch })
    await flushUi()
    const box = container.querySelector<HTMLInputElement>('#drawer_field_fld_day')!
    box.value = ''
    box.dispatchEvent(new Event('change'))
    expect(onPatch.mock.calls).toEqual([['fld_day', '']])
  })

  it('a value that landed while the box held typing is dropped once another value is written (typing undone, then a newer one lands)', async () => {
    const { container, set } = mountBoundPanel({ fields: [F_TEXT], record: textRecord('rec_A', 'alpha'), onPatch: vi.fn() })
    await flushUi()
    const box = container.querySelector<HTMLInputElement>('#drawer_field_fld_text')!
    box.focus()
    box.value = 'alphaB'
    set({ record: textRecord('rec_A', 'C', 2) })
    await flushUi()
    box.value = 'alpha'
    set({ record: textRecord('rec_A', 'D', 3) })
    await flushUi()
    expect(box.value).toBe('D')
    box.blur()
    await flushUi()
    expect(box.value).toBe('D')
  })

  it('focus that leaves with the typing still there and no commit (a window switch) keeps the typing, and the value waits: undone and left later, the box shows it', async () => {
    const { container, set } = mountBoundPanel({ fields: [F_TEXT], record: textRecord('rec_A', 'alpha'), onPatch: vi.fn() })
    await flushUi()
    const box = container.querySelector<HTMLInputElement>('#drawer_field_fld_text')!
    box.focus()
    box.value = 'alphaB'
    set({ record: textRecord('rec_A', 'C', 2) })
    await flushUi()
    box.blur()
    await flushUi()
    expect(box.value).toBe('alphaB')
    box.focus()
    box.value = 'alpha'
    box.blur()
    await flushUi()
    expect(box.value).toBe('C')
  })

  it('a redraw that brings the same value while the box holds typing is not a value that landed (it can be the value from before the box\'s own commit)', async () => {
    const { container, set } = mountBoundPanel({ fields: [F_TEXT], record: textRecord('rec_A', 'n2'), onPatch: vi.fn() })
    await flushUi()
    const box = container.querySelector<HTMLInputElement>('#drawer_field_fld_text')!
    box.focus()
    box.value = 'n2X'
    box.dispatchEvent(new Event('change'))
    // typing again; the record is redrawn with the value from before the commit (not taken yet)
    box.value = 'n2XY'
    set({ record: textRecord('rec_A', 'n2', 1) })
    await flushUi()
    // the typing undone and the box left: it shows what it committed, not the older value
    box.value = 'n2X'
    box.blur()
    await flushUi()
    expect(box.value).toBe('n2X')
  })

  it('typed, then undone, while a value landed: left with no net typing, the box shows that value', async () => {
    const { container, set } = mountBoundPanel({ fields: [F_TEXT], record: textRecord('rec_A', 'alpha'), onPatch: vi.fn() })
    await flushUi()
    const box = container.querySelector<HTMLInputElement>('#drawer_field_fld_text')!
    box.focus()
    box.value = 'alphaB'
    set({ record: textRecord('rec_A', 'zzz', 2) })
    await flushUi()
    expect(box.value).toBe('alphaB')
    box.value = 'alpha'
    box.blur()
    await flushUi()
    expect(box.value).toBe('zzz')
  })

  it('a stored value the box holds differently (a line break in a single-line box) is not typing: a value that lands is shown', async () => {
    const { container, set } = mountBoundPanel({ fields: [F_TEXT], record: textRecord('rec_A', 'line1\nline2'), onPatch: vi.fn() })
    await flushUi()
    const box = container.querySelector<HTMLInputElement>('#drawer_field_fld_text')!
    box.focus()
    set({ record: textRecord('rec_A', 'fresh', 2) })
    await flushUi()
    expect(box.value).toBe('fresh')
  })

  it('a box that committed what it holds shows the next value, also a rejected commit\'s rollback while it is still focused', async () => {
    const { container, set } = mountBoundPanel({ fields: [F_TEXT], record: textRecord('rec_A', 'n2'), onPatch: vi.fn() })
    await flushUi()
    const box = container.querySelector<HTMLInputElement>('#drawer_field_fld_text')!
    box.focus()
    box.value = 'n2X'
    box.dispatchEvent(new Event('change'))
    // the optimistic value, then the rollback
    set({ record: textRecord('rec_A', 'n2X', 2) })
    await flushUi()
    set({ record: textRecord('rec_A', 'n2', 3) })
    await flushUi()
    expect(document.activeElement).toBe(box)
    expect(box.value).toBe('n2')
  })

  it.each([
    ['focused but not typed in', true, false, 'rec_A', 'other'],
    ['typed in but not focused', false, true, 'rec_A', 'other'],
    ['focused and typed in, but another record', true, true, 'rec_B', 'b'],
  ] as const)('the new value is shown when the box is %s', async (_label, focus, typed, recordId, value) => {
    const { container, set } = mountBoundPanel({ fields: [F_NOTES], record: textRecord('rec_A', 'n2'), onPatch: vi.fn() })
    await flushUi()
    const box = container.querySelector<HTMLTextAreaElement>('#drawer_field_fld_notes')!
    if (focus) box.focus()
    if (typed) box.value = 'n2 typed'
    set({ record: textRecord(recordId, value, 2) })
    await flushUi()
    expect(box.value).toBe(value)
  })

  it('a number box holding a draft it cannot read commits nothing (the stored number stays); an empty box or a number still commits', async () => {
    const onPatch = vi.fn()
    const { container } = mountBoundPanel({ fields: [F_NUM], record: textRecord('rec_A', 'n2'), onPatch })
    await flushUi()
    const box = container.querySelector<HTMLInputElement>('#drawer_field_fld_num')!
    const validity = { badInput: true }
    Object.defineProperty(box, 'validity', { get: () => validity, configurable: true })
    box.value = ''
    box.dispatchEvent(new Event('change'))
    expect(onPatch).not.toHaveBeenCalled()
    validity.badInput = false
    box.dispatchEvent(new Event('change'))
    box.value = '7'
    box.dispatchEvent(new Event('change'))
    expect(onPatch.mock.calls).toEqual([['fld_num', null], ['fld_num', 7]])
  })
})
