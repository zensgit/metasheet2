import { createHash } from 'node:crypto'

import { describe, expect, test } from 'vitest'

import {
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  type RecoveryArchiveSectionName,
} from '../../src/multitable/recovery-archive-contract'
import {
  buildRecoveryArchiveManifest,
  canonicalizeRecoveryArchiveJson,
  canonicalizeRecoveryArchiveSectionRows,
  RecoveryArchiveManifestError,
  validateRecoveryArchiveManifest,
  type RecoveryArchiveManifestBinding,
  type RecoveryArchiveRowEnvelope,
  type RecoveryArchiveSectionBuildInput,
  type RecoveryArchiveSectionCryptoDescriptor,
} from '../../src/multitable/recovery-archive-manifest'

const SHA256_A = 'a'.repeat(64)
const SHA256_B = 'b'.repeat(64)
const TWO_POW_53_PLUS_1 = '9007199254740993'

const BINDING: RecoveryArchiveManifestBinding = {
  archive_generation_id: 'gen-0001',
  workspace_id: 'ws-0001',
  base_id: 'base-0001',
  sheet_id: 'sheet-0001',
  anchor_operation_id: 'op-0001',
  anchor_seq: TWO_POW_53_PLUS_1,
  checkpoint_id: 'ckpt-0001',
  created_at: '2026-08-26T00:00:00.000Z',
  expires_at: null,
  source_vector_hash: SHA256_A,
}

const SCHEMA_ROW: RecoveryArchiveRowEnvelope = {
  entity_key: 'field/f1',
  payload: { field_id: 'f1', name: 'Amount', type: 'number', property: { scale: 2 }, order: 1 },
}

const RECORD_ROW_NESTED: RecoveryArchiveRowEnvelope = {
  entity_key: 'record/r1',
  payload: {
    record_id: 'r1',
    exists: true,
    version: '7',
    data: { cells: [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 5 }], big: '123456789012345678901234567890' },
  },
}

const CRYPTO: RecoveryArchiveSectionCryptoDescriptor = {
  aead_algorithm: 'aes-256-gcm',
  key_id: 'kms-key-0001',
  wrapped_dek_id: 'wdek-0001',
  dek_fingerprint: 'c'.repeat(64),
  nonce: 'a1b2c3d4e5f60718293a4b5c',
}

function sectionsWith(
  overrides: Partial<Record<RecoveryArchiveSectionName, readonly RecoveryArchiveRowEnvelope[]>> = {},
): RecoveryArchiveSectionBuildInput[] {
  return RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((name) => ({
    name,
    rows: overrides[name] ?? [],
    ...CRYPTO,
  }))
}

function goldenSections(): RecoveryArchiveSectionBuildInput[] {
  return sectionsWith({ schema: [SCHEMA_ROW], records: [RECORD_ROW_NESTED] })
}

function expectManifestError(fn: () => void, code: string) {
  expect(fn).toThrow(RecoveryArchiveManifestError)
  try {
    fn()
  } catch (error) {
    expect(error).toMatchObject({ code, message: code })
  }
}

describe('Time Machine D2g manifest canonicalization determinism', () => {
  test('object key insertion order does not change identity (property invariance)', () => {
    const rowA: RecoveryArchiveRowEnvelope = {
      entity_key: 'record/r1',
      payload: { record_id: 'r1', exists: true, version: '7', data: { f1: 'a', f2: 1 } },
    }
    const rowB: RecoveryArchiveRowEnvelope = {
      entity_key: 'record/r1',
      payload: { data: { f2: 1, f1: 'a' }, version: '7', exists: true, record_id: 'r1' },
    }
    const first = buildRecoveryArchiveManifest(BINDING, sectionsWith({ records: [rowA] }))
    const second = buildRecoveryArchiveManifest(BINDING, sectionsWith({ records: [rowB] }))
    expect(second.manifestJson).toBe(first.manifestJson)
    expect(second.manifest.root_hash).toBe(first.manifest.root_hash)
  })

  test('pretty-printed and compact JSON canonicalize to the same bytes', () => {
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())
    const pretty = JSON.stringify(JSON.parse(built.manifestJson), null, 2)
    expect(pretty).not.toBe(built.manifestJson)
    expect(canonicalizeRecoveryArchiveJson(JSON.parse(pretty))).toBe(built.manifestJson)
    expect(canonicalizeRecoveryArchiveJson(JSON.parse(built.manifestJson))).toBe(built.manifestJson)
  })

  test('stored manifest round-trips through fail-closed validation', () => {
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections(), 'mac-placeholder')
    const parsed = validateRecoveryArchiveManifest(JSON.parse(built.manifestJson))
    expect(parsed).toEqual(built.manifest)
  })
})

