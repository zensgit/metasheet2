import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readRecoveryArchiveBoundedCaptureSource } from '../../src/multitable/recovery-archive-bounded-source'
import type { RecoveryArchiveSourceQuery } from '../../src/multitable/recovery-archive-relational-source'

const clock = vi.hoisted(() => ({ value: 0 }))
vi.mock('node:perf_hooks', () => ({ performance: { now: () => clock.value } }))

const scope = { workspaceId: 'workspace', baseId: 'base', sheetId: 'sheet' }
const limits = { maxBytes: 4096, timeoutMs: 1000 }
const prefix = 'RECOVERY_ARCHIVE_CAPTURE_'
const sections = {
  schema: [{ field_id: 'f', name: 'Synthetic', type: 'string', property: {}, order: 1 }],
  records: [{ record_id: 'r', exists: true, version: 1, data: { f: 'value' } }],
  links: [], field_value_tombstones: [], link_tombstones: [], auto_number: [], views_config: [],
}

function harness(options: {
  isolation?: string; held?: boolean; present?: boolean; brokenXid?: boolean;
  source?: Record<string, unknown[]>; overBudget?: boolean; delay?: number;
} = {}) {
  const source = options.source ?? { ...structuredClone(sections), attachment_candidates: [] }
  const tableSections: Record<string, string> = {
    meta_fields: 'schema', meta_records: 'records', meta_links: 'links',
    meta_field_value_tombstones: 'field_value_tombstones', meta_link_tombstones: 'link_tombstones',
    meta_field_auto_number_sequences: 'auto_number', meta_views: 'views_config',
    multitable_attachments: 'attachment_candidates',
  }
  const offsets: Record<string, number> = {}
  let statements = 0
  const query = vi.fn<Parameters<RecoveryArchiveSourceQuery>, ReturnType<RecoveryArchiveSourceQuery>>(
    async (sql, params) => {
      statements++
      clock.value += options.delay ?? 0
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[0] }] }
      const xid = options.brokenXid && statements > 1 ? '43' : '42'
      if (sql.includes(' AS present')) return { rows: [{ xid, present: options.present ?? true }] }
      if (!sql.startsWith('WITH scope')) return { rows: [{ xid,
        isolation: options.isolation ?? 'repeatable read', statement_timeout: '30s',
        advisory_held: options.held ?? false }] }
      const table = /FROM public\.(\w+) e/.exec(sql)![1]!
      const section = tableSections[table]!
      const offset = offsets[section] ?? 0
      offsets[section] = offset + 1
      const item = source[section]![offset]
      if (!item) return { rows: [{ xid, entity_key: null, payload_bytes: null, payload: null }] }
      const payload = JSON.stringify(item)
      const bytes = options.overBudget ? limits.maxBytes + 1 : Buffer.byteLength(payload)
      const suppressed = bytes > Number(params[4])
      return { rows: [{ xid, entity_key: suppressed ? null : String(offset), payload_bytes: bytes,
        payload: suppressed ? null : payload }] }
    },
  )
  return query
}

beforeEach(() => { clock.value = 0 })

