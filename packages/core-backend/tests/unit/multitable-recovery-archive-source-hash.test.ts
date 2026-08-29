import { createHash } from 'node:crypto'

import { describe, expect, test } from 'vitest'

import {
  RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS,
  type RecoveryArchiveCoverageSourceKind,
} from '../../src/multitable/recovery-archive-contract'
import { canonicalizeRecoveryArchiveJson } from '../../src/multitable/recovery-archive-manifest'
import {
  computeRecoveryArchiveSourceHash,
  RECOVERY_ARCHIVE_SOURCE_HASH_DOMAIN,
  RECOVERY_ARCHIVE_SOURCE_HASH_FORMAT_VERSION,
  RECOVERY_ARCHIVE_SOURCE_ROW_KEYS,
  RecoveryArchiveSourceHashError,
} from '../../src/multitable/recovery-archive-source-hash'

const CREATED_AT = '2026-08-26T00:00:00.000Z'
const TWO_POW_53_PLUS_1 = '9007199254740993'
const SHA256_A = 'a'.repeat(64)
const DOMAIN_CODES = [...RECOVERY_ARCHIVE_SOURCE_HASH_DOMAIN].map((char) => char.charCodeAt(0))

const SEQ_FIELD: Partial<Record<RecoveryArchiveCoverageSourceKind, string>> = {
  record_revision: 'seq',
  marker: 'seq',
  section_revision: 'seq',
  sealed_operation_endpoint: 'endpoint_seq',
  snapshot_membership: 'source_head_seq',
  aggregate_membership: 'child_endpoint_seq',
}

const SEQ_BEARING = RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS.filter((kind) => SEQ_FIELD[kind])
const EXTERNAL_SEQ = RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS.filter((kind) => !SEQ_FIELD[kind])

const ROWS: Record<RecoveryArchiveCoverageSourceKind, Record<string, unknown>> = {
  record_revision: {
    id: 'rev-0001',
    sheet_id: 'sheet-0001',
    record_id: 'rec-0001',
    version: 3,
    action: 'update',
    source: 'rest',
    actor_id: 'actor-0001',
    changed_field_ids: ['f1'],
    patch: { f1: { before: 1, after: 2 } },
    snapshot: { f1: 2 },
    created_at: CREATED_AT,
    batch_id: 'batch-0001',
    restored_from_version: null,
    seq: '42',
    operation_id: 'op-0001',
  },
  marker: {
    id: 'marker-0001',
    sheet_id: 'sheet-0001',
    record_id: 'rec-0001',
    version: 4,
    kind: 'lock',
    actor_id: 'actor-0001',
    created_at: CREATED_AT,
    seq: '43',
    operation_id: 'op-0001',
  },
  section_revision: {
    id: 'section-0001',
    sheet_id: 'sheet-0001',
    section_kind: 'records',
    entity_key: 'section/records',
    action: 'bootstrap_snapshot',
    payload: { row_count: '0', source_hash: SHA256_A },
    tombstone: null,
    seq: '44',
    operation_id: 'op-0001',
    created_at: CREATED_AT,
  },
  config_revision: {
    id: 'config-0001',
    sheet_id: 'sheet-0001',
    entity_type: 'field',
    entity_id: 'field-0001',
    action: 'update',
    before: { name: 'Old' },
    after: { name: 'New' },
    changed_keys: ['name'],
    batch_id: 'batch-0001',
    actor_id: 'actor-0001',
    created_at: CREATED_AT,
    source: 'mutation',
    restored_from_id: null,
    operation_id: 'op-0001',
  },
  field_tombstone: {
    id: 'ft-0001',
    sheet_id: 'sheet-0001',
    field_id: 'field-0001',
    record_id: 'rec-0001',
    value: { v: 1 },
    reason: 'field_delete',
    config_revision_id: 'config-0001',
    created_at: CREATED_AT,
    operation_id: 'op-0001',
  },
  link_tombstone: {
    id: 'lt-0001',
    sheet_id: 'sheet-0001',
    field_id: 'field-0001',
    record_id: 'rec-0001',
    foreign_record_id: 'rec-0002',
    reason: 'record_delete',
    source_revision_id: 'rev-0001',
    created_at: CREATED_AT,
    operation_id: 'op-0001',
  },
  checkpoint_baseline: {
    id: 'baseline-0001',
    checkpoint_id: 'ckpt-0001',
    sheet_id: 'sheet-0001',
    record_id: 'rec-0001',
    data: { f1: 2 },
    version: 3,
    is_trashed: false,
    created_at: CREATED_AT,
  },
  sealed_operation_endpoint: {
    sheet_id: 'sheet-0001',
    operation_id: 'op-0001',
    endpoint_seq: '45',
    event_count: 2,
    created_at: CREATED_AT,
    operation_kind: 'ordinary',
    event_contract_version: 2,
    component_count: null,
  },
  snapshot_membership: {
    sheet_id: 'sheet-0001',
    parent_operation_id: 'op-snap-0001',
    ordinal: 1,
    section_kind: 'records',
    source_head_kind: 'section_bootstrap',
    source_operation_id: 'op-boot-0001',
    source_head_seq: '46',
    row_count: '0',
    source_hash: SHA256_A,
    created_at: CREATED_AT,
  },
  aggregate_membership: {
    sheet_id: 'sheet-0001',
    parent_operation_id: 'op-agg-0001',
    ordinal: 1,
    child_operation_id: 'op-child-0001',
    child_endpoint_seq: '47',
    child_event_count: 3,
    created_at: CREATED_AT,
  },
}

