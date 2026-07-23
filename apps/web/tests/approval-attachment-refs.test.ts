/**
 * B3-07 §8 (#4195) — frozen-reference resolution, tombstones, redaction inheritance and the G13
 * stale-draft detection. Pure module (no Element Plus, no Vue) so desktop and mobile provably render
 * through the SAME helper and cannot drift.
 */
import { describe, expect, it } from 'vitest'

import {
  collectAttachmentRefIds,
  dropStaleAttachmentRefs,
  formatAttachmentSize,
  resolveAttachmentFields,
  type AttachmentRefMetadata,
} from '../src/approvals/attachmentRefs'

const schema = {
  fields: [
    { id: 'reason', type: 'text', label: '事由' },
    { id: 'files', type: 'attachment', label: '附件' },
    { id: 'more', type: 'attachment', label: '补充材料' },
  ],
} as const

describe('collectAttachmentRefIds', () => {
  it('collects ids from attachment fields only, in schema then array order, de-duplicated', () => {
    const snapshot = { reason: 'not-an-id', files: ['a', 'b', 'a'], more: ['c'] }
    expect(collectAttachmentRefIds(schema, snapshot)).toEqual(['a', 'b', 'c'])
  })

  it('a malformed value contributes NOTHING rather than a coerced bogus id', () => {
    // negative controls: a non-array, a nested object, blanks and non-strings are all ignored
    expect(collectAttachmentRefIds(schema, { files: 'att_1' })).toEqual([])
    expect(collectAttachmentRefIds(schema, { files: [{ id: 'x' }, null, 42, '', '  '] })).toEqual([])
    expect(collectAttachmentRefIds(schema, null)).toEqual([])
    expect(collectAttachmentRefIds(null, { files: ['a'] })).toEqual([])
  })
})

describe('resolveAttachmentFields', () => {
  const meta: AttachmentRefMetadata[] = [
    { id: 'a', tombstone: false, fileName: 'contract.pdf', sizeBytes: 2048, downloadUrl: '/api/approval/attachments/a/download' },
  ]

  it('resolves a live ref to name + size + the proxied download url', () => {
    const out = resolveAttachmentFields(schema, { files: ['a'] }, meta)
    expect(out).toEqual([
      {
        fieldId: 'files',
        label: '附件',
        refs: [{ id: 'a', tombstone: false, fileName: 'contract.pdf', sizeBytes: 2048, downloadUrl: '/api/approval/attachments/a/download' }],
      },
    ])
  })

  it('a server-declared tombstone renders as a tombstone with NO fabricated name/size/link', () => {
    const out = resolveAttachmentFields(schema, { files: ['gone'] }, [{ id: 'gone', tombstone: true }])
    expect(out[0].refs).toEqual([{ id: 'gone', tombstone: true }])
    // the id is never dressed up as a filename
    expect(JSON.stringify(out)).not.toContain('fileName')
  })

  it('resolved-but-nameless metadata is a tombstone too (never invent a name from the id)', () => {
    const out = resolveAttachmentFields(schema, { files: ['a'] }, [{ id: 'a', tombstone: false }])
    expect(out[0].refs).toEqual([{ id: 'a', tombstone: true }])
  })

  it('an id the server OMITTED (hidden at the active node) renders as NOTHING — not a tombstone', () => {
    // G7 redaction inheritance: a tombstone would disclose that a hidden field has an attachment.
    const out = resolveAttachmentFields(schema, { files: ['hidden_one'] }, [])
    expect(out).toEqual([])
  })

  it('mixed field: hidden refs vanish while sibling live refs still render (positive control)', () => {
    const out = resolveAttachmentFields(schema, { files: ['a', 'hidden_one'] }, meta)
    expect(out[0].refs.map((r) => r.id)).toEqual(['a'])
  })

  it('rejects a non-proxied download url (a raw storage url is never rendered)', () => {
    const evil: AttachmentRefMetadata[] = [
      { id: 'a', tombstone: false, fileName: 'x.pdf', downloadUrl: 'https://bucket.example.com/raw/key.pdf' },
    ]
    const out = resolveAttachmentFields(schema, { files: ['a'] }, evil)
    expect(out[0].refs[0].downloadUrl).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain('bucket.example.com')
  })

  it('resolves BY THE FROZEN ID: extra server metadata for an unreferenced id is never rendered', () => {
    const out = resolveAttachmentFields(schema, { files: ['a'] }, [
      ...meta,
      { id: 'not_in_snapshot', tombstone: false, fileName: 'sneaky.pdf', downloadUrl: '/api/approval/attachments/not_in_snapshot/download' },
    ])
    expect(out[0].refs.map((r) => r.id)).toEqual(['a'])
    expect(JSON.stringify(out)).not.toContain('sneaky.pdf')
  })

  it('preserves the frozen array ORDER and keeps per-field grouping', () => {
    const many: AttachmentRefMetadata[] = ['x', 'y', 'z'].map((id) => ({
      id,
      tombstone: false,
      fileName: `${id}.pdf`,
      downloadUrl: `/api/approval/attachments/${id}/download`,
    }))
    const out = resolveAttachmentFields(schema, { files: ['z', 'x'], more: ['y'] }, many)
    expect(out.map((g) => g.fieldId)).toEqual(['files', 'more'])
    expect(out[0].refs.map((r) => r.id)).toEqual(['z', 'x'])
    expect(out[1].refs.map((r) => r.id)).toEqual(['y'])
  })
})

