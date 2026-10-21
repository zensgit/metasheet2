import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from '../../src/multitable/recovery-archive-contract'
import type { RecoveryArchiveManifest } from '../../src/multitable/recovery-archive-manifest'
import type { RecoveryArchiveOpenedSnapshot } from '../../src/multitable/recovery-archive-reader'
import {
  RecoveryArchiveReconstructorError,
  reconstructRecoveryArchiveCompleteSectionsInternal,
  type RecoveryArchiveReconstructorErrorCode,
} from '../../src/multitable/recovery-archive-reconstructor'
import type { QueryFn } from '../../src/multitable/permission-service'
import type { RecordStateAtT } from '../../src/multitable/record-reconstructor'

const SHEET = 'sheet-0001'
const CHECKPOINT = 'checkpoint-0001'
const OTHER_CHECKPOINT = 'checkpoint-0002'
const ANCHOR_SEQ = '9007199254740993'
const FLOOR_SEQ = '10'
const SENTINEL = 'reconstructor-sensitive-sentinel'

type QueryCall = { sql: string; params?: unknown[] }

const SKIPPED_RUNTIME_DIRECTORIES = new Set([
  '.git',
  '__fixtures__',
  '__tests__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'test',
  'tests',
  'verification',
])

function walkRuntimeSourceFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (SKIPPED_RUNTIME_DIRECTORIES.has(entry.name)) continue
    const absolute = resolve(root, entry.name)
    if (entry.isDirectory()) files.push(...walkRuntimeSourceFiles(absolute))
    else if (entry.isFile() && /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx|vue)$/.test(entry.name)) {
      files.push(absolute)
    }
  }
  return files
}

function recordRow(input: {
  record_id: string
  exists: boolean
  version: number | null
  data: Record<string, unknown> | null
}) {
  return {
    entity_key: `record/${input.record_id}`,
    payload: {
      record_id: input.record_id,
      exists: input.exists,
      version: input.version,
      data: input.data,
    },
  }
}

function emptySections(
  records: ReturnType<typeof recordRow>[],
): RecoveryArchiveOpenedSnapshot['sections'] {
  const sections = Object.create(null) as RecoveryArchiveOpenedSnapshot['sections']
  const writable = sections as Record<string, unknown>
  for (const name of RECOVERY_ARCHIVE_V1_SECTION_NAMES) writable[name] = []
  writable.records = records
  writable.schema = [
    {
      entity_key: 'field/field-1',
      payload: { field_id: 'field-1', name: 'Name', type: 'text', property: {}, order: 1 },
    },
  ]
  return sections
}

function openedArchive(options: {
  records: ReturnType<typeof recordRow>[]
  checkpointId?: string
  anchorSeq?: string
} = { records: [] }): RecoveryArchiveOpenedSnapshot {
  const manifest = {
    format_version: 1,
    archive_generation_id: 'generation-0001',
    workspace_id: 'workspace-0001',
    base_id: 'base-0001',
    sheet_id: SHEET,
    anchor_operation_id: 'operation-0001',
    anchor_seq: options.anchorSeq ?? ANCHOR_SEQ,
    checkpoint_id: options.checkpointId ?? CHECKPOINT,
    created_at: '2026-08-28T00:00:00.000Z',
    expires_at: null,
    source_vector_hash: 'b'.repeat(64),
    sections: RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((name) => ({
      name,
      row_count: name === 'records' ? String(options.records.length) : name === 'schema' ? '1' : '0',
      plaintext_sha256: 'a'.repeat(64),
      aead_algorithm: 'aes-256-gcm',
      key_id: 'key',
      wrapped_dek_id: 'wrap',
      dek_fingerprint: 'c'.repeat(64),
      nonce: '11'.repeat(12),
    })),
    root_hash: 'd'.repeat(64),
    manifest_mac: '00aa',
  } as RecoveryArchiveManifest
  return { manifest, sections: emptySections(options.records) }
}

function createQuery(options: {
  checkpoint?: {
    id: string
    sheet_id: string
    state: string
    trusted_since_seq: string
    trusted_from_at?: Date | null
    system_kind?: string | null
    pruned_at?: Date | null
  } | null
  revisions?: Array<{
    record_id: string
    action: string | null
    snapshot: Record<string, unknown> | null
    version: number
    seq: string
    kind: 'event' | 'marker'
  }>
  baselines?: Array<{
    record_id: string
    data: Record<string, unknown>
    version: number
    is_trashed: boolean
  }>
}): { query: QueryFn; calls: QueryCall[] } {
  const calls: QueryCall[] = []
  const query: QueryFn = async (sql, params) => {
    calls.push({ sql, params })
    if (sql.includes('meta_history_trust_checkpoints')) {
      return { rows: options.checkpoint ? [options.checkpoint] : [] }
    }
    if (sql.includes('UNION ALL')) {
      return { rows: options.revisions ?? [] }
    }
    if (sql.includes('meta_history_baselines')) {
      return { rows: options.baselines ?? [] }
    }
    throw new Error(`unexpected-sql:${SENTINEL}`)
  }
  return { query, calls }
}