describe('Time Machine D2g closed section set', () => {
  test('reordered sections refuse per contract instead of being normalized', () => {
    const reordered = goldenSections()
    ;[reordered[0], reordered[1]] = [reordered[1], reordered[0]]
    expectManifestError(
      () => buildRecoveryArchiveManifest(BINDING, reordered),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTIONS',
    )
  })

  test('duplicate, unknown, and missing sections refuse', () => {
    const duplicate = goldenSections()
    duplicate[1] = { name: 'schema', rows: [], ...CRYPTO }
    expectManifestError(
      () => buildRecoveryArchiveManifest(BINDING, duplicate),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTIONS',
    )

    const unknown = goldenSections()
    unknown[9] = { name: 'not_a_section' as never, rows: [], ...CRYPTO }
    expectManifestError(
      () => buildRecoveryArchiveManifest(BINDING, unknown),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTIONS',
    )

    expectManifestError(
      () => buildRecoveryArchiveManifest(BINDING, goldenSections().slice(0, 9)),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTIONS',
    )
  })

  test('duplicate entity_key within a section refuses', () => {
    const rows = [SCHEMA_ROW, { ...SCHEMA_ROW, payload: { ...SCHEMA_ROW.payload, order: 2 } }]
    expectManifestError(
      () => buildRecoveryArchiveManifest(BINDING, sectionsWith({ schema: rows })),
      'RECOVERY_ARCHIVE_MANIFEST_DUPLICATE_ENTITY_KEY',
    )
  })
})

describe('Time Machine D2g logical row semantics and bigint fidelity', () => {
  test('nested arrays/objects are one logical row, never recursively counted', () => {
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())
    const records = built.manifest.sections[1]
    expect(records.name).toBe('records')
    expect(records.row_count).toBe('1')
  })

  test('decimal strings above 2^53 stay exact in binding and payload', () => {
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())
    expect(built.manifestJson).toContain(`"anchor_seq":"${TWO_POW_53_PLUS_1}"`)
    expect(built.manifest.anchor_seq).toBe(TWO_POW_53_PLUS_1)
    const section = canonicalizeRecoveryArchiveSectionRows('records', [RECORD_ROW_NESTED])
    expect(section.canonicalJson).toContain('"big":"123456789012345678901234567890"')
    expect(section.plaintextSha256).toBe(built.manifest.sections[1].plaintext_sha256)
  })
})