const GOLDENS: Record<
  RecoveryArchiveCoverageSourceKind,
  { seq: string | null; sourceId: string; hash: string; body: string }
> = {
  record_revision: {
    seq: '42',
    sourceId: 'v1.eyJpZCI6InJldi0wMDAxIn0',
    hash: 'b29270ff377f342b6f67c8f97bcb16e416f8cfe52a24770d252125433645273f',
    body: '{"format_version":1,"row":{"action":"update","actor_id":"actor-0001","batch_id":"batch-0001","changed_field_ids":["f1"],"created_at":"2026-08-26T00:00:00.000Z","id":"rev-0001","operation_id":"op-0001","patch":{"f1":{"after":2,"before":1}},"record_id":"rec-0001","restored_from_version":null,"seq":"42","sheet_id":"sheet-0001","snapshot":{"f1":2},"source":"rest","version":3},"source_id":"v1.eyJpZCI6InJldi0wMDAxIn0","source_kind":"record_revision","source_seq":"42"}',
  },
  marker: {
    seq: '43',
    sourceId: 'v1.eyJpZCI6Im1hcmtlci0wMDAxIn0',
    hash: '94e8a0651c79001b20e26a30233b1195c7a4c4710d98236d337e3f9a4b4af081',
    body: '{"format_version":1,"row":{"actor_id":"actor-0001","created_at":"2026-08-26T00:00:00.000Z","id":"marker-0001","kind":"lock","operation_id":"op-0001","record_id":"rec-0001","seq":"43","sheet_id":"sheet-0001","version":4},"source_id":"v1.eyJpZCI6Im1hcmtlci0wMDAxIn0","source_kind":"marker","source_seq":"43"}',
  },
  section_revision: {
    seq: '44',
    sourceId: 'v1.eyJpZCI6InNlY3Rpb24tMDAwMSJ9',
    hash: '83a05ece5abdeb8502d4dce870798fb1d2da63251403017a88dd92df4569cbf1',
    body: '{"format_version":1,"row":{"action":"bootstrap_snapshot","created_at":"2026-08-26T00:00:00.000Z","entity_key":"section/records","id":"section-0001","operation_id":"op-0001","payload":{"row_count":"0","source_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"section_kind":"records","seq":"44","sheet_id":"sheet-0001","tombstone":null},"source_id":"v1.eyJpZCI6InNlY3Rpb24tMDAwMSJ9","source_kind":"section_revision","source_seq":"44"}',
  },
  config_revision: {
    seq: null,
    sourceId: 'v1.eyJpZCI6ImNvbmZpZy0wMDAxIn0',
    hash: '2f67165514e9f7b4379eed635d22e80186f4402d98111674e0883140d032c6d7',
    body: '{"format_version":1,"row":{"action":"update","actor_id":"actor-0001","after":{"name":"New"},"batch_id":"batch-0001","before":{"name":"Old"},"changed_keys":["name"],"created_at":"2026-08-26T00:00:00.000Z","entity_id":"field-0001","entity_type":"field","id":"config-0001","operation_id":"op-0001","restored_from_id":null,"sheet_id":"sheet-0001","source":"mutation"},"source_id":"v1.eyJpZCI6ImNvbmZpZy0wMDAxIn0","source_kind":"config_revision","source_seq":null}',
  },
  field_tombstone: {
    seq: null,
    sourceId: 'v1.eyJpZCI6ImZ0LTAwMDEifQ',
    hash: 'c4e2f1fb91802aef09e3733d7229f8ea446196c307d0cc63a4487b05fd978c7f',
    body: '{"format_version":1,"row":{"config_revision_id":"config-0001","created_at":"2026-08-26T00:00:00.000Z","field_id":"field-0001","id":"ft-0001","operation_id":"op-0001","reason":"field_delete","record_id":"rec-0001","sheet_id":"sheet-0001","value":{"v":1}},"source_id":"v1.eyJpZCI6ImZ0LTAwMDEifQ","source_kind":"field_tombstone","source_seq":null}',
  },
  link_tombstone: {
    seq: null,
    sourceId: 'v1.eyJpZCI6Imx0LTAwMDEifQ',
    hash: '8d9b6c08e769bcd3199e64c7007ff58fa833e32199a72c89463d6ac5fe3290a1',
    body: '{"format_version":1,"row":{"created_at":"2026-08-26T00:00:00.000Z","field_id":"field-0001","foreign_record_id":"rec-0002","id":"lt-0001","operation_id":"op-0001","reason":"record_delete","record_id":"rec-0001","sheet_id":"sheet-0001","source_revision_id":"rev-0001"},"source_id":"v1.eyJpZCI6Imx0LTAwMDEifQ","source_kind":"link_tombstone","source_seq":null}',
  },
  checkpoint_baseline: {
    seq: null,
    sourceId: 'v1.eyJpZCI6ImJhc2VsaW5lLTAwMDEifQ',
    hash: 'dff0a3f6a903e8c7133ff3dba861e68fba56855873d88a4c3c75aab3d408ce72',
    body: '{"format_version":1,"row":{"checkpoint_id":"ckpt-0001","created_at":"2026-08-26T00:00:00.000Z","data":{"f1":2},"id":"baseline-0001","is_trashed":false,"record_id":"rec-0001","sheet_id":"sheet-0001","version":3},"source_id":"v1.eyJpZCI6ImJhc2VsaW5lLTAwMDEifQ","source_kind":"checkpoint_baseline","source_seq":null}',
  },
  sealed_operation_endpoint: {
    seq: '45',
    sourceId: 'v1.eyJvcGVyYXRpb25faWQiOiJvcC0wMDAxIiwic2hlZXRfaWQiOiJzaGVldC0wMDAxIn0',
    hash: '08524d9331a2f1017d07779aabda53b2d38e3c2e959e72e9fba937fc73881c1e',
    body: '{"format_version":1,"row":{"component_count":null,"created_at":"2026-08-26T00:00:00.000Z","endpoint_seq":"45","event_contract_version":2,"event_count":2,"operation_id":"op-0001","operation_kind":"ordinary","sheet_id":"sheet-0001"},"source_id":"v1.eyJvcGVyYXRpb25faWQiOiJvcC0wMDAxIiwic2hlZXRfaWQiOiJzaGVldC0wMDAxIn0","source_kind":"sealed_operation_endpoint","source_seq":"45"}',
  },
  snapshot_membership: {
    seq: '46',
    sourceId:
      'v1.eyJvcmRpbmFsIjoxLCJwYXJlbnRfb3BlcmF0aW9uX2lkIjoib3Atc25hcC0wMDAxIiwic2hlZXRfaWQiOiJzaGVldC0wMDAxIn0',
    hash: '44eef7f73db8af8ba3cc82f93a33b56156e4166cd3c936448bf86704615cec97',
    body: '{"format_version":1,"row":{"created_at":"2026-08-26T00:00:00.000Z","ordinal":1,"parent_operation_id":"op-snap-0001","row_count":"0","section_kind":"records","sheet_id":"sheet-0001","source_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","source_head_kind":"section_bootstrap","source_head_seq":"46","source_operation_id":"op-boot-0001"},"source_id":"v1.eyJvcmRpbmFsIjoxLCJwYXJlbnRfb3BlcmF0aW9uX2lkIjoib3Atc25hcC0wMDAxIiwic2hlZXRfaWQiOiJzaGVldC0wMDAxIn0","source_kind":"snapshot_membership","source_seq":"46"}',
  },
  aggregate_membership: {
    seq: '47',
    sourceId:
      'v1.eyJvcmRpbmFsIjoxLCJwYXJlbnRfb3BlcmF0aW9uX2lkIjoib3AtYWdnLTAwMDEiLCJzaGVldF9pZCI6InNoZWV0LTAwMDEifQ',
    hash: 'ed10ec18014ffbf8270288c38b111a29c6d464bd4b4934097ea7192a4196393f',
    body: '{"format_version":1,"row":{"child_endpoint_seq":"47","child_event_count":3,"child_operation_id":"op-child-0001","created_at":"2026-08-26T00:00:00.000Z","ordinal":1,"parent_operation_id":"op-agg-0001","sheet_id":"sheet-0001"},"source_id":"v1.eyJvcmRpbmFsIjoxLCJwYXJlbnRfb3BlcmF0aW9uX2lkIjoib3AtYWdnLTAwMDEiLCJzaGVldF9pZCI6InNoZWV0LTAwMDEifQ","source_kind":"aggregate_membership","source_seq":"47"}',
  },
}

