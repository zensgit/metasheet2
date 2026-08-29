import { describe, expect, it } from 'vitest'

import {
  buildRecoveryArchiveSectionRows,
  RecoveryArchiveSectionRowsError,
  type RecoveryArchiveDataSectionName,
  type RecoveryArchiveSectionRowsErrorCode,
} from '../../src/multitable/recovery-archive-section-rows'

type PositiveCase = {
  readonly row: Record<string, unknown>
  readonly entityKey: string
}

const positiveCases: Readonly<Record<RecoveryArchiveDataSectionName, PositiveCase>> = {
  schema: {
    row: {
      field_id: 'field-é',
      name: 'Name',
      type: 'text',
      property: { required: true },
      order: 1,
    },
    entityKey: 'field/field-é',
  },
  records: {
    row: {
      record_id: 'record-漢',
      exists: true,
      version: 4,
      data: { title: 'archive truth', tags: ['one', 'two'] },
    },
    entityKey: 'record/record-漢',
  },
  links: {
    row: {
      link_id: 'link-1',
      field_id: 'field-1',
      record_id: 'record-1',
      foreign_record_id: 'record-2',
    },
    entityKey: 'link/link-1',
  },
  field_value_tombstones: {
    row: {
      id: 'field-tombstone-1',
      field_id: 'field-1',
      record_id: 'record-1',
      config_revision_id: 'config-1',
      value: { prior: 'value' },
      reason: 'removed',
      created_at: '2026-08-28T00:00:00.000Z',
    },
    entityKey: 'field-tombstone/field-tombstone-1',
  },
  link_tombstones: {
    row: {
      id: 'link-tombstone-1',
      source_revision_id: 'source-1',
      field_id: 'field-1',
      record_id: 'record-1',
      foreign_record_id: 'record-2',
      reason: 'removed',
      created_at: '2026-08-28T00:00:00.000Z',
    },
    entityKey: 'link-tombstone/link-tombstone-1',
  },
  auto_number: {
    row: {
      field_id: 'auto-1',
      next_value: '9007199254740993',
    },
    entityKey: 'field/auto-1',
  },
  attachments_index: {
    row: {
      attachment_id: 'attachment-1',
      record_id: 'record-1',
      field_id: 'field-1',
      immutable_object_version: 'object-v1',
      plaintext_sha256: 'digest',
      size_bytes: '42',
      media_type: 'text/plain',
      deleted: false,
    },
    entityKey: 'attachment/attachment-1',
  },
  permission_evidence: {
    row: {
      authorized_scope_hash: 'scope-1',
      policy_epoch_hash: 'policy-1',
      captured_at_seq: '9007199254740993',
    },
    entityKey: 'scope/scope-1',
  },
  views_config: {
    row: {
      view_id: 'view-1',
      name: 'All rows',
      type: 'grid',
      filter_info: { conjunction: 'and' },
      sort_info: [{ field_id: 'field-1', direction: 'asc' }],
      group_info: null,
      hidden_field_ids: ['field-hidden'],
      config: { density: 'compact' },
    },
    entityKey: 'view/view-1',
  },
}

