/**
 * W2 S5 (design-lock: docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
 * §2 附件面板 row, §5, §7 S5, §8): MetaRecordAttachmentsPanel.vue -- the NEW 4th inspector tab,
 * aggregating a record's attachment fields into one view.
 *
 * THE OWNER-MANDATED MASK CONTRACT (Medium-3, this is the security-critical part of this file):
 * iteration source = fields visible at BOTH layer-2 (property-hidden) AND layer-3 (RBAC field-mask),
 * filtered to attachment type -- NOT all fields, and NOT `Object.keys(attachmentSummariesByField)`
 * (those keys can include a field this actor cannot see -- the server populates attachment summaries
 * independent of the field mask -- so reading them directly would be a mask bypass). The "mask
 * contract" describe block below constructs BOTH negatives (N1 property-hidden, N2 RBAC-denied) with
 * `attachmentSummariesByField` DELIBERATELY populated for the masked field (simulating exactly that
 * server behavior), so a component that read the summary-map keys instead of the field list would
 * leak the attachment -- and a positive control proving the negatives are not vacuous (the panel CAN
 * render attachments when the same field is made visible on both layers).
 *
 * Also: HI-1 (zero new data paths -- source scan + positive control + fetch-monkeypatch) and
 * upload/delete emit parity through the reused `uploadFn`/`deleteAttachmentFn` + MetaAttachmentList.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef, type App } from 'vue'
import MetaRecordAttachmentsPanel from '../src/multitable/components/MetaRecordAttachmentsPanel.vue'
import type { MetaAttachment, MetaField, MetaFieldPermission, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, '..', rel), 'utf8')
}

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []

function mount(props: Record<string, unknown>): HTMLDivElement {
  return mountReactive(props).container
}

// The props can change after mount (the drawer moving to another record): `set` replaces some of them.
function mountReactive(props: Record<string, unknown>): { container: HTMLDivElement; set: (patch: Record<string, unknown>) => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = shallowRef<Record<string, unknown>>(props)
  const app = createApp({ render: () => h(MetaRecordAttachmentsPanel, { ...state.value }) })
  app.mount(container)
  mounts.push({ app, container })
  return { container, set: (patch) => { state.value = { ...state.value, ...patch } } }
}

afterEach(() => {
  while (mounts.length) {
    const m = mounts.pop()!
    m.app.unmount()
    m.container.remove()
  }
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

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

const RECORD = (data: Record<string, unknown>): MetaRecord => ({ id: 'rec_1', version: 1, data })

describe('MetaRecordAttachmentsPanel (W2 S5)', () => {
  describe('aggregation render', () => {
    it('renders one group per visible attachment field, with that field\'s attachments', async () => {
      const fields: MetaField[] = [
        { id: 'fld_a', name: 'Contracts', type: 'attachment' },
        { id: 'fld_b', name: 'Photos', type: 'attachment' },
        { id: 'fld_title', name: 'Title', type: 'string' },
      ]
      const container = mount({
        record: RECORD({ fld_a: ['att_1'], fld_b: ['att_2'], fld_title: 'Alpha' }),
        fields,
        canEdit: true,
        attachmentSummariesByField: {
          fld_a: [attachment('att_1', 'contract.pdf')],
          fld_b: [attachment('att_2', 'photo.png')],
        },
      })
      await flushUi()

      const groups = container.querySelectorAll('[data-test="attachments-panel-group"]')
      // Exactly 2 groups: the two attachment-type fields. The string field must NOT get a group.
      expect(groups).toHaveLength(2)
      expect(container.textContent).toContain('Contracts')
      expect(container.textContent).toContain('contract.pdf')
      expect(container.textContent).toContain('Photos')
      expect(container.textContent).toContain('photo.png')
      expect(container.textContent).not.toContain('Title')
    })

    it('panel-level empty state when there are no attachment-type fields at all', async () => {
      const container = mount({
        record: RECORD({}),
        fields: [{ id: 'fld_title', name: 'Title', type: 'string' }] as MetaField[],
        canEdit: true,
      })
      await flushUi()
      expect(container.querySelector('[data-test="attachments-panel-empty"]')).toBeTruthy()
      expect(container.querySelector('[data-test="attachments-panel-group"]')).toBeNull()
    })

    it('per-field empty state ("No attachments") when a visible attachment field has zero attachments', async () => {
      const container = mount({
        record: RECORD({}),
        fields: [{ id: 'fld_a', name: 'Contracts', type: 'attachment' }] as MetaField[],
        canEdit: true,
        attachmentSummariesByField: {},
      })
      await flushUi()
      const group = container.querySelector('[data-test="attachments-panel-group"]')!
      expect(group.textContent).toContain('No attachments')
    })
  })

  describe('mask contract (owner Medium-3): iteration source = layer-2 ∩ layer-3 visible attachment fields', () => {
    // Every case below populates `attachmentSummariesByField` for the MASKED field too -- exactly
    // mirroring the real server, which returns attachment summaries independent of the field mask.
    // If the component read `Object.keys(attachmentSummariesByField)` (or iterated `fields` unfiltered)
    // instead of the visible-intersect set, these would leak.
    const fields: MetaField[] = [
      { id: 'fld_secret', name: 'Secret Files', type: 'attachment', property: { hidden: true } },
      { id: 'fld_open', name: 'Open Files', type: 'attachment' },
    ]
    const summaries = {
      fld_secret: [attachment('att_secret', 'secret.pdf')],
      fld_open: [attachment('att_open', 'open.pdf')],
    }

    it('N1: a property-hidden (layer-2) attachment field does NOT render its attachments', async () => {
      const container = mount({
        record: RECORD({ fld_secret: ['att_secret'], fld_open: ['att_open'] }),
        fields,
        canEdit: true,
        attachmentSummariesByField: summaries,
        // No fieldPermissions entry at all -- layer-3 permits by default (visible !== false), so this
        // isolates layer-2 as the ONLY thing excluding fld_secret.
      })
      await flushUi()

      expect(container.textContent).not.toContain('secret.pdf')
      expect(container.textContent).not.toContain('Secret Files')
      const groups = container.querySelectorAll('[data-test="attachments-panel-group"]')
      expect(groups).toHaveLength(1)
      expect((groups[0] as HTMLElement).dataset.fieldId).toBe('fld_open')
    })

    it('N2: an RBAC-denied (layer-3) attachment field does NOT render its attachments', async () => {
      const fieldPermissions: Record<string, MetaFieldPermission> = {
        fld_secret: { visible: false, readOnly: false },
        fld_open: { visible: true, readOnly: false },
      }
      // Layer-2 is clean for BOTH fields here (neither has property.hidden) -- isolates layer-3 as the
      // ONLY thing excluding fld_secret in this case.
      const rbacFields: MetaField[] = [
        { id: 'fld_secret', name: 'Secret Files', type: 'attachment' },
        { id: 'fld_open', name: 'Open Files', type: 'attachment' },
      ]
      const container = mount({
        record: RECORD({ fld_secret: ['att_secret'], fld_open: ['att_open'] }),
        fields: rbacFields,
        canEdit: true,
        fieldPermissions,
        attachmentSummariesByField: summaries,
      })
      await flushUi()

      expect(container.textContent).not.toContain('secret.pdf')
      expect(container.textContent).not.toContain('Secret Files')
      const groups = container.querySelectorAll('[data-test="attachments-panel-group"]')
      expect(groups).toHaveLength(1)
      expect((groups[0] as HTMLElement).dataset.fieldId).toBe('fld_open')
    })

    it('positive control: the SAME field, made visible on both layers, DOES render (proves N1/N2 are not vacuous)', async () => {
      const visibleFields: MetaField[] = [
        { id: 'fld_secret', name: 'Secret Files', type: 'attachment' }, // no property.hidden now
      ]
      const fieldPermissions: Record<string, MetaFieldPermission> = {
        fld_secret: { visible: true, readOnly: false }, // and RBAC-visible now
      }
      const container = mount({
        record: RECORD({ fld_secret: ['att_secret'] }),
        fields: visibleFields,
        canEdit: true,
        fieldPermissions,
        attachmentSummariesByField: { fld_secret: summaries.fld_secret },
      })
      await flushUi()

      expect(container.textContent).toContain('secret.pdf')
      expect(container.textContent).toContain('Secret Files')
      expect(container.querySelectorAll('[data-test="attachments-panel-group"]')).toHaveLength(1)
    })
  })

  describe('edit gating', () => {
    it('canEdit=false: no file input and no remove button render', async () => {
      const container = mount({
        record: RECORD({ fld_a: ['att_1'] }),
        fields: [{ id: 'fld_a', name: 'Contracts', type: 'attachment' }] as MetaField[],
        canEdit: false,
        attachmentSummariesByField: { fld_a: [attachment('att_1', 'contract.pdf')] },
      })
      await flushUi()
      expect(container.querySelector('.meta-record-attachments-panel__file-input')).toBeNull()
      expect(container.querySelector('.meta-attachment-list__remove')).toBeNull()
    })

    it('a field with fieldPermissions.readOnly=true does not get a file input or remove button, even though canEdit=true', async () => {
      const container = mount({
        record: RECORD({ fld_a: ['att_1'] }),
        fields: [{ id: 'fld_a', name: 'Contracts', type: 'attachment' }] as MetaField[],
        canEdit: true,
        fieldPermissions: { fld_a: { visible: true, readOnly: true } } as Record<string, MetaFieldPermission>,
        attachmentSummariesByField: { fld_a: [attachment('att_1', 'contract.pdf')] },
      })
      await flushUi()
      expect(container.querySelector('.meta-record-attachments-panel__file-input')).toBeNull()
      expect(container.querySelector('.meta-attachment-list__remove')).toBeNull()
    })

    // B4 re-port (refs #4267 continuation): `isFieldAlwaysReadOnly` (apps/web/src/multitable/utils/
    // field-permissions.ts) is ADDITIVE to fieldPermissions[id].readOnly, same as the fields panel's
    // canEditField -- this pins the mirror-panel copy of that gate (see MetaRecordAttachmentsPanel.vue's
    // canEditField). Deliberately NO fieldPermissions prop, proving the gate is field-property-derived,
    // not solely dependent on a server-threaded permission map.
    it('a field with raw property.readonly=true does not get a file input or remove button, even with NO fieldPermissions supplied', async () => {
      const container = mount({
        record: RECORD({ fld_a: ['att_1'] }),
        fields: [{ id: 'fld_a', name: 'Contracts', type: 'attachment', property: { readonly: true } }] as MetaField[],
        canEdit: true,
        attachmentSummariesByField: { fld_a: [attachment('att_1', 'contract.pdf')] },
      })
      await flushUi()
      expect(container.querySelector('.meta-record-attachments-panel__file-input')).toBeNull()
      expect(container.querySelector('.meta-attachment-list__remove')).toBeNull()
    })

    it('negative leg: an ordinary attachment field with no special property stays editable (file input + remove button render)', async () => {
      const container = mount({
        record: RECORD({ fld_a: ['att_1'] }),
        fields: [{ id: 'fld_a', name: 'Contracts', type: 'attachment' }] as MetaField[],
        canEdit: true,
        attachmentSummariesByField: { fld_a: [attachment('att_1', 'contract.pdf')] },
      })
      await flushUi()
      expect(container.querySelector('.meta-record-attachments-panel__file-input')).not.toBeNull()
      expect(container.querySelector('.meta-attachment-list__remove')).not.toBeNull()
    })
  })

  describe('upload/delete emit parity via the reused component (MetaAttachmentList + uploadFn/deleteAttachmentFn)', () => {
    it('clicking remove calls deleteAttachmentFn then emits patch with the attachment id removed', async () => {
      const deleteAttachmentFn = vi.fn().mockResolvedValue(undefined)
      const onPatch = vi.fn()
      const container = mount({
        record: RECORD({ fld_a: ['att_1', 'att_2'] }),
        fields: [{ id: 'fld_a', name: 'Contracts', type: 'attachment' }] as MetaField[],
        canEdit: true,
        attachmentSummariesByField: {
          fld_a: [attachment('att_1', 'a.pdf'), attachment('att_2', 'b.pdf')],
        },
        deleteAttachmentFn,
        onPatch,
      })
      await flushUi()

      const removeButtons = container.querySelectorAll<HTMLButtonElement>('.meta-attachment-list__remove')
      expect(removeButtons).toHaveLength(2)
      removeButtons[0].click()
      await flushUi()

      expect(deleteAttachmentFn).toHaveBeenCalledWith('att_1', { recordId: 'rec_1', fieldId: 'fld_a' })
      // An attachment write names its record (the drawer can move to another one before it ends).
      expect(onPatch).toHaveBeenCalledWith('fld_a', ['att_2'], 'rec_1')
    })

    it('selecting a file calls uploadFn (the SAME fn the fields panel uses) then emits patch with the new id appended', async () => {
      const uploadFn = vi.fn().mockResolvedValue(attachment('att_new', 'new.pdf'))
      const onPatch = vi.fn()
      const container = mount({
        record: RECORD({ fld_a: ['att_1'] }),
        fields: [{ id: 'fld_a', name: 'Contracts', type: 'attachment' }] as MetaField[],
        canEdit: true,
        attachmentSummariesByField: { fld_a: [attachment('att_1', 'a.pdf')] },
        uploadFn,
        onPatch,
      })
      await flushUi()

      const input = container.querySelector('.meta-record-attachments-panel__file-input') as HTMLInputElement
      expect(input).not.toBeNull()
      const file = new File(['x'], 'new.pdf', { type: 'application/pdf' })
      Object.defineProperty(input, 'files', {
        value: {
          0: file,
          length: 1,
          item: (index: number) => (index === 0 ? file : null),
          [Symbol.iterator]: function* iterator() { yield file },
        },
        configurable: true,
      })
      input.dispatchEvent(new Event('change'))
      await flushUi()

      expect(uploadFn).toHaveBeenCalledWith(file, { recordId: 'rec_1', fieldId: 'fld_a' })
      expect(onPatch).toHaveBeenCalledWith('fld_a', ['att_1', 'att_new'], 'rec_1', undefined, ['att_new'])
    })

    // An upload that adds to the list names the ids it added (the fifth argument above): the listener adds them to
    // the record's list as it is then. One that replaces the list (a single-file field that holds a file) names
    // none: its value is the new list as it is.
    it('an upload that replaces the single file of a one-file field emits the new list alone, naming no added ids', async () => {
      const uploadFn = vi.fn().mockResolvedValue(attachment('att_new', 'new.pdf'))
      const onPatch = vi.fn()
      const container = mount({
        record: RECORD({ fld_a: ['att_1'] }),
        fields: [{ id: 'fld_a', name: 'Contract', type: 'attachment', property: { maxFiles: 1 } }] as MetaField[],
        canEdit: true,
        attachmentSummariesByField: { fld_a: [attachment('att_1', 'a.pdf')] },
        uploadFn,
        onPatch,
      })
      await flushUi()

      const input = container.querySelector('.meta-record-attachments-panel__file-input') as HTMLInputElement
      const file = new File(['x'], 'new.pdf', { type: 'application/pdf' })
      Object.defineProperty(input, 'files', {
        value: {
          0: file,
          length: 1,
          item: (index: number) => (index === 0 ? file : null),
          [Symbol.iterator]: function* iterator() { yield file },
        },
        configurable: true,
      })
      input.dispatchEvent(new Event('change'))
      await flushUi()

      expect(onPatch.mock.calls).toEqual([['fld_a', ['att_new'], 'rec_1']])
    })
  })

  // The drawer can move to another record while an upload or a delete still runs. The write, its patch
  // and every later file belong to the record it started on (rec_A). The panel's own activity, error and
  // local summaries are the shown record's (rec_B), so A's late result leaves them alone.
  describe('record switch while an upload or a delete runs', () => {
    const FIELDS = [{ id: 'fld_a', name: 'Contracts', type: 'attachment' }] as MetaField[]
    const REC_A: MetaRecord = { id: 'rec_A', version: 1, data: { fld_a: ['att_a1'] } }
    const REC_B: MetaRecord = { id: 'rec_B', version: 1, data: { fld_a: ['att_b1'] } }
    const SUMMARIES = { fld_a: [attachment('att_a1', 'a1.pdf'), attachment('att_b1', 'b1.pdf')] }

    function deferred<T>() {
      let resolve!: (value: T) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
      return { promise, resolve, reject }
    }

    function fileInput(container: HTMLElement): HTMLInputElement {
      return container.querySelector('.meta-record-attachments-panel__file-input') as HTMLInputElement
    }

    function pickFiles(input: HTMLInputElement, names: string[]): File[] {
      const files = names.map((name) => new File(['x'], name, { type: 'application/pdf' }))
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

    function mountA(extra: Record<string, unknown> = {}) {
      const onPatch = vi.fn()
      const harness = mountReactive({
        record: REC_A,
        fields: FIELDS,
        canEdit: true,
        attachmentSummariesByField: SUMMARIES,
        onPatch,
        ...extra,
      })
      return { ...harness, onPatch }
    }

    it('an upload that ends after the switch to rec_B patches rec_A: A\'s list plus the new id, with rec_A', async () => {
      const upload = deferred<MetaAttachment>()
      const uploadFn = vi.fn(() => upload.promise)
      const { container, set, onPatch } = mountA({ uploadFn })
      await flushUi()
      pickFiles(fileInput(container), ['new.pdf'])
      await flushUi()
      set({ record: REC_B })
      await flushUi()
      upload.resolve(attachment('att_new', 'new.pdf'))
      await flushUi()

      expect(uploadFn).toHaveBeenCalledWith(expect.any(File), { recordId: 'rec_A', fieldId: 'fld_a' })
      expect(onPatch).toHaveBeenCalledTimes(1)
      expect(onPatch.mock.calls[0]).toEqual(['fld_a', ['att_a1', 'att_new'], 'rec_A', undefined, ['att_new']])
    })

    it('two files with a switch after the first: the second upload is still made on rec_A', async () => {
      const first = deferred<MetaAttachment>()
      const second = deferred<MetaAttachment>()
      const uploadFn = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      const { container, set, onPatch } = mountA({ uploadFn })
      await flushUi()
      pickFiles(fileInput(container), ['one.pdf', 'two.pdf'])
      await flushUi()
      expect(uploadFn).toHaveBeenCalledTimes(1)
      set({ record: REC_B })
      await flushUi()
      first.resolve(attachment('att_n1', 'one.pdf'))
      await flushUi()

      expect(uploadFn).toHaveBeenCalledTimes(2)
      expect(uploadFn.mock.calls[1][1]).toEqual({ recordId: 'rec_A', fieldId: 'fld_a' })
      second.resolve(attachment('att_n2', 'two.pdf'))
      await flushUi()
      expect(onPatch.mock.calls).toEqual([['fld_a', ['att_a1', 'att_n1', 'att_n2'], 'rec_A', undefined, ['att_n1', 'att_n2']]])
    })

    it('a remove that ends after the switch patches rec_A with the list it started from, minus the id (not rec_B\'s list)', async () => {
      const removal = deferred<void>()
      const deleteAttachmentFn = vi.fn(() => removal.promise)
      const { container, set, onPatch } = mountA({
        record: { id: 'rec_A', version: 1, data: { fld_a: ['att_a1', 'att_a2'] } },
        attachmentSummariesByField: { fld_a: [attachment('att_a1', 'a1.pdf'), attachment('att_a2', 'a2.pdf')] },
        deleteAttachmentFn,
      })
      await flushUi()
      container.querySelectorAll<HTMLButtonElement>('.meta-attachment-list__remove')[0].click()
      await flushUi()
      set({ record: REC_B })
      await flushUi()
      removal.resolve()
      await flushUi()

      expect(deleteAttachmentFn).toHaveBeenCalledWith('att_a1', { recordId: 'rec_A', fieldId: 'fld_a' })
      // The removed id goes with it: the workbench takes it out of rec_A's list as it is now.
      expect(onPatch.mock.calls).toEqual([['fld_a', ['att_a2'], 'rec_A', ['att_a1']]])
    })

    it('remove, same record: the current list wins over the one it started from', async () => {
      const removal = deferred<void>()
      const { container, set, onPatch } = mountA({
        record: { id: 'rec_A', version: 1, data: { fld_a: ['att_a1', 'att_a2'] } },
        attachmentSummariesByField: { fld_a: [attachment('att_a1', 'a1.pdf'), attachment('att_a2', 'a2.pdf')] },
        deleteAttachmentFn: vi.fn(() => removal.promise),
      })
      await flushUi()
      container.querySelectorAll<HTMLButtonElement>('.meta-attachment-list__remove')[0].click()
      await flushUi()
      // A reload during the delete brings a third file onto the same record.
      set({ record: { id: 'rec_A', version: 2, data: { fld_a: ['att_a1', 'att_a2', 'att_a3'] } } })
      await flushUi()
      removal.resolve()
      await flushUi()

      // Still shown: three arguments, no removed ids.
      expect(onPatch.mock.calls).toEqual([['fld_a', ['att_a2', 'att_a3'], 'rec_A']])
    })

    it('A\'s late upload does not end rec_B\'s own upload activity (B\'s input stays disabled until B\'s upload ends)', async () => {
      const uploadA = deferred<MetaAttachment>()
      const uploadB = deferred<MetaAttachment>()
      const uploadFn = vi.fn().mockReturnValueOnce(uploadA.promise).mockReturnValueOnce(uploadB.promise)
      const { container, set, onPatch } = mountA({ uploadFn })
      await flushUi()
      pickFiles(fileInput(container), ['a.pdf'])
      await flushUi()
      set({ record: REC_B })
      await flushUi()
      // the switch cleared the activity, so B can start its own upload on the same input
      expect(fileInput(container).disabled).toBe(false)
      pickFiles(fileInput(container), ['b.pdf'])
      await flushUi()
      expect(uploadFn.mock.calls[1][1]).toEqual({ recordId: 'rec_B', fieldId: 'fld_a' })

      uploadA.resolve(attachment('att_na', 'a.pdf'))
      await flushUi()
      expect(fileInput(container).disabled).toBe(true)
      expect(container.querySelector('.meta-record-attachments-panel__uploading')).not.toBeNull()
      expect(onPatch.mock.calls).toEqual([['fld_a', ['att_a1', 'att_na'], 'rec_A', undefined, ['att_na']]])

      // control: B's own result does end it
      uploadB.resolve(attachment('att_nb', 'b.pdf'))
      await flushUi()
      expect(fileInput(container).disabled).toBe(false)
      expect(container.querySelector('.meta-record-attachments-panel__uploading')).toBeNull()
      expect(onPatch.mock.calls[1]).toEqual(['fld_a', ['att_b1', 'att_nb'], 'rec_B', undefined, ['att_nb']])
    })

    it('A\'s late upload failure writes no error on rec_B and patches nothing', async () => {
      const upload = deferred<MetaAttachment>()
      const { container, set, onPatch } = mountA({ uploadFn: vi.fn(() => upload.promise) })
      await flushUi()
      pickFiles(fileInput(container), ['a.pdf'])
      await flushUi()
      set({ record: REC_B })
      await flushUi()
      upload.reject(new Error('storage quota exceeded'))
      await flushUi()

      expect(container.querySelector('.meta-record-attachments-panel__error')).toBeNull()
      expect(onPatch).not.toHaveBeenCalled()
    })

    it('A\'s late upload does not add its summary to rec_B (B shows its own fallback for the same id)', async () => {
      const upload = deferred<MetaAttachment>()
      const { container, set } = mountA({ uploadFn: vi.fn(() => upload.promise) })
      await flushUi()
      pickFiles(fileInput(container), ['new.pdf'])
      await flushUi()
      // rec_B holds an attachment with the same id that has no summary in this panel
      set({ record: { id: 'rec_B', version: 1, data: { fld_a: ['att_new'] } } })
      await flushUi()
      upload.resolve(attachment('att_new', 'new.pdf'))
      await flushUi()

      const group = container.querySelector('[data-test="attachments-panel-group"]')!
      expect(group.textContent).toContain('att_new')
      expect(group.textContent).not.toContain('new.pdf')
    })

    it('A\'s late delete failure writes no error on rec_B and does not end B\'s upload activity', async () => {
      const removal = deferred<void>()
      const uploadB = deferred<MetaAttachment>()
      const { container, set, onPatch } = mountA({
        deleteAttachmentFn: vi.fn(() => removal.promise),
        uploadFn: vi.fn(() => uploadB.promise),
      })
      await flushUi()
      container.querySelector<HTMLButtonElement>('.meta-attachment-list__remove')!.click()
      await flushUi()
      set({ record: REC_B })
      await flushUi()
      pickFiles(fileInput(container), ['b.pdf'])
      await flushUi()
      removal.reject(new Error('delete refused'))
      await flushUi()

      expect(container.querySelector('.meta-record-attachments-panel__error')).toBeNull()
      expect(fileInput(container).disabled).toBe(true)
      expect(container.querySelector('.meta-record-attachments-panel__uploading')).not.toBeNull()
      expect(onPatch).not.toHaveBeenCalled()
    })

    it('A\'s remove that ends after the switch does not end B\'s upload activity', async () => {
      const removal = deferred<void>()
      const uploadB = deferred<MetaAttachment>()
      const { container, set, onPatch } = mountA({
        deleteAttachmentFn: vi.fn(() => removal.promise),
        uploadFn: vi.fn(() => uploadB.promise),
      })
      await flushUi()
      container.querySelector<HTMLButtonElement>('.meta-attachment-list__remove')!.click()
      await flushUi()
      set({ record: REC_B })
      await flushUi()
      pickFiles(fileInput(container), ['b.pdf'])
      await flushUi()
      removal.resolve()
      await flushUi()

      // B's upload is still running: its input stays disabled and its uploading text stays.
      expect(fileInput(container).disabled).toBe(true)
      expect(container.querySelector('.meta-record-attachments-panel__uploading')).not.toBeNull()
      expect(container.querySelector('.meta-record-attachments-panel__error')).toBeNull()
      expect(onPatch.mock.calls).toEqual([['fld_a', [], 'rec_A', ['att_a1']]])
    })

    it('control, same record: a successful upload ends the activity and patches rec_A', async () => {
      const upload = deferred<MetaAttachment>()
      const { container, onPatch } = mountA({ uploadFn: vi.fn(() => upload.promise) })
      await flushUi()
      pickFiles(fileInput(container), ['new.pdf'])
      await flushUi()
      expect(fileInput(container).disabled).toBe(true)
      expect(container.querySelector('.meta-record-attachments-panel__uploading')).not.toBeNull()
      upload.resolve(attachment('att_new', 'new.pdf'))
      await flushUi()

      expect(fileInput(container).disabled).toBe(false)
      expect(container.querySelector('.meta-record-attachments-panel__uploading')).toBeNull()
      expect(onPatch.mock.calls).toEqual([['fld_a', ['att_a1', 'att_new'], 'rec_A', undefined, ['att_new']]])
    })

    it('control, same record: a failed upload or delete shows its error', async () => {
      const upload = deferred<MetaAttachment>()
      const removal = deferred<void>()
      const { container, onPatch } = mountA({
        uploadFn: vi.fn(() => upload.promise),
        deleteAttachmentFn: vi.fn(() => removal.promise),
      })
      await flushUi()
      pickFiles(fileInput(container), ['a.pdf'])
      await flushUi()
      upload.reject(new Error('storage quota exceeded'))
      await flushUi()
      expect(container.querySelector('.meta-record-attachments-panel__error')?.textContent).toContain('storage quota exceeded')
      expect(fileInput(container).disabled).toBe(false)

      container.querySelector<HTMLButtonElement>('.meta-attachment-list__remove')!.click()
      await flushUi()
      removal.reject(new Error('delete refused'))
      await flushUi()
      expect(container.querySelector('.meta-record-attachments-panel__error')?.textContent).toContain('delete refused')
      expect(onPatch).not.toHaveBeenCalled()
    })

    it('control, same record id in a new object (a re-read during the upload): the patch still goes to rec_A', async () => {
      const upload = deferred<MetaAttachment>()
      const { container, set, onPatch } = mountA({ uploadFn: vi.fn(() => upload.promise) })
      await flushUi()
      pickFiles(fileInput(container), ['new.pdf'])
      await flushUi()
      set({ record: { id: 'rec_A', version: 2, data: { fld_a: ['att_a1'] } } })
      await flushUi()
      upload.resolve(attachment('att_new', 'new.pdf'))
      await flushUi()

      expect(onPatch.mock.calls).toEqual([['fld_a', ['att_a1', 'att_new'], 'rec_A', undefined, ['att_new']]])
    })
  })

  describe('HI-1: zero new data paths', () => {
    it('source scan: no client./fetch(/api. call appears anywhere in this component', () => {
      const src = readSrc('src/multitable/components/MetaRecordAttachmentsPanel.vue')
      expect(src).not.toMatch(/[^.]\bfetch\(/)
      expect(src).not.toMatch(/(?<!api)client\.\w+\(/)
      expect(src).not.toMatch(/\bapiClient\.\w+\(/)
    })

    it('positive control: the source-scan regexes actually fire on a constructed violation (proves the guard is not vacuous)', () => {
      const fixtureWithFetch = "const x = fetch('/api/multitable/attachments')"
      const fixtureWithClient = 'await client.listAttachments(fieldId)'
      const fixtureWithApiClient = 'await apiClient.listAttachments(fieldId)'
      expect(fixtureWithFetch).toMatch(/[^.]\bfetch\(/)
      expect(fixtureWithClient).toMatch(/(?<!api)client\.\w+\(/)
      expect(fixtureWithApiClient).toMatch(/\bapiClient\.\w+\(/)
    })

    it('fetch-monkeypatch: a full mount + interact pass (render/upload/remove) never touches global fetch', async () => {
      const originalFetch = globalThis.fetch
      const fetchSpy = vi.fn(originalFetch as typeof fetch)
      globalThis.fetch = fetchSpy as typeof fetch
      try {
        const uploadFn = vi.fn().mockResolvedValue(attachment('att_new', 'new.pdf'))
        const deleteAttachmentFn = vi.fn().mockResolvedValue(undefined)
        const container = mount({
          record: RECORD({ fld_a: ['att_1'] }),
          fields: [{ id: 'fld_a', name: 'Contracts', type: 'attachment' }] as MetaField[],
          canEdit: true,
          attachmentSummariesByField: { fld_a: [attachment('att_1', 'a.pdf')] },
          uploadFn,
          deleteAttachmentFn,
        })
        await flushUi()

        const removeButton = container.querySelector<HTMLButtonElement>('.meta-attachment-list__remove')!
        removeButton.click()
        await flushUi()

        const input = container.querySelector('.meta-record-attachments-panel__file-input') as HTMLInputElement
        const file = new File(['x'], 'new.pdf', { type: 'application/pdf' })
        Object.defineProperty(input, 'files', {
          value: {
            0: file,
            length: 1,
            item: (index: number) => (index === 0 ? file : null),
            [Symbol.iterator]: function* iterator() { yield file },
          },
          configurable: true,
        })
        input.dispatchEvent(new Event('change'))
        await flushUi()

        expect(fetchSpy).not.toHaveBeenCalled()
        expect(uploadFn).toHaveBeenCalled()
        expect(deleteAttachmentFn).toHaveBeenCalled()
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })
})
