import { describe, expect, it, vi } from 'vitest'
import { readRecoveryArchiveCaptureSource, readRecoveryArchiveRelationalSource } from '../../src/multitable/recovery-archive-relational-source'

const scope = { workspaceId: 'workspace', baseId: 'base', sheetId: 'sheet' }
const code = 'RECOVERY_ARCHIVE_RELATIONAL_SOURCE_UNAVAILABLE'
function sections() {
  return {
    schema: [{ field_id: 'f', name: 'Synthetic', type: 'string', property: {}, order: 1 }],
    records: [{ record_id: 'r', exists: true, version: 1, data: { f: 'value' } }],
    links: [], field_value_tombstones: [], link_tombstones: [], auto_number: [], views_config: [],
  }
}

describe('manual archive relational source projection', () => {
  it('uses one statement and server scope, without fabricating attachment/permission evidence', async () => {
    const input = sections()
    const query = vi.fn().mockResolvedValue({ rows: [{ sections: input, attachment_candidates: [] }] })
    const result = await readRecoveryArchiveRelationalSource(query, scope)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][1]).toEqual(['sheet', 'base', 'workspace'])
    expect(query.mock.calls[0][0]).toMatch(
      /WHERE s\.id = \$1 AND s\.base_id = \$2 AND b\.workspace_id = \$3\s+AND s\.deleted_at IS NULL AND b\.deleted_at IS NULL\s*\), fields AS/,
    )
    expect(result).toEqual(input)
    expect(Object.keys(result)).toHaveLength(7)
    input.records[0].data.f = 'changed'
    expect(result.records).toEqual([{ record_id: 'r', exists: true, version: 1, data: { f: 'value' } }])
  })

  it('accepts a proven empty live scope, not a missing scope', async () => {
    const empty = Object.fromEntries(Object.keys(sections()).map((key) => [key, []]))
    await expect(readRecoveryArchiveRelationalSource(
      vi.fn().mockResolvedValue({ rows: [{ sections: empty, attachment_candidates: [] }] }), scope,
    )).resolves.toEqual(empty)
    await expect(readRecoveryArchiveRelationalSource(
      vi.fn().mockResolvedValue({ rows: [] }), scope,
    )).rejects.toMatchObject({ code })
  })

  it.each(Object.keys(sections()))('rejects missing section %s', async (section) => {
    const partial: Record<string, unknown> = sections()
    delete partial[section]
    await expect(readRecoveryArchiveRelationalSource(
      vi.fn().mockResolvedValue({ rows: [{ sections: partial, attachment_candidates: [] }] }), scope,
    )).rejects.toMatchObject({ code })
  })

  it('rejects extra sections and malformed canonical rows', async () => {
    for (const malformed of [
      { ...sections(), attachments_index: [] },
      { ...sections(), records: [{ record_id: 'r', exists: true, version: 1, data: null }] },
      { ...sections(), schema: [...sections().schema, ...sections().schema] },
      { ...sections(), auto_number: [{ field_id: 'f', next_value: 2 }] },
    ]) {
      await expect(readRecoveryArchiveRelationalSource(
        vi.fn().mockResolvedValue({ rows: [{ sections: malformed, attachment_candidates: [] }] }), scope,
      )).rejects.toMatchObject({ code })
    }
  })

  it('refuses cross-schema links and sequences instead of omitting them', async () => {
    for (const malformed of [
      { ...sections(), links: [{ link_id: 'l', field_id: 'other', record_id: 'r', foreign_record_id: 'foreign' }] },
      { ...sections(), auto_number: [{ field_id: 'other', next_value: '2' }] },
    ]) {
      await expect(readRecoveryArchiveRelationalSource(
        vi.fn().mockResolvedValue({ rows: [{ sections: malformed, attachment_candidates: [] }] }), scope,
      )).rejects.toMatchObject({ code })
    }
  })

  it('rejects invalid scope before IO and contains hostile provider errors', async () => {
    const query = vi.fn().mockRejectedValue(new Error('private-source-value'))
    await expect(readRecoveryArchiveRelationalSource(query, { ...scope, sheetId: ' ' }))
      .rejects.toMatchObject({ code })
    expect(query).not.toHaveBeenCalled()
    await expect(readRecoveryArchiveRelationalSource(query, scope)).rejects.toMatchObject({ message: code })
  })

  const attachment = {
    attachmentId: 'a', recordId: 'r', fieldId: 'f', storageFileId: 'object',
    storagePath: 'internal-only', storageProvider: 'local', sizeBytes: '9007199254740993',
    mediaType: 'application/octet-stream', deleted: false, blobPurged: false,
  }
  it('captures all attachment states in the same statement without asserting object verification', async () => {
    const candidate = { ...attachment }
    const query = vi.fn().mockResolvedValue({ rows: [{ sections: sections(), attachment_candidates: [
      { ...attachment, attachmentId: 'z', recordId: null, fieldId: null, deleted: true, blobPurged: true }, candidate,
    ] }] })
    const result = await readRecoveryArchiveCaptureSource(query, scope)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toMatch(/FROM public\.multitable_attachments a JOIN scope s ON s\.id = a\.sheet_id\), '\[\]'::jsonb\)/)
    expect(result.attachmentCandidates).toEqual([attachment, { ...attachment, attachmentId: 'z', recordId: null, fieldId: null, deleted: true, blobPurged: true }])
    candidate.storagePath = 'changed'
    expect(result.attachmentCandidates[0].storagePath).toBe('internal-only')
    expect(Object.keys(result.sections)).not.toContain('attachments_index')
  })
  it.each([
    undefined, null, {}, [attachment, attachment],
    [{ ...attachment, sizeBytes: 2 }], [{ ...attachment, sizeBytes: '-1' }],
    [{ ...attachment, sizeBytes: '01' }], [{ ...attachment, recordId: 'other' }],
    [{ ...attachment, fieldId: 'other' }], [{ ...attachment, deleted: 'false' }],
    [{ ...attachment, blobPurged: null }], [{ ...attachment, storagePath: '' }],
    [{ ...attachment, immutableVersion: 'fabricated' }],
  ])('refuses missing or malformed attachment inventory %#', async (candidates) => {
    await expect(readRecoveryArchiveCaptureSource(vi.fn().mockResolvedValue({ rows: [
      { sections: sections(), attachment_candidates: candidates },
    ] }), scope)).rejects.toMatchObject({ code, message: code })
  })

  function attachmentSections(value: unknown) {
    return { ...sections(),
      schema: [{ ...sections().schema[0], type: 'attachment' }],
      records: [{ record_id: 'r', exists: true, version: 1, data: { f: value } }],
    }
  }
  it.each([['a'], 'a', '["a"]', '[]', null, []])('keeps supported attachment references without rewriting data %#', async (value) => {
    const source = attachmentSections(value)
    const result = await readRecoveryArchiveCaptureSource(vi.fn().mockResolvedValue({ rows: [
      { sections: source, attachment_candidates: [attachment] },
    ] }), scope)
    expect(result.sections).toEqual(source)
  })
  it.each([
    { value: ['missing'], candidates: [attachment] },
    { value: ['a'], candidates: [] },
    { value: ['a'], candidates: [{ ...attachment, deleted: true }] },
    { value: ['a'], candidates: [{ ...attachment, blobPurged: true }] },
    { value: { id: 'a' }, candidates: [attachment] },
    { value: ['a', {}], candidates: [attachment] },
    { value: '["a",{}]', candidates: [attachment] },
    { value: '["a",', candidates: [attachment] },
  ])('refuses silently lost references %#', async ({ value, candidates }) => {
    await expect(readRecoveryArchiveCaptureSource(vi.fn().mockResolvedValue({ rows: [
      { sections: attachmentSections(value), attachment_candidates: candidates },
    ] }), scope)).rejects.toMatchObject({ code, message: code })
  })
  it.each(['record', 'field'])('refuses valid but different %s binding', async (kind) => {
    const source = attachmentSections(['a'])
    source.schema.push({ ...source.schema[0], field_id: 'other-field' })
    source.records.push({ record_id: 'other-record', exists: true, version: 1, data: { f: null } })
    const candidate = { ...attachment, ...(kind === 'record' ? { recordId: 'other-record' } : { fieldId: 'other-field' }) }
    await expect(readRecoveryArchiveCaptureSource(vi.fn().mockResolvedValue({ rows: [
      { sections: source, attachment_candidates: [candidate] },
    ] }), scope)).rejects.toMatchObject({ code })
  })
})