describe('Time Machine D2g root hash binding and discriminating golden', () => {
  // Pinned on parent 8cccbdf790 for the exact fixture above; any change to the
  // preimage shape (including smuggling root_hash/manifest_mac into it) reds this golden.
  const EXPECTED_ROOT_HASH = '6dc7ea77d6d2b7a768f5dd6c5db8059b8aaff1abefcec6c46520df583a1ed868'

  test('root hash matches the pinned golden and preimage excludes root_hash/manifest_mac', () => {
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())
    expect(built.bodyJson).not.toContain('"root_hash"')
    expect(built.bodyJson).not.toContain('"manifest_mac"')
    expect(built.manifest.root_hash).toBe(EXPECTED_ROOT_HASH)
    expect(built.manifest.root_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(createHash('sha256').update(built.bodyJson, 'utf8').digest('hex')).toBe(
      built.manifest.root_hash,
    )
  })

  test('a preimage that included root_hash or manifest_mac would hash differently', () => {
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())
    const tampered = { ...JSON.parse(built.bodyJson), root_hash: built.manifest.root_hash }
    expect(createHash('sha256').update(canonicalizeRecoveryArchiveJson(tampered), 'utf8').digest('hex')).not.toBe(
      EXPECTED_ROOT_HASH,
    )
  })

  test('changing any row, binding field, or section count changes the root hash', () => {
    const base = buildRecoveryArchiveManifest(BINDING, goldenSections()).manifest.root_hash

    const rowMutant = goldenSections()
    rowMutant[1] = {
      name: 'records',
      rows: [{ ...RECORD_ROW_NESTED, payload: { ...RECORD_ROW_NESTED.payload, version: '8' } }],
      ...CRYPTO,
    }
    expect(buildRecoveryArchiveManifest(BINDING, rowMutant).manifest.root_hash).not.toBe(base)

    const bindingMutant = buildRecoveryArchiveManifest(
      { ...BINDING, checkpoint_id: 'ckpt-0002' },
      goldenSections(),
    )
    expect(bindingMutant.manifest.root_hash).not.toBe(base)

    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())
    const stored = JSON.parse(built.manifestJson)
    stored.sections[1].row_count = '2'
    expectManifestError(
      () => validateRecoveryArchiveManifest(stored),
      'RECOVERY_ARCHIVE_MANIFEST_ROOT_HASH_MISMATCH',
    )
  })
})

describe('Time Machine D2g fail-closed guards (each targets one guard)', () => {
  test('non-finite numbers refuse', () => {
    const row: RecoveryArchiveRowEnvelope = {
      entity_key: 'record/r1',
      payload: { record_id: 'r1', exists: true, version: '1', data: { v: Number.NaN } },
    }
    expectManifestError(
      () => buildRecoveryArchiveManifest(BINDING, sectionsWith({ records: [row] })),
      'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
    )
  })

  test('bigint primitives refuse; only decimal strings carry big integers', () => {
    const row: RecoveryArchiveRowEnvelope = {
      entity_key: 'record/r1',
      payload: { record_id: 'r1', exists: true, version: 1n as never, data: null as never },
    }
    expectManifestError(
      () => buildRecoveryArchiveManifest(BINDING, sectionsWith({ records: [row] })),
      'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
    )
  })

  test('cyclic structures refuse', () => {
    const cyclic: Record<string, unknown> = { record_id: 'r1' }
    cyclic.self = cyclic
    const row: RecoveryArchiveRowEnvelope = { entity_key: 'record/r1', payload: cyclic }
    expectManifestError(
      () => buildRecoveryArchiveManifest(BINDING, sectionsWith({ records: [row] })),
      'RECOVERY_ARCHIVE_MANIFEST_CYCLIC_JSON',
    )
  })

  test('unknown envelope keys and non-object payloads refuse', () => {
    expectManifestError(
      () =>
        buildRecoveryArchiveManifest(
          BINDING,
          sectionsWith({ records: [{ ...RECORD_ROW_NESTED, extra: 1 } as never] }),
        ),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_ROW_ENVELOPE',
    )
    expectManifestError(
      () =>
        buildRecoveryArchiveManifest(
          BINDING,
          sectionsWith({ records: [{ entity_key: 'record/r1', payload: [1] as never }] }),
        ),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_ROW_ENVELOPE',
    )
  })

  test('wrong entity_key prefix and unknown coverage source kind refuse', () => {
    expectManifestError(
      () =>
        buildRecoveryArchiveManifest(
          BINDING,
          sectionsWith({ records: [{ entity_key: 'field/f1', payload: {} }] }),
        ),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_ENTITY_KEY',
    )
    expectManifestError(
      () =>
        buildRecoveryArchiveManifest(
          BINDING,
          sectionsWith({ coverage_index: [{ entity_key: 'coverage/bogus/x', payload: {} }] }),
        ),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_ENTITY_KEY',
    )
  })

  test('unknown top-level manifest keys refuse on validate', () => {
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())
    const stored = { ...JSON.parse(built.manifestJson), injected: true }
    expectManifestError(
      () => validateRecoveryArchiveManifest(stored),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SHAPE',
    )
  })

  test('non-v1 format_version refuses', () => {
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())
    const stored = { ...JSON.parse(built.manifestJson), format_version: 2 }
    expectManifestError(
      () => validateRecoveryArchiveManifest(stored),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_FORMAT_VERSION',
    )
  })

  test('non-canonical timestamps refuse', () => {
    expectManifestError(
      () => buildRecoveryArchiveManifest({ ...BINDING, created_at: '2026-08-26T00:00:00Z' }, goldenSections()),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_TIMESTAMP',
    )
    expectManifestError(
      () => buildRecoveryArchiveManifest({ ...BINDING, expires_at: 'not-a-date' }, goldenSections()),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_TIMESTAMP',
    )
  })

  test('tampered section hash and tampered binding refuse on validate', () => {
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())
    const hashTampered = JSON.parse(built.manifestJson)
    hashTampered.sections[0].plaintext_sha256 = SHA256_B
    expectManifestError(
      () => validateRecoveryArchiveManifest(hashTampered),
      'RECOVERY_ARCHIVE_MANIFEST_ROOT_HASH_MISMATCH',
    )

    const bindingTampered = JSON.parse(built.manifestJson)
    bindingTampered.sheet_id = 'sheet-0002'
    expectManifestError(
      () => validateRecoveryArchiveManifest(bindingTampered),
      'RECOVERY_ARCHIVE_MANIFEST_ROOT_HASH_MISMATCH',
    )
  })
})