function identityOf(
  kind: RecoveryArchiveCoverageSourceKind,
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === 'sealed_operation_endpoint') {
    return { sheet_id: row.sheet_id, operation_id: row.operation_id }
  }
  if (kind === 'snapshot_membership' || kind === 'aggregate_membership') {
    return {
      sheet_id: row.sheet_id,
      parent_operation_id: row.parent_operation_id,
      ordinal: row.ordinal,
    }
  }
  return { id: row.id }
}

function expectedPreimage(
  kind: RecoveryArchiveCoverageSourceKind,
  row: Record<string, unknown>,
  sourceSeq: string | null,
) {
  const sourceId = `v${RECOVERY_ARCHIVE_SOURCE_HASH_FORMAT_VERSION}.${Buffer.from(
    canonicalizeRecoveryArchiveJson(identityOf(kind, row)),
    'utf8',
  ).toString('base64url')}`
  const bodyJson = canonicalizeRecoveryArchiveJson({
    format_version: RECOVERY_ARCHIVE_SOURCE_HASH_FORMAT_VERSION,
    source_kind: kind,
    source_id: sourceId,
    source_seq: sourceSeq,
    row,
  })
  const preimage = `${RECOVERY_ARCHIVE_SOURCE_HASH_DOMAIN}\u0000${bodyJson}`
  return {
    sourceId,
    preimage,
    hash: createHash('sha256').update(preimage, 'utf8').digest('hex'),
  }
}