describe('bounded internal RR database capture', () => {
  it('captures every named section and preserves the closed canonical source shape', async () => {
    const query = harness()
    await expect(readRecoveryArchiveBoundedCaptureSource(query, scope, limits))
      .resolves.toEqual({ sections, attachmentCandidates: [] })
    const calls = query.mock.calls
    const reads = calls.filter(([sql]) => sql.startsWith('WITH scope'))
    expect(reads).toHaveLength(10)
    for (const [sql, params] of reads) {
      expect(params.slice(0, 3)).toEqual(['sheet', 'base', 'workspace'])
      expect(sql).toContain('LIMIT 1')
      expect(sql).toContain('CASE WHEN octet_length(candidate.payload)<=$5::int THEN candidate.payload END')
      expect(sql).not.toMatch(/jsonb_agg|pg_advisory.*lock/)
    }
    expect(calls.at(-1)).toEqual(["SELECT set_config('statement_timeout',$1,true)", ['30s']])
  })

  it('admits an empty proven scope and refuses a missing scope', async () => {
    const empty = Object.fromEntries([...Object.keys(sections), 'attachment_candidates'].map((key) => [key, []]))
    await expect(readRecoveryArchiveBoundedCaptureSource(harness({ source: empty }), scope, limits))
      .resolves.toEqual({ sections: Object.fromEntries(Object.keys(sections).map((key) => [key, []])), attachmentCandidates: [] })
    await expect(readRecoveryArchiveBoundedCaptureSource(harness({ present: false }), scope, limits))
      .rejects.toMatchObject({ code: `${prefix}UNAVAILABLE` })
  })

  it.each(['read committed', 'serializable'])('refuses %s before reading source', async (isolation) => {
    const query = harness({ isolation })
    await expect(readRecoveryArchiveBoundedCaptureSource(query, scope, limits))
      .rejects.toMatchObject({ code: `${prefix}TRANSACTION_REQUIRED` })
    expect(query.mock.calls.filter(([sql]) => sql.startsWith('WITH scope'))).toEqual([])
  })

  it('refuses a held advisory fence and a changed xid', async () => {
    for (const [options, code] of [
      [{ held: true }, `${prefix}FENCE_HELD`],
      [{ brokenXid: true }, `${prefix}TRANSACTION_REQUIRED`],
    ] as const) {
      await expect(readRecoveryArchiveBoundedCaptureSource(harness(options), scope, limits))
        .rejects.toMatchObject({ code })
    }
  })

  it('refuses a server-suppressed individual row and cumulative byte overflow', async () => {
    await expect(readRecoveryArchiveBoundedCaptureSource(harness({ overBudget: true }), scope, limits))
      .rejects.toMatchObject({ code: `${prefix}BYTES_EXCEEDED` })
    const cap = Buffer.byteLength(JSON.stringify(sections.schema[0]))
    await expect(readRecoveryArchiveBoundedCaptureSource(harness(), scope, { ...limits, maxBytes: cap }))
      .rejects.toMatchObject({ code: `${prefix}BYTES_EXCEEDED` })
  })

  it('accepts the exact cumulative byte boundary', async () => {
    const maxBytes = [...sections.schema, ...sections.records]
      .reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0)
    await expect(readRecoveryArchiveBoundedCaptureSource(harness(), scope, { ...limits, maxBytes }))
      .resolves.toEqual({ sections, attachmentCandidates: [] })
  })

  it('enforces the total elapsed budget and contains server statement timeout errors', async () => {
    await expect(readRecoveryArchiveBoundedCaptureSource(harness({ delay: 100 }), scope, { ...limits, timeoutMs: 150 }))
      .rejects.toMatchObject({ code: `${prefix}TIME_EXCEEDED` })
    await expect(readRecoveryArchiveBoundedCaptureSource(vi.fn().mockRejectedValue(
      Object.assign(new Error('private-database-value'), { code: '57014' }),
    ), scope, limits)).rejects.toMatchObject({ code: `${prefix}TIME_EXCEEDED`, message: `${prefix}TIME_EXCEEDED` })
  })

  it.each([{}, { maxBytes: 0, timeoutMs: 1 }, { maxBytes: 1, timeoutMs: 0 },
    { maxBytes: 1.5, timeoutMs: 1 }, { maxBytes: 1, timeoutMs: Infinity },
    { maxBytes: 2147483648, timeoutMs: 1 }, { maxBytes: 1, timeoutMs: 2147483648 },
    { maxBytes: 1, timeoutMs: 1, extra: true }])('refuses invalid server limits before IO %#', async (invalid) => {
    const query = harness()
    await expect(readRecoveryArchiveBoundedCaptureSource(query, scope, invalid as typeof limits))
      .rejects.toMatchObject({ code: `${prefix}POLICY_INVALID` })
    expect(query).not.toHaveBeenCalled()
  })

  it('contains malformed source data and database errors without echoing values', async () => {
    const source = { ...sections, records: [{ record_id: 'private', exists: true, version: 1, data: null }], attachment_candidates: [] }
    await expect(readRecoveryArchiveBoundedCaptureSource(harness({ source }), scope, limits))
      .rejects.toMatchObject({ code: `${prefix}UNAVAILABLE`, message: `${prefix}UNAVAILABLE` })
    await expect(readRecoveryArchiveBoundedCaptureSource(vi.fn().mockRejectedValue(new Error('private-value')), scope, limits))
      .rejects.toMatchObject({ code: `${prefix}UNAVAILABLE`, message: `${prefix}UNAVAILABLE` })
  })
})