describe('Time Machine D2g owner-review gap 1: full v1 crypto descriptor required', () => {
  const CRYPTO_KEYS = [
    'aead_algorithm',
    'key_id',
    'wrapped_dek_id',
    'dek_fingerprint',
    'nonce',
  ] as const

  test('positive control: all five crypto fields build and validate', () => {
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())
    for (const key of CRYPTO_KEYS) {
      expect(built.manifest.sections[0][key]).toBe(CRYPTO[key])
    }
    expect(() => validateRecoveryArchiveManifest(JSON.parse(built.manifestJson))).not.toThrow()
  })

  test.each(CRYPTO_KEYS)('build refuses when crypto field %s is missing', (missing) => {
    const sections = goldenSections()
    const crypto = { ...CRYPTO } as Record<string, unknown>
    delete crypto[missing]
    sections[3] = { name: 'field_value_tombstones', rows: [], ...crypto } as never
    expectManifestError(
      () => buildRecoveryArchiveManifest(BINDING, sections),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTIONS',
    )
  })

  test.each(CRYPTO_KEYS)('validate refuses when crypto field %s is missing or empty', (missing) => {
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())

    const absent = JSON.parse(built.manifestJson)
    delete absent.sections[2][missing]
    expectManifestError(
      () => validateRecoveryArchiveManifest(absent),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTION_DESCRIPTOR',
    )

    const empty = JSON.parse(built.manifestJson)
    empty.sections[2][missing] = ''
    expectManifestError(
      () => validateRecoveryArchiveManifest(empty),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTION_DESCRIPTOR',
    )
  })

  test('build refuses a section with zero crypto metadata', () => {
    const sections = goldenSections()
    sections[0] = { name: 'schema', rows: [SCHEMA_ROW] } as never
    expectManifestError(
      () => buildRecoveryArchiveManifest(BINDING, sections),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTIONS',
    )
  })
})

describe('Time Machine D2g owner-review gap 2: plain objects only', () => {
  test('positive control: plain objects and null-prototype objects canonicalize', () => {
    const nullProto = Object.create(null) as Record<string, unknown>
    nullProto.k = [1, { nested: true }]
    expect(canonicalizeRecoveryArchiveJson({ a: 1, b: nullProto })).toBe(
      '{"a":1,"b":{"k":[1,{"nested":true}]}}',
    )
  })

  test('Date, Map, and class instances refuse instead of projecting to {}', () => {
    class Payload { field = 1 }
    for (const bad of [new Date(0), new Map([['k', 'v']]), new Payload()]) {
      expectManifestError(
        () => canonicalizeRecoveryArchiveJson({ data: bad }),
        'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
      )
    }
    // Discriminating: without the prototype guard these would all collapse to '{}'.
    expect(JSON.stringify({ data: new Date(0) })).not.toBe(
      canonicalizeRecoveryArchiveJson({ data: {} }),
    )
  })

  test('class instances inside section row payloads refuse at build', () => {
    class Row { record_id = 'r1' }
    const row: RecoveryArchiveRowEnvelope = { entity_key: 'record/r1', payload: new Row() }
    expectManifestError(
      () => buildRecoveryArchiveManifest(BINDING, sectionsWith({ records: [row] })),
      'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
    )
  })
})

