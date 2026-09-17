import { describe, expect, it, vi } from 'vitest'
import { readRecoveryArchiveRelationalSource } from '../../src/multitable/recovery-archive-relational-source'

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
    const query = vi.fn().mockResolvedValue({ rows: [{ sections: input }] })
    const result = await readRecoveryArchiveRelationalSource(query, scope)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][1]).toEqual(['sheet', 'base', 'workspace'])
    expect(result).toEqual(input)
    expect(Object.keys(result)).toHaveLength(7)
    input.records[0].data.f = 'changed'
    expect(result.records).toEqual([{ record_id: 'r', exists: true, version: 1, data: { f: 'value' } }])
  })

  it('accepts a proven empty live scope, not a missing scope', async () => {
    const empty = Object.fromEntries(Object.keys(sections()).map((key) => [key, []]))
    await expect(readRecoveryArchiveRelationalSource(
      vi.fn().mockResolvedValue({ rows: [{ sections: empty }] }), scope,
    )).resolves.toEqual(empty)
    await expect(readRecoveryArchiveRelationalSource(
      vi.fn().mockResolvedValue({ rows: [] }), scope,
    )).rejects.toMatchObject({ code })
  })

  it.each(Object.keys(sections()))('rejects missing section %s', async (section) => {
    const partial: Record<string, unknown> = sections()
    delete partial[section]
    await expect(readRecoveryArchiveRelationalSource(
      vi.fn().mockResolvedValue({ rows: [{ sections: partial }] }), scope,
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
        vi.fn().mockResolvedValue({ rows: [{ sections: malformed }] }), scope,
      )).rejects.toMatchObject({ code })
    }
  })

  it('refuses cross-schema links and sequences instead of omitting them', async () => {
    for (const malformed of [
      { ...sections(), links: [{ link_id: 'l', field_id: 'other', record_id: 'r', foreign_record_id: 'foreign' }] },
      { ...sections(), auto_number: [{ field_id: 'other', next_value: '2' }] },
    ]) {
      await expect(readRecoveryArchiveRelationalSource(
        vi.fn().mockResolvedValue({ rows: [{ sections: malformed }] }), scope,
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
})
