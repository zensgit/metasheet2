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
import { createApp, h, nextTick, type App } from 'vue'
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
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaRecordAttachmentsPanel, props) })
  app.mount(container)
  mounts.push({ app, container })
  return container
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
      expect(onPatch).toHaveBeenCalledWith('fld_a', ['att_2'])
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
      expect(onPatch).toHaveBeenCalledWith('fld_a', ['att_1', 'att_new'])
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