function coveringCheckpoint(id = CHECKPOINT) {
  return {
    id,
    sheet_id: SHEET,
    state: 'active',
    trusted_since_seq: FLOOR_SEQ,
    trusted_from_at: null,
    system_kind: null,
    pruned_at: null,
  }
}

function expectReconstructorError(error: unknown, code: RecoveryArchiveReconstructorErrorCode): void {
  expect(error).toBeInstanceOf(RecoveryArchiveReconstructorError)
  expect(error).toMatchObject({
    name: 'RecoveryArchiveReconstructorError',
    code,
    message: code,
  })
  expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false)
  expect(String(error)).not.toContain(SENTINEL)
}

describe('recovery-archive D4 reconstructor', () => {
  test('fills pruned hot records from the complete archive and keeps overlapping states', async () => {
    const hot = recordRow({
      record_id: 'hot-1',
      exists: true,
      version: 2,
      data: { text: 'hot' },
    })
    const filled = recordRow({
      record_id: 'archived-only',
      exists: true,
      version: 1,
      data: { text: 'from-archive' },
    })
    const { query, calls } = createQuery({
      checkpoint: coveringCheckpoint(),
      revisions: [
        {
          record_id: 'hot-1',
          action: 'update',
          snapshot: { text: 'hot' },
          version: 2,
          seq: '20',
          kind: 'event',
        },
      ],
      baselines: [],
    })
    const result = await reconstructRecoveryArchiveCompleteSectionsInternal({
      query,
      openedArchive: openedArchive({ records: [hot, filled] }),
    })

    expect(result.records.get('hot-1')).toEqual({
      recordId: 'hot-1',
      exists: true,
      data: { text: 'hot' },
      version: 2,
    })
    expect(result.records.get('archived-only')).toEqual({
      recordId: 'archived-only',
      exists: true,
      data: { text: 'from-archive' },
      version: 1,
    })
    expect(result.schema).toHaveLength(1)
    expect(result.links).toEqual([])
    const replayCall = calls.find((call) => call.sql.includes('UNION ALL'))
    expect(replayCall?.params?.[1]).toBe(ANCHOR_SEQ)
    expect(replayCall?.params?.[2]).toBe(FLOOR_SEQ)
    expect(Number(ANCHOR_SEQ) === Number('9007199254740992')).toBe(true)
  })

  test('overlapping hot/checkpoint and archive mismatch refuses', async () => {
    const { query } = createQuery({
      checkpoint: coveringCheckpoint(),
      revisions: [
        {
          record_id: 'hot-1',
          action: 'update',
          snapshot: { text: 'hot-stale' },
          version: 2,
          seq: '20',
          kind: 'event',
        },
      ],
    })
    try {
      await reconstructRecoveryArchiveCompleteSectionsInternal({
        query,
        openedArchive: openedArchive({
          records: [recordRow({ record_id: 'hot-1', exists: true, version: 2, data: { text: 'archive' } })],
        }),
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReconstructorError(error, 'RECOVERY_ARCHIVE_RECONSTRUCTOR_OVERLAP_MISMATCH')
    }
  })

  test('a composed record absent from the complete archive refuses', async () => {
    const { query } = createQuery({
      checkpoint: coveringCheckpoint(),
      revisions: [
        {
          record_id: 'hot-1',
          action: 'create',
          snapshot: { text: 'hot' },
          version: 1,
          seq: '20',
          kind: 'event',
        },
      ],
    })
    try {
      await reconstructRecoveryArchiveCompleteSectionsInternal({
        query,
        openedArchive: openedArchive({ records: [] }),
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReconstructorError(error, 'RECOVERY_ARCHIVE_RECONSTRUCTOR_ARCHIVE_INCOMPLETE')
    }
  })

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'archive record version %s refuses instead of entering the apply state',
    async (version) => {
      const { query, calls } = createQuery({ checkpoint: coveringCheckpoint() })
      try {
        await reconstructRecoveryArchiveCompleteSectionsInternal({
          query,
          openedArchive: openedArchive({
            records: [
              recordRow({
                record_id: 'invalid-version',
                exists: true,
                version,
                data: { text: 'archive' },
              }),
            ],
          }),
        })
        throw new Error('expected-refusal')
      } catch (error) {
        expectReconstructorError(error, 'RECOVERY_ARCHIVE_RECONSTRUCTOR_RECORDS_INVALID')
      }
      expect(calls).toEqual([])
    },
  )

  test('cyclic archive record data refuses with a closed values-free code', async () => {
    const cyclic: Record<string, unknown> = { text: 'archive' }
    cyclic.self = cyclic
    const { query, calls } = createQuery({ checkpoint: coveringCheckpoint() })
    try {
      await reconstructRecoveryArchiveCompleteSectionsInternal({
        query,
        openedArchive: openedArchive({
          records: [
            recordRow({
              record_id: 'cyclic-record',
              exists: true,
              version: 1,
              data: cyclic,
            }),
          ],
        }),
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReconstructorError(error, 'RECOVERY_ARCHIVE_RECONSTRUCTOR_INVALID_INPUT')
    }
    expect(calls).toEqual([])
  })

  test('delete then recreate keeps the later generation and does not resurrect the deleted one', async () => {
    const { query } = createQuery({
      checkpoint: coveringCheckpoint(),
      revisions: [
        {
          record_id: 'rec-gen',
          action: 'create',
          snapshot: { text: 'g1' },
          version: 1,
          seq: '11',
          kind: 'event',
        },
        {
          record_id: 'rec-gen',
          action: 'delete',
          snapshot: { text: 'g1' },
          version: 1,
          seq: '12',
          kind: 'event',
        },
        {
          record_id: 'rec-gen',
          action: 'create',
          snapshot: { text: 'g2' },
          version: 1,
          seq: '13',
          kind: 'event',
        },
      ],
    })
    const result = await reconstructRecoveryArchiveCompleteSectionsInternal({
      query,
      openedArchive: openedArchive({
        records: [recordRow({ record_id: 'rec-gen', exists: true, version: 1, data: { text: 'g2' } })],
      }),
    })
    expect(result.records.get('rec-gen')).toEqual({
      recordId: 'rec-gen',
      exists: true,
      data: { text: 'g2' },
      version: 1,
    })
  })

  test('checkpoint reselect mismatch fails closed', async () => {
    const { query } = createQuery({
      checkpoint: coveringCheckpoint(OTHER_CHECKPOINT),
    })
    try {
      await reconstructRecoveryArchiveCompleteSectionsInternal({
        query,
        openedArchive: openedArchive({
          records: [],
          checkpointId: CHECKPOINT,
        }),
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReconstructorError(error, 'RECOVERY_ARCHIVE_RECONSTRUCTOR_CHECKPOINT_MISMATCH')
    }
  })

  test('no covering checkpoint refuses before replay with a closed code', async () => {
    const { query, calls } = createQuery({ checkpoint: null })
    try {
      await reconstructRecoveryArchiveCompleteSectionsInternal({
        query,
        openedArchive: openedArchive({ records: [] }),
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReconstructorError(error, 'RECOVERY_ARCHIVE_RECONSTRUCTOR_NO_COVERING_CHECKPOINT')
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sql).toContain('meta_history_trust_checkpoints')
  })

  test('history query failures are closed and values-free', async () => {
    const query: QueryFn = async () => {
      throw new Error(`driver-failure:${SENTINEL}`)
    }
    try {
      await reconstructRecoveryArchiveCompleteSectionsInternal({
        query,
        openedArchive: openedArchive({ records: [] }),
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReconstructorError(error, 'RECOVERY_ARCHIVE_RECONSTRUCTOR_HISTORY_INCOMPLETE')
    }
  })

  test('first post-floor marker inherits checkpoint data and keeps the marker version', async () => {
    const { query } = createQuery({
      checkpoint: coveringCheckpoint(),
      revisions: [
        {
          record_id: 'marker-1',
          action: null,
          snapshot: null,
          version: 8,
          seq: '20',
          kind: 'marker',
        },
      ],
      baselines: [
        {
          record_id: 'marker-1',
          data: { text: 'checkpoint' },
          version: 7,
          is_trashed: false,
        },
      ],
    })
    const result = await reconstructRecoveryArchiveCompleteSectionsInternal({
      query,
      openedArchive: openedArchive({
        records: [
          recordRow({
            record_id: 'marker-1',
            exists: true,
            version: 8,
            data: { text: 'checkpoint' },
          }),
        ],
      }),
    })
    expect(result.records.get('marker-1')).toEqual({
      recordId: 'marker-1',
      exists: true,
      data: { text: 'checkpoint' },
      version: 8,
    })
  })

  test('marker without a checkpoint baseline refuses as incomplete history', async () => {
    const { query } = createQuery({
      checkpoint: coveringCheckpoint(),
      revisions: [
        {
          record_id: 'marker-missing',
          action: null,
          snapshot: null,
          version: 8,
          seq: '20',
          kind: 'marker',
        },
      ],
      baselines: [],
    })
    try {
      await reconstructRecoveryArchiveCompleteSectionsInternal({
        query,
        openedArchive: openedArchive({ records: [] }),
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expectReconstructorError(error, 'RECOVERY_ARCHIVE_RECONSTRUCTOR_HISTORY_INCOMPLETE')
    }
  })

  test('returned record states are defensive copies', async () => {
    const { query } = createQuery({
      checkpoint: coveringCheckpoint(),
      revisions: [
        {
          record_id: 'hot-1',
          action: 'create',
          snapshot: { text: 'hot' },
          version: 1,
          seq: '20',
          kind: 'event',
        },
      ],
    })
    const result = await reconstructRecoveryArchiveCompleteSectionsInternal({
      query,
      openedArchive: openedArchive({
        records: [recordRow({ record_id: 'hot-1', exists: true, version: 1, data: { text: 'hot' } })],
      }),
    })
    const state = result.records.get('hot-1') as RecordStateAtT
    expect(() => {
      ;(state as { exists: boolean }).exists = false
    }).toThrow()
    expect(() => {
      ;(state.data as { text: string }).text = SENTINEL
    }).toThrow()
    expect(result.records.get('hot-1')?.data).toEqual({ text: 'hot' })
    expect(() => {
      ;(result.schema[0] as { entity_key: string }).entity_key = SENTINEL
    }).toThrow()
  })

  test('production modules do not reference wall-clock reconstruction or current live projections', () => {
    const reader = readFileSync(
      resolve(__dirname, '../../src/multitable/recovery-archive-reader.ts'),
      'utf8',
    )
    const reconstructor = readFileSync(
      resolve(__dirname, '../../src/multitable/recovery-archive-reconstructor.ts'),
      'utf8',
    )
    for (const source of [reader, reconstructor]) {
      expect(source).not.toContain('reconstructRecordsAtT')
      expect(source).not.toMatch(/\bmeta_links\b/)
      expect(source).not.toMatch(/\bmeta_fields\b/)
      expect(source).not.toMatch(/\bmultitable_attachments\b/)
      expect(source).not.toMatch(/\bmeta_views\b/)
      expect(source).not.toMatch(/\bview_states\b/)
    }
    expect(reconstructor).toContain('reconstructRecordsAtSeq')
    expect(reconstructor).toContain('composeBaselineOverlay')
    expect(reconstructor).toContain('selectCheckpointByAnchorSeq')
  })

  test('the public facade is the only production consumer authority', () => {
    const repoRoot = resolve(__dirname, '../../../..')
    const srcRoot = resolve(repoRoot, 'packages/core-backend/src')
    const readerPath = resolve(srcRoot, 'multitable/recovery-archive-reader.ts')
    const reconstructorPath = resolve(srcRoot, 'multitable/recovery-archive-reconstructor.ts')
    const allowed = new Set([readerPath, reconstructorPath])
    const symbols = [
      'readRecoveryArchiveCompleteSectionsInternal',
      'reconstructRecoveryArchiveCompleteSectionsInternal',
    ]
    const runtimeRoots = ['apps', 'packages', 'plugins', 'scripts', 'tools'].map((root) =>
      resolve(repoRoot, root),
    )
    const runtimeSources = runtimeRoots.flatMap((root) => walkRuntimeSourceFiles(root))
    expect(runtimeSources).toContain(resolve(repoRoot, 'apps/web/src/App.vue'))
    expect(runtimeSources).toContain(resolve(repoRoot, 'scripts/dev-pattern-expiry-check.js'))
    expect(runtimeSources).toContain(resolve(repoRoot, 'tools/cli/src/commands/create.ts'))
    const consumers = runtimeSources
      .filter((file) => {
        const source = readFileSync(file, 'utf8')
        return symbols.some((symbol) => source.includes(symbol))
      })
    expect(new Set(consumers)).toEqual(allowed)
    expect(readFileSync(readerPath, 'utf8')).toContain(
      'export async function readRecoveryArchiveCompleteSectionState',
    )
  })
})