describe('Time Machine D2g owner-review gap 3: sparse arrays refuse', () => {
  test('positive control: dense arrays canonicalize with explicit nulls', () => {
    expect(canonicalizeRecoveryArchiveJson([1, null, 'x'])).toBe('[1,null,"x"]')
  })

  test('sparse arrays refuse at every depth', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparseTop = [1, , 3]
    expectManifestError(
      () => canonicalizeRecoveryArchiveJson(sparseTop),
      'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
    )
    // eslint-disable-next-line no-sparse-arrays
    const sparseNested = { cells: [,] }
    expectManifestError(
      () => canonicalizeRecoveryArchiveJson(sparseNested),
      'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
    )
    // Discriminating: without the guard, map() skips holes and emits invalid '[,,]'.
    // eslint-disable-next-line no-sparse-arrays
    expect(JSON.stringify([, ,])).toBe('[null,null]')
    // eslint-disable-next-line no-sparse-arrays
    expect([, ,].map(() => 'x').join(',')).toBe(',')
  })

  test('sparse rows array refuses at build', () => {
    const sections = goldenSections()
    // eslint-disable-next-line no-sparse-arrays
    sections[1] = { name: 'records', rows: [RECORD_ROW_NESTED, ,] as never, ...CRYPTO }
    expectManifestError(
      () => buildRecoveryArchiveManifest(BINDING, sections),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_ROW_ENVELOPE',
    )
  })

  test('a hole balanced by an extra enumerable key still refuses', () => {
    // The old count-only guard passes here: keys ['0','2','extra'].length === length 3.
    // eslint-disable-next-line no-sparse-arrays
    const holePlusExtra: unknown[] = [1, , 3]
    ;(holePlusExtra as Record<string, unknown>).extra = 'x'
    expect(Object.keys(holePlusExtra).length).toBe(holePlusExtra.length)
    expectManifestError(
      () => canonicalizeRecoveryArchiveJson(holePlusExtra),
      'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
    )
  })

  test('enumerable symbol keys on arrays refuse even at matching count', () => {
    const withSymbol: unknown[] = [1, 2]
    ;(withSymbol as Record<symbol, unknown>)[Symbol('extra')] = 'x'
    expect(Object.keys(withSymbol).length).toBe(withSymbol.length)
    expectManifestError(
      () => canonicalizeRecoveryArchiveJson(withSymbol),
      'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
    )
  })
})

describe('Time Machine D2g owner-review gap 4: unpaired surrogates refuse', () => {
  test('positive control: paired surrogate pairs and BMP strings canonicalize', () => {
    expect(canonicalizeRecoveryArchiveJson({ emoji: '💾', bmp: 'é' })).toBe('{"bmp":"é","emoji":"💾"}')
  })

  test('lone high and low surrogates refuse in keys and values', () => {
    expectManifestError(
      () => canonicalizeRecoveryArchiveJson({ data: 'lone-high-\uD83D' }),
      'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
    )
    expectManifestError(
      () => canonicalizeRecoveryArchiveJson({ data: '\uDE00-lone-low' }),
      'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
    )
    expectManifestError(
      () => canonicalizeRecoveryArchiveJson({ '\uD83D': 1 }),
      'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
    )
    // Truncated pair at end of string (high surrogate with nothing after) refuses.
    expectManifestError(
      () => canonicalizeRecoveryArchiveJson('\uD83D'),
      'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
    )
  })

  test('distinct invalid strings cannot collapse to one canonical byte sequence', () => {
    // Without the guard, TextEncoder replaces each lone surrogate with U+FFFD and
    // these two distinct entity keys would sort/compare identically downstream.
    const first = 'record/\uD83D'
    const second = 'record/\uD83E'
    expect(first).not.toBe(second)
    for (const key of [first, second]) {
      expectManifestError(
        () =>
          buildRecoveryArchiveManifest(
            BINDING,
            sectionsWith({ records: [{ entity_key: key, payload: { record_id: 'r1' } }] }),
          ),
        'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
      )
    }
  })
})

