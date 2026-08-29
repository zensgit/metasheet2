import { createHash } from 'node:crypto'

import { describe, expect, test } from 'vitest'

import { canonicalizeRecoveryArchiveJson } from '../../src/multitable/recovery-archive-manifest'
import {
  computeRecoveryArchiveSourceVectorHash,
  RECOVERY_ARCHIVE_SOURCE_VECTOR_DOMAIN,
  RECOVERY_ARCHIVE_SOURCE_VECTOR_FORMAT_VERSION,
  RECOVERY_ARCHIVE_SOURCE_VECTOR_HEAD_KEYS,
  RecoveryArchiveSourceVectorError,
} from '../../src/multitable/recovery-archive-source-vector'
import { SECTION_CAUSALITY_DATA_SECTION_KINDS } from '../../src/multitable/recovery-archive-seals'

const TWO_POW_53_PLUS_1 = '9007199254740993'
const DOMAIN_CODES = [...RECOVERY_ARCHIVE_SOURCE_VECTOR_DOMAIN].map((char) => char.charCodeAt(0))

const GOLDEN_BODY =
  '{"format_version":1,"heads":[{"head_seq":"101","operation_id":"00000000-0000-4000-8000-000000000001","section_kind":"schema","source_head_kind":"section_bootstrap"},{"head_seq":"102","operation_id":"00000000-0000-4000-8000-000000000002","section_kind":"records","source_head_kind":"section_bootstrap"},{"head_seq":"103","operation_id":"00000000-0000-4000-8000-000000000003","section_kind":"links","source_head_kind":"section_bootstrap"},{"head_seq":"104","operation_id":"00000000-0000-4000-8000-000000000004","section_kind":"field_value_tombstones","source_head_kind":"section_bootstrap"},{"head_seq":"105","operation_id":"00000000-0000-4000-8000-000000000005","section_kind":"link_tombstones","source_head_kind":"section_bootstrap"},{"head_seq":"106","operation_id":"00000000-0000-4000-8000-000000000006","section_kind":"auto_number","source_head_kind":"section_bootstrap"},{"head_seq":"107","operation_id":"00000000-0000-4000-8000-000000000007","section_kind":"attachments_index","source_head_kind":"section_bootstrap"},{"head_seq":"108","operation_id":"00000000-0000-4000-8000-000000000008","section_kind":"permission_evidence","source_head_kind":"section_bootstrap"},{"head_seq":"109","operation_id":"00000000-0000-4000-8000-000000000009","section_kind":"views_config","source_head_kind":"section_bootstrap"}]}'
const GOLDEN_HASH = '924a8b53b98f0b84f1e55e25ae5848bccd1bbd67ffe6979fa3f558d199556356'

function heads(overrides: Array<Record<string, unknown> | undefined> = []) {
  return SECTION_CAUSALITY_DATA_SECTION_KINDS.map((sectionKind, index) => ({
    sourceHeadKind: 'section_bootstrap',
    sectionKind,
    operationId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    headSeq: String(101 + index),
    ...overrides[index],
  }))
}

function expectCode(fn: () => void, code: string) {
  expect(fn).toThrow(RecoveryArchiveSourceVectorError)
  try {
    fn()
  } catch (error) {
    expect(error).toMatchObject({ code, message: code })
  }
}