describe('formatAttachmentSize', () => {
  it('formats bytes/KB/MB and renders nothing for an absent or nonsense size', () => {
    expect(formatAttachmentSize(512)).toBe('512 B')
    expect(formatAttachmentSize(2048)).toBe('2.0 KB')
    expect(formatAttachmentSize(5 * 1024 * 1024)).toBe('5.0 MB')
    // never fabricate a size the server did not give us
    expect(formatAttachmentSize(undefined)).toBe('')
    expect(formatAttachmentSize(Number.NaN)).toBe('')
    expect(formatAttachmentSize(-1)).toBe('')
  })
})

describe('dropStaleAttachmentRefs (G13 / O2)', () => {
  it('drops swept ids and reports them; keeps the still-live ones (positive control)', () => {
    const draft = { reason: '出差', files: ['live', 'swept'], more: ['also_live'] }
    const scan = dropStaleAttachmentRefs(schema, draft, ['swept'])
    expect(scan.data.files).toEqual(['live'])
    expect(scan.data.more).toEqual(['also_live'])
    expect(scan.data.reason).toBe('出差') // non-attachment data untouched
    expect(scan.staleIds).toEqual(['swept'])
  })

  it('reports NOTHING stale when every ref is live (the detector is not a blanket dropper)', () => {
    const scan = dropStaleAttachmentRefs(schema, { files: ['a', 'b'] }, [])
    expect(scan.data.files).toEqual(['a', 'b'])
    expect(scan.staleIds).toEqual([])
  })

  it('a dangling id is NEVER silently kept — every stale id is removed, not just flagged', () => {
    const scan = dropStaleAttachmentRefs(schema, { files: ['s1', 's2'] }, ['s1', 's2'])
    expect(scan.data.files).toEqual([])
    expect(scan.staleIds).toEqual(['s1', 's2'])
  })

  it('a malformed persisted value is replaced with an empty array, never carried into a submission', () => {
    const scan = dropStaleAttachmentRefs(schema, { files: 'att_1' as unknown as string[] }, [])
    expect(scan.data.files).toEqual([])
  })

  it('does not mutate the caller draft', () => {
    const draft = { files: ['live', 'swept'] }
    dropStaleAttachmentRefs(schema, draft, ['swept'])
    expect(draft.files).toEqual(['live', 'swept'])
  })
})