describe('buildRecoveryArchiveSectionRows', () => {
  it('maps all nine D1 data sections to their exact envelopes', () => {
    for (const [sectionName, fixture] of Object.entries(positiveCases) as [
      RecoveryArchiveDataSectionName,
      PositiveCase,
    ][]) {
      expect(buildRecoveryArchiveSectionRows(sectionName, [fixture.row])).toEqual([
        { entity_key: fixture.entityKey, payload: fixture.row },
      ])
    }
  })

  it('sorts entity keys by UTF-8 bytes', () => {
    const rows = buildRecoveryArchiveSectionRows('records', [
      { record_id: 'é', exists: true, version: 1, data: {} },
      { record_id: 'z', exists: true, version: 1, data: {} },
    ])

    expect(rows.map((row) => row.entity_key)).toEqual(['record/z', 'record/é'])
  })

  it('rejects duplicate entity keys', () => {
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('schema', [positiveCases.schema.row, { ...positiveCases.schema.row }]),
      'RECOVERY_ARCHIVE_SECTION_ROWS_DUPLICATE_ENTITY_KEY',
    )
  })

  it('rejects source rows with missing or extra keys', () => {
    const { version: _version, ...missing } = positiveCases.records.row
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('records', [missing]),
      'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_KEYS',
    )
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('records', [{ ...positiveCases.records.row, extra: 'not admitted' }]),
      'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_KEYS',
    )
  })

  it('rejects non-enumerable, accessor, symbol, or hidden-extra row properties', () => {
    const nonEnumerableRequired = { ...positiveCases.records.row }
    Object.defineProperty(nonEnumerableRequired, 'record_id', {
      value: positiveCases.records.row.record_id,
      enumerable: false,
    })
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('records', [nonEnumerableRequired]),
      'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_ROW',
    )

    const hidden = { ...positiveCases.records.row }
    Object.defineProperty(hidden, 'hidden', { value: 'not admitted', enumerable: false })
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('records', [hidden]),
      'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_ROW',
    )

    const accessor = { ...positiveCases.records.row }
    Object.defineProperty(accessor, 'version', {
      enumerable: true,
      get: () => 4,
    })
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('records', [accessor]), 'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_ROW')

    const symbol = { ...positiveCases.records.row }
    Object.defineProperty(symbol, Symbol('not-admitted'), { value: true, enumerable: true })
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('records', [symbol]),
      'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_ROW',
    )
  })

  it('rejects non-enumerable, accessor, or symbol nested JSON properties', () => {
    for (const data of [
      defineNestedProperty({ visible: true }, 'hidden', { value: true, enumerable: false }),
      defineNestedProperty({ visible: true }, 'accessor', { enumerable: true, get: () => true }),
      defineNestedProperty({ visible: true }, Symbol('not-admitted'), { value: true, enumerable: true }),
    ]) {
      expectSectionRowsError(
        () => buildRecoveryArchiveSectionRows('records', [
          { record_id: 'record-nested', exists: true, version: 1, data },
        ]),
        'RECOVERY_ARCHIVE_SECTION_ROWS_UNSUPPORTED_JSON',
      )
    }
  })

  it('returns independent deep snapshots without value normalization', () => {
    const source = {
      record_id: 'record-1',
      exists: true,
      version: 4,
      data: { nested: { tags: ['one'] } },
    }
    const rows = buildRecoveryArchiveSectionRows('records', [source])
    source.data.nested.tags.push('two')
    source.data.nested = { tags: ['replaced'] }

    expect(rows).toEqual([
      {
        entity_key: 'record/record-1',
        payload: {
          record_id: 'record-1',
          exists: true,
          version: 4,
          data: { nested: { tags: ['one'] } },
        },
      },
    ])
  })

  it('snapshots proxy array lengths from descriptors without get traps', () => {
    let outerGetCalls = 0
    let nestedGetCalls = 0
    const nested = new Proxy(['retained'], {
      get: () => {
        nestedGetCalls += 1
        throw new Error('nested get must not run')
      },
    })
    const rows = new Proxy([
      { record_id: 'record-proxy', exists: true, version: 1, data: nested },
    ], {
      get: () => {
        outerGetCalls += 1
        throw new Error('outer get must not run')
      },
    })

    expect(buildRecoveryArchiveSectionRows('records', rows)).toEqual([
      {
        entity_key: 'record/record-proxy',
        payload: { record_id: 'record-proxy', exists: true, version: 1, data: ['retained'] },
      },
    ])
    expect(outerGetCalls).toBe(0)
    expect(nestedGetCalls).toBe(0)

    const secret = 'hostile-reflection-value-must-not-appear'
    const hostileRows = new Proxy([], {
      getOwnPropertyDescriptor: () => {
        throw new Error(secret)
      },
    })
    const hostileRowsError = expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('records', hostileRows),
      'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_ROWS',
    )
    expect(`${hostileRowsError.message}\n${hostileRowsError.stack}`).not.toContain(secret)

    const hostileData = new Proxy([], {
      getOwnPropertyDescriptor: () => {
        throw new Error(secret)
      },
    })
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('records', [
        { record_id: 'record-hostile', exists: true, version: 1, data: hostileData },
      ]),
      'RECOVERY_ARCHIVE_SECTION_ROWS_UNSUPPORTED_JSON',
    )
  })

  it('requires exact reflective own-key closure for outer and nested arrays', () => {
    const secret = 'fabricated-index-value-must-not-appear'
    const fabricatedRow = {
      record_id: secret,
      exists: true,
      version: 1,
      data: {},
    }
    const outerRows = proxyWithOmittedIndex(new Array(1), fabricatedRow)
    const outerError = expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('records', outerRows),
      'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_ROWS',
    )
    expect(`${outerError.message}\n${outerError.stack}`).not.toContain(secret)

    const nestedData = proxyWithOmittedIndex(new Array(1), secret)
    const nestedError = expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('records', [
        { record_id: 'record-nested-array', exists: true, version: 1, data: nestedData },
      ]),
      'RECOVERY_ARCHIVE_SECTION_ROWS_UNSUPPORTED_JSON',
    )
    expect(`${nestedError.message}\n${nestedError.stack}`).not.toContain(secret)
  })

  it('requires canonical nonnegative decimal attachment sizes', () => {
    const admitted = buildRecoveryArchiveSectionRows('attachments_index', [
      { ...positiveCases.attachments_index.row, attachment_id: 'attachment-zero', size_bytes: '0' },
      {
        ...positiveCases.attachments_index.row,
        attachment_id: 'attachment-large',
        size_bytes: '90071992547409931234567890',
      },
    ])
    expect(admitted.map((row) => row.payload.size_bytes)).toEqual(['90071992547409931234567890', '0'])

    for (const sizeBytes of ['01', '-1', 42]) {
      expectSectionRowsError(
        () => buildRecoveryArchiveSectionRows('attachments_index', [
          { ...positiveCases.attachments_index.row, size_bytes: sizeBytes },
        ]),
        'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_SEQ',
      )
    }
  })

  it('rejects wrong sections, malformed identities, and noncanonical decimal sequences', () => {
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('coverage_index', []),
      'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_SECTION',
    )
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('records', [{ ...positiveCases.records.row, record_id: '' }]),
      'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_IDENTITY',
    )
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('auto_number', [{ ...positiveCases.auto_number.row, next_value: '01' }]),
      'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_SEQ',
    )
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('permission_evidence', [{ ...positiveCases.permission_evidence.row, captured_at_seq: 1 }]),
      'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_SEQ',
    )
  })

  it('rejects invalid permission cardinality and record presence shapes', () => {
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('permission_evidence', [
        positiveCases.permission_evidence.row,
        { ...positiveCases.permission_evidence.row, authorized_scope_hash: 'scope-2' },
      ]),
      'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_ROWS',
    )
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('records', [
        { record_id: 'record-absent', exists: false, version: 1, data: {} },
      ]),
      'RECOVERY_ARCHIVE_SECTION_ROWS_INVALID_ROW',
    )
  })

  it('refuses unpaired UTF-16 surrogates without normalizing valid Unicode', () => {
    expect(buildRecoveryArchiveSectionRows('records', [
      { record_id: 'record-\uD83D\uDE00', exists: true, version: 1, data: {} },
    ])[0].entity_key).toBe('record/record-\uD83D\uDE00')
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('records', [
        { record_id: 'record-\uD800', exists: true, version: 1, data: {} },
      ]),
      'RECOVERY_ARCHIVE_SECTION_ROWS_UNSUPPORTED_JSON',
    )

    const data = Object.create(null) as Record<string, unknown>
    data['invalid-\uDC00'] = true
    expectSectionRowsError(
      () => buildRecoveryArchiveSectionRows('records', [
        { record_id: 'record-1', exists: true, version: 1, data },
      ]),
      'RECOVERY_ARCHIVE_SECTION_ROWS_UNSUPPORTED_JSON',
    )
  })

  it('refuses unsupported JSON with values-free typed errors', () => {
    const secret = 'caller-value-must-not-appear'
    let thrown: unknown
    try {
      buildRecoveryArchiveSectionRows('records', [{ ...positiveCases.records.row, data: { secret, invalid: Number.NaN } }])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(RecoveryArchiveSectionRowsError)
    expect((thrown as RecoveryArchiveSectionRowsError).code).toBe('RECOVERY_ARCHIVE_SECTION_ROWS_UNSUPPORTED_JSON')
    expect(`${(thrown as Error).message}\n${(thrown as Error).stack}`).not.toContain(secret)
  })
})

function expectSectionRowsError(
  operation: () => unknown,
  expectedCode: RecoveryArchiveSectionRowsErrorCode,
): RecoveryArchiveSectionRowsError {
  try {
    operation()
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryArchiveSectionRowsError)
    expect((error as RecoveryArchiveSectionRowsError).code).toBe(expectedCode)
    return error as RecoveryArchiveSectionRowsError
  }
  throw new Error(`expected ${expectedCode}`)
}

function defineNestedProperty(
  target: Record<PropertyKey, unknown>,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
): Record<PropertyKey, unknown> {
  Object.defineProperty(target, key, descriptor)
  return target
}

function proxyWithOmittedIndex<T>(target: unknown[], fabricatedValue: T): unknown[] {
  return new Proxy(target, {
    ownKeys: () => ['length'],
    getOwnPropertyDescriptor: (source, key) => {
      if (key === '0') {
        return {
          configurable: true,
          enumerable: true,
          value: fabricatedValue,
          writable: true,
        }
      }
      return Reflect.getOwnPropertyDescriptor(source, key)
    },
    get: () => {
      throw new Error('get trap must not run')
    },
  })
}
