import { describe, expect, it } from 'vitest'

import {
  clearFormDraft,
  formDraftKey,
  formSchemaSignature,
  loadFormDraft,
  saveFormDraft,
} from '../src/approvals/formDraft'
import type { FormSchema } from '../src/types/approval'

// G-B2-14 — draft autosave helpers: per-user+template keying, schema-drift fail-safe,
// attachment exclusion from the signature, empty-draft GC, corrupted-storage tolerance.

function fakeStorage(): Storage & { dump: () => Record<string, string> } {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size
    },
    dump: () => Object.fromEntries(map),
  } as never
}

const SCHEMA: FormSchema = {
  fields: [
    { id: 'amount', type: 'number', label: '金额' },
    { id: 'reason', type: 'text', label: '事由' },
    { id: 'files', type: 'attachment', label: '附件' },
  ],
} as FormSchema

describe('formDraft helpers', () => {
  it('keys drafts per user+template', () => {
    expect(formDraftKey('u1', 't1')).not.toBe(formDraftKey('u1', 't2'))
    expect(formDraftKey('u1', 't1')).not.toBe(formDraftKey('u2', 't1'))
  })

  it('signature excludes attachment fields and is order-independent', () => {
    const reordered = { fields: [...SCHEMA.fields].reverse() } as FormSchema
    expect(formSchemaSignature(SCHEMA)).toBe(formSchemaSignature(reordered))
    expect(formSchemaSignature(SCHEMA)).not.toContain('attachment')
  })

  it('save→load round-trips under the same signature', () => {
    const storage = fakeStorage()
    const key = formDraftKey('u1', 't1')
    const sig = formSchemaSignature(SCHEMA)
    saveFormDraft(storage, key, sig, { amount: 12, reason: '出差' })
    expect(loadFormDraft(storage, key, sig)).toEqual({ amount: 12, reason: '出差' })
  })

  it('SCHEMA DRIFT fail-safe: signature mismatch → null AND the stale draft is GC-ed', () => {
    const storage = fakeStorage()
    const key = formDraftKey('u1', 't1')
    saveFormDraft(storage, key, 'old-signature', { amount: 12 })
    expect(loadFormDraft(storage, key, 'new-signature')).toBeNull()
    expect(storage.getItem(key)).toBeNull() // removed, not left to rot
  })

  it('empty-ish data clears instead of saving (untouched form leaves no residue)', () => {
    const storage = fakeStorage()
    const key = formDraftKey('u1', 't1')
    const sig = formSchemaSignature(SCHEMA)
    saveFormDraft(storage, key, sig, { amount: 1 })
    saveFormDraft(storage, key, sig, { amount: undefined, reason: '', list: [] })
    expect(storage.getItem(key)).toBeNull()
  })

  it('corrupted JSON / throwing storage never throws out of the helpers', () => {
    const storage = fakeStorage()
    const key = formDraftKey('u1', 't1')
    storage.setItem(key, '{not json')
    expect(loadFormDraft(storage, key, 'sig')).toBeNull()
    const bomb = {
      getItem: () => {
        throw new Error('quota')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('quota')
      },
    } as never
    expect(() => saveFormDraft(bomb, key, 'sig', { a: 1 })).not.toThrow()
    expect(loadFormDraft(bomb, key, 'sig')).toBeNull()
    expect(() => clearFormDraft(bomb, key)).not.toThrow()
  })
})
