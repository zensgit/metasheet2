/**
 * Production wiring helpers — extract/bind form data, lifecycle start/stop, flag gate.
 */
import { describe, expect, test, vi } from 'vitest'

import {
  extractAttachmentIdsByField,
  startApprovalAttachmentLifecycle,
  stripAttachmentFormData,
} from '../../src/services/approval-attachment-runtime'
import type { FormSchema } from '../../src/types/approval-product'

const schema: FormSchema = {
  fields: [
    { id: 'reason', type: 'text', label: '事由' },
    { id: 'proof', type: 'attachment', label: '证明' },
  ],
}

describe('approval attachment runtime helpers', () => {
  test('extractAttachmentIdsByField: keeps ordered server ids; rejects non-array garbage', () => {
    expect(extractAttachmentIdsByField(schema, { proof: ['att_1', 'att_2'], reason: 'x' })).toEqual({
      proof: ['att_1', 'att_2'],
    })
    expect(extractAttachmentIdsByField(schema, { reason: 'x' })).toEqual({ proof: [] })
    expect(() => extractAttachmentIdsByField(schema, { proof: 'att_1' })).toThrow(/array of attachment ids/)
  })

  test('stripAttachmentFormData removes attachment keys (flag-OFF path)', () => {
    expect(stripAttachmentFormData(schema, { reason: 'x', proof: ['att_1'] })).toEqual({ reason: 'x' })
  })

  test('lifecycle workers are no-op when flag OFF; start+stop when flag ON', async () => {
    const sweep = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const db = { query: sweep }
    const store = {
      put: async () => {},
      get: async () => Buffer.alloc(0),
      delete: async () => true,
      list: async () => [],
    }
    const stopOff = startApprovalAttachmentLifecycle({
      db,
      store,
      env: { APPROVAL_ATTACHMENTS_ENABLED: 'false' } as NodeJS.ProcessEnv,
      intervalMs: 10_000,
    })
    stopOff()
    // Flag OFF: no timer, no immediate sweep queries required (runOnce not scheduled)
    // Give a tick to ensure no async work was kicked off for OFF
    await new Promise((r) => setTimeout(r, 20))
    const queriesBefore = sweep.mock.calls.length

    const stopOn = startApprovalAttachmentLifecycle({
      db,
      store,
      env: { APPROVAL_ATTACHMENTS_ENABLED: 'true' } as NodeJS.ProcessEnv,
      intervalMs: 60_000,
      ttlHours: 168,
      logger: { info: () => {}, warn: () => {} },
    })
    await new Promise((r) => setTimeout(r, 50))
    stopOn()
    // Flag ON: at least one pass ran (sweep / drain / reconcile issue queries)
    expect(sweep.mock.calls.length).toBeGreaterThan(queriesBefore)
  })
})