function hashKind(
  kind: RecoveryArchiveCoverageSourceKind,
  row: Record<string, unknown> = ROWS[kind],
  sourceSeq: string | null = GOLDENS[kind].seq,
) {
  return computeRecoveryArchiveSourceHash(kind, row, sourceSeq)
}

function expectCode(fn: () => void, code: string) {
  expect(fn).toThrow(RecoveryArchiveSourceHashError)
  try {
    fn()
  } catch (error) {
    expect(error).toMatchObject({ code, message: code })
  }
}

function reversedRow(row: Record<string, unknown>): Record<string, unknown> {
  const reversed: Record<string, unknown> = {}
  for (const key of Object.keys(row).reverse()) reversed[key] = row[key]
  return reversed
}

describe('Time Machine D2d2-PREP-B source hash', () => {
  test('pins domain, format version, and exact final-row key sets', () => {
    expect(RECOVERY_ARCHIVE_SOURCE_HASH_FORMAT_VERSION).toBe(1)
    expect(RECOVERY_ARCHIVE_SOURCE_HASH_DOMAIN).toBe(
      'metasheet2:multitable:recovery-archive:source-hash:v1',
    )
    expect(RECOVERY_ARCHIVE_SOURCE_HASH_DOMAIN).toHaveLength(53)
    expect(DOMAIN_CODES).toEqual([
      109, 101, 116, 97, 115, 104, 101, 101, 116, 50, 58, 109, 117, 108, 116, 105, 116, 97, 98, 108,
      101, 58, 114, 101, 99, 111, 118, 101, 114, 121, 45, 97, 114, 99, 104, 105, 118, 101, 58, 115,
      111, 117, 114, 99, 101, 45, 104, 97, 115, 104, 58, 118, 49,
    ])
    expect(Object.keys(RECOVERY_ARCHIVE_SOURCE_ROW_KEYS)).toEqual([
      ...RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS,
    ])
    expect(RECOVERY_ARCHIVE_SOURCE_ROW_KEYS).toEqual({
      record_revision: [
        'id',
        'sheet_id',
        'record_id',
        'version',
        'action',
        'source',
        'actor_id',
        'changed_field_ids',
        'patch',
        'snapshot',
        'created_at',
        'batch_id',
        'restored_from_version',
        'seq',
        'operation_id',
      ],
      marker: ['id', 'sheet_id', 'record_id', 'version', 'kind', 'actor_id', 'created_at', 'seq', 'operation_id'],
      section_revision: [
        'id',
        'sheet_id',
        'section_kind',
        'entity_key',
        'action',
        'payload',
        'tombstone',
        'seq',
        'operation_id',
        'created_at',
      ],
      config_revision: [
        'id',
        'sheet_id',
        'entity_type',
        'entity_id',
        'action',
        'before',
        'after',
        'changed_keys',
        'batch_id',
        'actor_id',
        'created_at',
        'source',
        'restored_from_id',
        'operation_id',
      ],
      field_tombstone: [
        'id',
        'sheet_id',
        'field_id',
        'record_id',
        'value',
        'reason',
        'config_revision_id',
        'created_at',
        'operation_id',
      ],
      link_tombstone: [
        'id',
        'sheet_id',
        'field_id',
        'record_id',
        'foreign_record_id',
        'reason',
        'source_revision_id',
        'created_at',
        'operation_id',
      ],
      checkpoint_baseline: [
        'id',
        'checkpoint_id',
        'sheet_id',
        'record_id',
        'data',
        'version',
        'is_trashed',
        'created_at',
      ],
      sealed_operation_endpoint: [
        'sheet_id',
        'operation_id',
        'endpoint_seq',
        'event_count',
        'created_at',
        'operation_kind',
        'event_contract_version',
        'component_count',
      ],
      snapshot_membership: [
        'sheet_id',
        'parent_operation_id',
        'ordinal',
        'section_kind',
        'source_head_kind',
        'source_operation_id',
        'source_head_seq',
        'row_count',
        'source_hash',
        'created_at',
      ],
      aggregate_membership: [
        'sheet_id',
        'parent_operation_id',
        'ordinal',
        'child_operation_id',
        'child_endpoint_seq',
        'child_event_count',
        'created_at',
      ],
    })

    expect(Object.isFrozen(RECOVERY_ARCHIVE_SOURCE_ROW_KEYS)).toBe(true)
    expect(
      Object.values(RECOVERY_ARCHIVE_SOURCE_ROW_KEYS).every((keys) => Object.isFrozen(keys)),
    ).toBe(true)

    const before = hashKind('record_revision')
    const keyCount = RECOVERY_ARCHIVE_SOURCE_ROW_KEYS.record_revision.length
    expect(() => {
      ;(RECOVERY_ARCHIVE_SOURCE_ROW_KEYS.record_revision as unknown as string[]).pop()
    }).toThrow(TypeError)
    expect(RECOVERY_ARCHIVE_SOURCE_ROW_KEYS.record_revision).toHaveLength(keyCount)
    expect(hashKind('record_revision')).toEqual(before)
  })

  test.each(RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS)(
    'pins preimage and lowercase hash for %s',
    (kind) => {
      const golden = GOLDENS[kind]
      const result = hashKind(kind)
      const expected = expectedPreimage(kind, ROWS[kind], golden.seq)
      expect(result.sourceId).toBe(golden.sourceId)
      expect(result.sourceId).toBe(expected.sourceId)
      expect(result.sourceSeq).toBe(golden.seq)
      expect(result.preimage).toBe(`${RECOVERY_ARCHIVE_SOURCE_HASH_DOMAIN}\u0000${golden.body}`)
      expect(result.preimage).toBe(expected.preimage)
      expect(result.hash).toBe(golden.hash)
      expect(result.hash).toBe(expected.hash)
      expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
      const body = JSON.parse(result.preimage.slice(RECOVERY_ARCHIVE_SOURCE_HASH_DOMAIN.length + 1))
      expect(Object.keys(body).sort()).toEqual([
        'format_version',
        'row',
        'source_id',
        'source_kind',
        'source_seq',
      ])
      expect(body).toMatchObject({
        format_version: 1,
        source_kind: kind,
        source_id: result.sourceId,
        source_seq: golden.seq,
        row: ROWS[kind],
      })
      expect(result.sourceId.startsWith('v1.')).toBe(true)
      expect(result.sourceId.includes('/')).toBe(false)
      expect(`coverage/${kind}/${result.sourceId}`.split('/')).toHaveLength(3)
    },
  )

  test('domain, source_kind, one row key, and seq matching are load-bearing', () => {
    const result = hashKind('record_revision')
    const bodyJson = result.preimage.slice(RECOVERY_ARCHIVE_SOURCE_HASH_DOMAIN.length + 1)
    expect(result.hash).not.toBe(createHash('sha256').update(bodyJson, 'utf8').digest('hex'))

    const body = JSON.parse(bodyJson) as Record<string, unknown>
    delete body.source_kind
    expect(result.hash).not.toBe(
      createHash('sha256')
        .update(
          `${RECOVERY_ARCHIVE_SOURCE_HASH_DOMAIN}\u0000${canonicalizeRecoveryArchiveJson(body)}`,
          'utf8',
        )
        .digest('hex'),
    )

    const mutated = hashKind('record_revision', { ...ROWS.record_revision, action: 'delete' })
    expect(mutated.hash).not.toBe(result.hash)
    expect(mutated.preimage).toContain('"action":"delete"')

    const withoutAction = { ...ROWS.record_revision }
    delete withoutAction.action
    expectCode(
      () => hashKind('record_revision', withoutAction),
      'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_KEYS',
    )
    expectCode(() => hashKind('record_revision', ROWS.record_revision, '99'), 'RECOVERY_ARCHIVE_SOURCE_HASH_SEQ_MISMATCH')
  })

  test('cross-kind hashes stay separated even when identity encodes the same id', () => {
    const record = hashKind('record_revision', { ...ROWS.record_revision, id: 'shared-0001' }, '42')
    const marker = hashKind('marker', { ...ROWS.marker, id: 'shared-0001' }, '43')
    expect(record.sourceId).toBe(marker.sourceId)
    expect(record.hash).not.toBe(marker.hash)
    expect(record.preimage).toContain('"source_kind":"record_revision"')
    expect(marker.preimage).toContain('"source_kind":"marker"')
  })

  test.each(RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS)(
    'row property insertion order is deterministic for %s',
    (kind) => {
      const reversed = reversedRow(ROWS[kind])
      expect(Object.keys(reversed)).not.toEqual(Object.keys(ROWS[kind]))
      const first = hashKind(kind)
      const second = hashKind(kind, reversed)
      expect(second.preimage).toBe(first.preimage)
      expect(second.hash).toBe(first.hash)
    },
  )

  test('version-tagged JCS identity resists delimiter collision and slash injection', () => {
    const slashId = hashKind('record_revision', { ...ROWS.record_revision, id: 'sheet-0001/op-0001' })
    const endpoint = hashKind('sealed_operation_endpoint')
    expect(slashId.sourceId).not.toBe(endpoint.sourceId)
    expect(slashId.sourceId.includes('/')).toBe(false)
    expect(endpoint.sourceId.includes('/')).toBe(false)

    const left = hashKind('sealed_operation_endpoint', {
      ...ROWS.sealed_operation_endpoint,
      sheet_id: 'a/b',
      operation_id: 'c',
    })
    const right = hashKind('sealed_operation_endpoint', {
      ...ROWS.sealed_operation_endpoint,
      sheet_id: 'a',
      operation_id: 'b/c',
    })
    expect(left.sourceId).not.toBe(right.sourceId)
    expect(`coverage/sealed_operation_endpoint/${left.sourceId}`.split('/')).toHaveLength(3)
    expect(`coverage/sealed_operation_endpoint/${right.sourceId}`.split('/')).toHaveLength(3)
  })

  test.each([
    ['record_revision', { id: '' }],
    ['record_revision', { id: 1 }],
    ['record_revision', { id: 'lone-high-\uD83D' }],
    ['sealed_operation_endpoint', { sheet_id: '' }],
    ['snapshot_membership', { ordinal: 0 }],
    ['aggregate_membership', { ordinal: '1' }],
  ] as const)('malformed identity refuses for %s', (kind, patch) => {
    expectCode(
      () => hashKind(kind, { ...ROWS[kind], ...patch }),
      'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_IDENTITY',
    )
  })

  test.each(SEQ_BEARING)('seq-bearing %s accepts canonical decimals above 2^53', (kind) => {
    const field = SEQ_FIELD[kind]
    if (field === undefined) throw new Error('missing seq field')
    const result = hashKind(kind, { ...ROWS[kind], [field]: TWO_POW_53_PLUS_1 }, TWO_POW_53_PLUS_1)
    expect(result.sourceSeq).toBe(TWO_POW_53_PLUS_1)
    expect(result.preimage).toContain(`"${field}":"${TWO_POW_53_PLUS_1}"`)
    expect(result.preimage).toContain(`"source_seq":"${TWO_POW_53_PLUS_1}"`)
  })

  test.each(EXTERNAL_SEQ)('external-seq %s accepts null and canonical decimals', (kind) => {
    expect(hashKind(kind, ROWS[kind], null).sourceSeq).toBeNull()
    expect(hashKind(kind, ROWS[kind], TWO_POW_53_PLUS_1).sourceSeq).toBe(TWO_POW_53_PLUS_1)
  })

  test.each(RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS)('malformed seq refuses for %s', (kind) => {
    for (const seq of [1, '0', '01', '']) {
      expectCode(() => hashKind(kind, ROWS[kind], seq as never), 'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_SEQ')
    }
  })

  test('numeric row seq is malformed rather than coerced', () => {
    expectCode(
      () => hashKind('record_revision', { ...ROWS.record_revision, seq: 42 }, '42'),
      'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_SEQ',
    )
  })

  test.each(SEQ_BEARING)('seq mismatch refuses for %s', (kind) => {
    expectCode(() => hashKind(kind, ROWS[kind], '99'), 'RECOVERY_ARCHIVE_SOURCE_HASH_SEQ_MISMATCH')
    expectCode(() => hashKind(kind, ROWS[kind], null), 'RECOVERY_ARCHIVE_SOURCE_HASH_SEQ_MISMATCH')
  })

  test.each(['', 'unknown', 'Record_revision', 'RECORD_REVISION', 1, null, undefined])(
    'unknown kind %j refuses before row admission',
    (kind) => {
      expectCode(
        () => computeRecoveryArchiveSourceHash(kind, ROWS.record_revision, '42'),
        'RECOVERY_ARCHIVE_SOURCE_HASH_UNKNOWN_KIND',
      )
    },
  )

  test.each(RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS)(
    'missing and extra keys refuse for %s',
    (kind) => {
      const missing = { ...ROWS[kind] }
      delete missing[RECOVERY_ARCHIVE_SOURCE_ROW_KEYS[kind][0]]
      expectCode(() => hashKind(kind, missing), 'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_KEYS')
      expectCode(
        () => hashKind(kind, { ...ROWS[kind], extra_key: 'x' }),
        'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_KEYS',
      )
    },
  )

  test('non-plain, hostile accessor, symbol, and lone-surrogate rows refuse', () => {
    class Row {
      id = 'rev-0001'
    }
    for (const bad of [null, undefined, 1, 'row', [], new Date(0), new Map(), new Row()]) {
      expectCode(
        () => computeRecoveryArchiveSourceHash('record_revision', bad, '42'),
        'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_ROW',
      )
    }

    const accessorRow = { ...ROWS.record_revision }
    Object.defineProperty(accessorRow, 'id', { enumerable: true, get: () => 'rev-0001' })
    expectCode(() => hashKind('record_revision', accessorRow), 'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_ROW')

    const symbolRow = { ...ROWS.record_revision }
    ;(symbolRow as Record<symbol, unknown>)[Symbol('extra')] = 'x'
    expectCode(() => hashKind('record_revision', symbolRow), 'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_ROW')

    expectCode(
      () => hashKind('record_revision', { ...ROWS.record_revision, patch: { data: 'lone-high-\uD83D' } }),
      'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_ROW',
    )
    expectCode(
      () => hashKind('record_revision', { ...ROWS.record_revision, snapshot: { data: '\uDE00-lone-low' } }),
      'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_ROW',
    )

    const nestedAccessor: Record<string, unknown> = {}
    Object.defineProperty(nestedAccessor, 'f1', { enumerable: true, get: () => 2 })
    expectCode(
      () => hashKind('record_revision', { ...ROWS.record_revision, snapshot: nestedAccessor }),
      'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_ROW',
    )

    const revoked = Proxy.revocable({ ...ROWS.record_revision }, {})
    revoked.revoke()
    expectCode(() => hashKind('record_revision', revoked.proxy), 'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_ROW')
  })

  test('null-prototype ordinary data descriptors still hash', () => {
    const nullProto = Object.assign(Object.create(null), ROWS.checkpoint_baseline) as Record<
      string,
      unknown
    >
    expect(hashKind('checkpoint_baseline', nullProto).hash).toBe(hashKind('checkpoint_baseline').hash)
  })
})