describe('Time Machine D2g owner second-pass: plain-record exact keys at schema boundaries', () => {
  test('positive control: null-prototype stored manifest still validates', () => {
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())
    const stored = Object.assign(Object.create(null), JSON.parse(built.manifestJson))
    expect(validateRecoveryArchiveManifest(stored).root_hash).toBe(built.manifest.root_hash)
  })

  test('stored manifest as a class instance refuses', () => {
    class StoredManifest {}
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())
    const stored = Object.assign(new StoredManifest(), JSON.parse(built.manifestJson))
    expect(Object.keys(stored).length).toBe(Object.keys(JSON.parse(built.manifestJson)).length)
    expectManifestError(
      () => validateRecoveryArchiveManifest(stored),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SHAPE',
    )
  })

  test('enumerable symbol keys refuse at manifest, section, and envelope layers', () => {
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())

    const manifestSymbol = JSON.parse(built.manifestJson)
    manifestSymbol[Symbol('injected')] = 1
    expectManifestError(
      () => validateRecoveryArchiveManifest(manifestSymbol),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SHAPE',
    )

    const sectionSymbol = JSON.parse(built.manifestJson)
    sectionSymbol.sections[0][Symbol('injected')] = 1
    expectManifestError(
      () => validateRecoveryArchiveManifest(sectionSymbol),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTION_DESCRIPTOR',
    )

    const rowSymbol: Record<string | symbol, unknown> = {
      entity_key: 'record/r1',
      payload: { record_id: 'r1' },
    }
    rowSymbol[Symbol('injected')] = 1
    expectManifestError(
      () =>
        buildRecoveryArchiveManifest(
          BINDING,
          sectionsWith({ records: [rowSymbol as RecoveryArchiveRowEnvelope] }),
        ),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_ROW_ENVELOPE',
    )
  })

  test('class instances refuse at section and envelope layers too', () => {
    class StoredSection {}
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())
    const sectionStored = JSON.parse(built.manifestJson)
    sectionStored.sections[0] = Object.assign(new StoredSection(), sectionStored.sections[0])
    expectManifestError(
      () => validateRecoveryArchiveManifest(sectionStored),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTION_DESCRIPTOR',
    )

    class RowEnvelope {
      entity_key = 'record/r1'
      payload = { record_id: 'r1' }
    }
    expectManifestError(
      () =>
        buildRecoveryArchiveManifest(BINDING, sectionsWith({ records: [new RowEnvelope()] })),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_ROW_ENVELOPE',
    )
  })
})