describe('Time Machine D2 source-vector hash', () => {
  test('pins domain, format version, and exact head key set', () => {
    expect(RECOVERY_ARCHIVE_SOURCE_VECTOR_FORMAT_VERSION).toBe(1)
    expect(RECOVERY_ARCHIVE_SOURCE_VECTOR_DOMAIN).toBe(
      'metasheet2:multitable:recovery-archive:source-vector:v1',
    )
    expect(RECOVERY_ARCHIVE_SOURCE_VECTOR_DOMAIN).toHaveLength(55)
    expect(DOMAIN_CODES).toEqual([
      109, 101, 116, 97, 115, 104, 101, 101, 116, 50, 58, 109, 117, 108, 116, 105, 116, 97, 98, 108,
      101, 58, 114, 101, 99, 111, 118, 101, 114, 121, 45, 97, 114, 99, 104, 105, 118, 101, 58, 115,
      111, 117, 114, 99, 101, 45, 118, 101, 99, 116, 111, 114, 58, 118, 49,
    ])
    expect(RECOVERY_ARCHIVE_SOURCE_VECTOR_HEAD_KEYS).toEqual([
      'sourceHeadKind',
      'sectionKind',
      'operationId',
      'headSeq',
    ])
    expect(Object.isFrozen(RECOVERY_ARCHIVE_SOURCE_VECTOR_HEAD_KEYS)).toBe(true)
    expect(() => {
      ;(RECOVERY_ARCHIVE_SOURCE_VECTOR_HEAD_KEYS as unknown as string[]).pop()
    }).toThrow(TypeError)
  })

  test('pins format-v1 preimage, lowercase hash, and immutable snapshots', () => {
    const result = computeRecoveryArchiveSourceVectorHash(heads())
    const expectedBody = canonicalizeRecoveryArchiveJson({
      format_version: 1,
      heads: heads().map((head) => ({
        source_head_kind: head.sourceHeadKind,
        section_kind: head.sectionKind,
        operation_id: head.operationId,
        head_seq: head.headSeq,
      })),
    })
    expect(expectedBody).toBe(GOLDEN_BODY)
    expect(result.formatVersion).toBe(1)
    expect(result.preimage).toBe(`${RECOVERY_ARCHIVE_SOURCE_VECTOR_DOMAIN}\u0000${GOLDEN_BODY}`)
    expect(result.preimage).toBe(`${RECOVERY_ARCHIVE_SOURCE_VECTOR_DOMAIN}\u0000${expectedBody}`)
    expect(result.hash).toBe(GOLDEN_HASH)
    expect(result.hash).toBe(createHash('sha256').update(result.preimage, 'utf8').digest('hex'))
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.hash).not.toMatch(/[A-F]/)

    const body = JSON.parse(result.preimage.slice(RECOVERY_ARCHIVE_SOURCE_VECTOR_DOMAIN.length + 1))
    expect(Object.keys(body).sort()).toEqual(['format_version', 'heads'])
    expect(body.heads).toHaveLength(9)
    for (const head of body.heads as Array<Record<string, unknown>>) {
      expect(Object.keys(head).sort()).toEqual([
        'head_seq',
        'operation_id',
        'section_kind',
        'source_head_kind',
      ])
      expect(head).not.toHaveProperty('row_count')
      expect(head).not.toHaveProperty('source_hash')
      expect(head).not.toHaveProperty('provider')
      expect(head).not.toHaveProperty('object_id')
    }

    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.heads)).toBe(true)
    expect(result.heads.every((head) => Object.isFrozen(head))).toBe(true)
    expect(() => {
      ;(result.heads as unknown as unknown[]).pop()
    }).toThrow(TypeError)
    expect(() => {
      ;(result.heads[0] as { headSeq: string }).headSeq = '1'
    }).toThrow(TypeError)
  })

  test('domain separator, section order, and one head field are load-bearing', () => {
    const result = computeRecoveryArchiveSourceVectorHash(heads())
    expect(result.preimage.startsWith(`${RECOVERY_ARCHIVE_SOURCE_VECTOR_DOMAIN}\u0000`)).toBe(true)
    expect(result.hash).not.toBe(createHash('sha256').update(GOLDEN_BODY, 'utf8').digest('hex'))
    const bodyJson = result.preimage.slice(RECOVERY_ARCHIVE_SOURCE_VECTOR_DOMAIN.length + 1)
    expect(bodyJson).toBe(GOLDEN_BODY)
    expect(result.hash).not.toBe(createHash('sha256').update(bodyJson, 'utf8').digest('hex'))

    const reordered = heads()
    const first = reordered[0]
    const second = reordered[1]
    if (first === undefined || second === undefined) throw new Error('expected_two_heads')
    ;[reordered[0], reordered[1]] = [
      { ...first, sectionKind: second.sectionKind },
      { ...second, sectionKind: first.sectionKind },
    ]
    expectCode(
      () => computeRecoveryArchiveSourceVectorHash(reordered),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_SECTION_MISMATCH',
    )

    const mutated = computeRecoveryArchiveSourceVectorHash(
      heads([{ operationId: '00000000-0000-4000-8000-000000000099' }]),
    )
    expect(mutated.hash).not.toBe(result.hash)
  })

  test('exact section order and D2c bootstrap-only heads are required', () => {
    expect(computeRecoveryArchiveSourceVectorHash(heads()).heads.map((head) => head.sectionKind)).toEqual(
      [...SECTION_CAUSALITY_DATA_SECTION_KINDS],
    )

    expectCode(
      () => computeRecoveryArchiveSourceVectorHash(heads().slice(0, 8)),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEADS',
    )
    expectCode(
      () =>
        computeRecoveryArchiveSourceVectorHash([
          ...heads(),
          {
            sourceHeadKind: 'section_bootstrap',
            sectionKind: 'schema',
            operationId: '00000000-0000-4000-8000-000000000010',
            headSeq: '110',
          },
        ]),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEADS',
    )

    for (const kind of ['ordinary', 'restore_chunk', 'restore_aggregate', 'unknown']) {
      expectCode(
        () => computeRecoveryArchiveSourceVectorHash(heads([{ sourceHeadKind: kind }])),
        'RECOVERY_ARCHIVE_SOURCE_VECTOR_UNKNOWN_KIND',
      )
    }

    expectCode(
      () => computeRecoveryArchiveSourceVectorHash(heads([{ sectionKind: 'coverage_index' }])),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_UNKNOWN_KIND',
    )
    expectCode(
      () => computeRecoveryArchiveSourceVectorHash(heads([{ sectionKind: 'records' }])),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_SECTION_MISMATCH',
    )
  })

  test('missing, extra, duplicate, and non-decimal identities refuse', () => {
    const missing = heads()
    delete missing[0]?.sourceHeadKind
    expectCode(
      () => computeRecoveryArchiveSourceVectorHash(missing),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_KEYS',
    )
    expectCode(
      () => computeRecoveryArchiveSourceVectorHash(heads([{ row_count: '0' }])),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_KEYS',
    )
    expectCode(
      () =>
        computeRecoveryArchiveSourceVectorHash(
          heads([{ sourceHash: 'a'.repeat(64) }]),
        ),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_KEYS',
    )
    expectCode(
      () =>
        computeRecoveryArchiveSourceVectorHash(
          heads([undefined, { operationId: '00000000-0000-4000-8000-000000000001' }]),
        ),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_DUPLICATE_IDENTITY',
    )
    expectCode(
      () => computeRecoveryArchiveSourceVectorHash(heads([undefined, { headSeq: '101' }])),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_DUPLICATE_IDENTITY',
    )
    expectCode(
      () => computeRecoveryArchiveSourceVectorHash(heads([{ headSeq: 101 }])),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEAD',
    )
    expectCode(
      () => computeRecoveryArchiveSourceVectorHash(heads([{ headSeq: '01' }])),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEAD',
    )
    expectCode(
      () => computeRecoveryArchiveSourceVectorHash(heads([{ operationId: 'OP-1' }])),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEAD',
    )
  })

  test('retains bigint decimal head seq strings above 2^53 without Number', () => {
    const result = computeRecoveryArchiveSourceVectorHash(
      heads(
        SECTION_CAUSALITY_DATA_SECTION_KINDS.map((_, index) => ({
          headSeq: String(BigInt(TWO_POW_53_PLUS_1) + BigInt(index)),
        })),
      ),
    )
    expect(result.heads[0]?.headSeq).toBe(TWO_POW_53_PLUS_1)
    expect(result.preimage).toContain(`"head_seq":"${TWO_POW_53_PLUS_1}"`)
    expect(result.heads[0]?.headSeq).not.toBe(String(Number(TWO_POW_53_PLUS_1)))
  })

  test('non-plain, hostile accessor, symbol, and proxy heads refuse', () => {
    class Head {
      sourceHeadKind = 'section_bootstrap'
      sectionKind = 'schema'
      operationId = '00000000-0000-4000-8000-000000000001'
      headSeq = '101'
    }
    for (const bad of [null, undefined, 1, 'heads', {}, new Date(0), new Map()]) {
      expectCode(
        () => computeRecoveryArchiveSourceVectorHash(bad),
        'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEADS',
      )
    }
    const classHeads = heads()
    classHeads[0] = new Head() as (typeof classHeads)[0]
    expectCode(
      () => computeRecoveryArchiveSourceVectorHash(classHeads),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEAD',
    )

    const accessor = heads()
    Object.defineProperty(accessor[0] as object, 'headSeq', {
      enumerable: true,
      get: () => '101',
    })
    expectCode(
      () => computeRecoveryArchiveSourceVectorHash(accessor),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEAD',
    )

    const symbolHead = heads()
    Object.defineProperty(symbolHead[0] as object, Symbol('extra'), { enumerable: true, value: 'x' })
    expectCode(
      () => computeRecoveryArchiveSourceVectorHash(symbolHead),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEAD',
    )

    const symbolArray = heads()
    Object.defineProperty(symbolArray, Symbol('extra'), { enumerable: true, value: 'x' })
    expectCode(
      () => computeRecoveryArchiveSourceVectorHash(symbolArray),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEADS',
    )

    const revoked = Proxy.revocable(heads(), {})
    revoked.revoke()
    expectCode(
      () => computeRecoveryArchiveSourceVectorHash(revoked.proxy),
      'RECOVERY_ARCHIVE_SOURCE_VECTOR_INVALID_HEADS',
    )

    const later = heads()
    let reads = 0
    const proxyHead = new Proxy(later[0] as object, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        if (key === 'headSeq' && descriptor && 'value' in descriptor) {
          reads += 1
          return { ...descriptor, value: reads === 1 ? '101' : '999' }
        }
        return descriptor
      },
    })
    later[0] = proxyHead as (typeof later)[0]
    const snapshotted = computeRecoveryArchiveSourceVectorHash(later)
    expect(snapshotted.heads[0]?.headSeq).toBe('101')
    expect(snapshotted.preimage).toContain('"head_seq":"101"')
    expect(snapshotted.preimage).not.toContain('"head_seq":"999"')
  })

  test('null-prototype ordinary data descriptors still hash', () => {
    const nullProto = heads().map((head) => Object.assign(Object.create(null), head))
    expect(computeRecoveryArchiveSourceVectorHash(nullProto).hash).toBe(GOLDEN_HASH)
  })
})