describe('Time Machine D2g owner second-pass: v1 crypto admission shape (D2h-aligned)', () => {
  const BAD_CRYPTO_VALUES: ReadonlyArray<[string, string]> = [
    ['aead_algorithm', 'aes-128-gcm'],
    ['aead_algorithm', 'AES-256-GCM'],
    ['dek_fingerprint', 'C'.repeat(64)],
    ['dek_fingerprint', 'c'.repeat(63)],
    ['nonce', 'bm9uY2UtMDAwMQ'],
    ['nonce', 'A1B2C3D4E5F60718293A4B5C'],
    ['nonce', 'a1b2c3d4e5f60718293a4b5'],
    ['key_id', '   '],
    ['wrapped_dek_id', ''],
  ]

  test.each(BAD_CRYPTO_VALUES)('build refuses non-admitted %s value', (field, badValue) => {
    const sections = goldenSections()
    sections[4] = { ...sections[4], [field]: badValue }
    expectManifestError(
      () => buildRecoveryArchiveManifest(BINDING, sections),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTION_DESCRIPTOR',
    )
  })

  test.each(BAD_CRYPTO_VALUES)('validate refuses stored non-admitted %s value', (field, badValue) => {
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())
    const stored = JSON.parse(built.manifestJson)
    stored.sections[5][field] = badValue
    expectManifestError(
      () => validateRecoveryArchiveManifest(stored),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_SECTION_DESCRIPTOR',
    )
  })

  test('positive control: canonical hex nonce and 64-hex fingerprint pass admission', () => {
    const built = buildRecoveryArchiveManifest(BINDING, goldenSections())
    expect(built.manifest.sections[0].nonce).toMatch(/^[0-9a-f]{24}$/)
    expect(built.manifest.sections[0].dek_fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(() => validateRecoveryArchiveManifest(JSON.parse(built.manifestJson))).not.toThrow()
  })
})

describe('Time Machine D2g owner third-pass: exact binding boundary on build', () => {
  test('positive control: plain and null-prototype bindings build identically', () => {
    const plain = buildRecoveryArchiveManifest(BINDING, goldenSections())
    const nullProto = Object.assign(Object.create(null), BINDING)
    const fromNullProto = buildRecoveryArchiveManifest(nullProto, goldenSections())
    expect(fromNullProto.manifest.root_hash).toBe(plain.manifest.root_hash)
  })

  test('binding as a class instance refuses before projection', () => {
    class BindingClass {}
    const binding = Object.assign(new BindingClass(), BINDING)
    // Discriminating: the spread the old code performed would have projected this
    // back to a plain object with all required keys and built successfully.
    expect(Object.keys(binding)).toEqual(expect.arrayContaining([...Object.keys(BINDING)]))
    expectManifestError(
      () => buildRecoveryArchiveManifest(binding, goldenSections()),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_BINDING',
    )
  })

  test('extra enumerable string key refuses; additive fields need a format bump', () => {
    const binding = { ...BINDING, future_field: 'not-in-v1' } as never
    expectManifestError(
      () => buildRecoveryArchiveManifest(binding, goldenSections()),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_BINDING',
    )
  })

  test('extra enumerable symbol key refuses', () => {
    const binding: Record<string | symbol, unknown> = { ...BINDING }
    binding[Symbol('injected')] = 1
    expectManifestError(
      () => buildRecoveryArchiveManifest(binding as never, goldenSections()),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_BINDING',
    )
  })
})

describe('Time Machine D2g owner fourth-pass: accessors are not JSON data', () => {
  test('a binding getter cannot pass validation and substitute a later value', () => {
    const binding = { ...BINDING } as RecoveryArchiveManifestBinding
    let reads = 0
    Object.defineProperty(binding, 'sheet_id', {
      enumerable: true,
      get() {
        reads += 1
        return reads <= 2 ? 'sheet-valid' : ''
      },
    })

    expectManifestError(
      () => buildRecoveryArchiveManifest(binding, goldenSections()),
      'RECOVERY_ARCHIVE_MANIFEST_INVALID_BINDING',
    )
    expect(reads).toBe(0)
  })

  test('payload getters refuse instead of making canonical bytes evaluation-dependent', () => {
    const payload: Record<string, unknown> = {}
    Object.defineProperty(payload, 'record_id', {
      enumerable: true,
      get: () => 'r1',
    })
    expectManifestError(
      () =>
        buildRecoveryArchiveManifest(
          BINDING,
          sectionsWith({ records: [{ entity_key: 'record/r1', payload }] }),
        ),
      'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
    )
  })

  test('array index getters refuse while ordinary dense arrays remain supported', () => {
    const accessorArray = [1]
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get: () => 1,
    })
    expectManifestError(
      () => canonicalizeRecoveryArchiveJson(accessorArray),
      'RECOVERY_ARCHIVE_MANIFEST_UNSUPPORTED_JSON',
    )
    expect(canonicalizeRecoveryArchiveJson([1])).toBe('[1]')
  })
})
