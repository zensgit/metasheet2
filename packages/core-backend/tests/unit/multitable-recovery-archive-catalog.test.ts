import { describe, expect, it, vi } from 'vitest'

import {
  listRecoveryArchiveCatalog,
  readRecoveryArchiveCatalogEntry,
  RecoveryArchiveCatalogError,
  type RecoveryArchiveCatalogQuery,
  type RecoveryArchiveCatalogTransaction,
} from '../../src/multitable/recovery-archive-catalog'

const ENABLED_ENV = { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true' }
const WORKSPACE_ID = 'workspace-catalog'
const BASE_ID = 'base-catalog'
const SHEET_ID = 'sheet-catalog'
const GENERATION_A = '11111111-1111-4111-8111-111111111111'
const GENERATION_B = '22222222-2222-4222-8222-222222222222'
const GENERATION_C = '33333333-3333-4333-8333-333333333333'

function row(
  generationId: string,
  recoveryPointAt: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    generation_id: generationId,
    recovery_point_at: new Date(recoveryPointAt),
    archived_at: new Date('2026-08-28T10:00:00.000Z'),
    expires_at: new Date('2026-09-28T10:00:00.000Z'),
    anchor_seq: '9007199254740993',
    coverage_row_count: '77',
    superseded: false,
    ...overrides,
  }
}

function makeTransaction(query: RecoveryArchiveCatalogQuery) {
  return vi.fn<RecoveryArchiveCatalogTransaction>(async (work) => work(query))
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    baseId: BASE_ID,
    sheetId: SHEET_ID,
    recheckAuthority: vi.fn(async () => true),
    env: ENABLED_ENV,
    ...overrides,
  }
}

describe('Time Machine D3 archive catalog read authority', () => {
  it('is exact-literal flag gated before opening a transaction', async () => {
    const transaction = makeTransaction(vi.fn())

    await expect(listRecoveryArchiveCatalog(transaction, input({ env: {} })))
      .rejects.toMatchObject<Partial<RecoveryArchiveCatalogError>>({
        code: 'RECOVERY_ARCHIVE_CATALOG_DISABLED',
      })
    await expect(listRecoveryArchiveCatalog(transaction, input({
      env: { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'TRUE' },
    }))).rejects.toMatchObject<Partial<RecoveryArchiveCatalogError>>({
      code: 'RECOVERY_ARCHIVE_CATALOG_DISABLED',
    })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('rechecks authority inside the read transaction before catalog SQL', async () => {
    const query = vi.fn<RecoveryArchiveCatalogQuery>()
    const transaction = makeTransaction(query)

    await expect(listRecoveryArchiveCatalog(transaction, input({
      recheckAuthority: vi.fn(async () => false),
    }))).rejects.toMatchObject<Partial<RecoveryArchiveCatalogError>>({
      code: 'RECOVERY_ARCHIVE_CATALOG_AUTHORITY_DENIED',
    })

    expect(transaction).toHaveBeenCalledTimes(1)
    expect(query).not.toHaveBeenCalled()
  })

  it('lists only the exact workspace/base/sheet scope and emits an opaque continuation cursor', async () => {
    const query = vi.fn<RecoveryArchiveCatalogQuery>().mockResolvedValue({
      rows: [
        row(GENERATION_A, '2026-08-28T09:00:00.000Z'),
        row(GENERATION_B, '2026-08-27T09:00:00.000Z', { superseded: true }),
        row(GENERATION_C, '2026-08-26T09:00:00.000Z'),
      ],
    })
    const transaction = makeTransaction(query)
    const page = await listRecoveryArchiveCatalog(transaction, input({ limit: 2 }))

    expect(page).toEqual({
      entries: [
        {
          generationId: GENERATION_A,
          recoveryPointAt: '2026-08-28T09:00:00.000Z',
          archivedAt: '2026-08-28T10:00:00.000Z',
          expiresAt: '2026-09-28T10:00:00.000Z',
          anchorSeq: '9007199254740993',
          coverageRowCount: '77',
          superseded: false,
        },
        expect.objectContaining({
          generationId: GENERATION_B,
          superseded: true,
        }),
      ],
      nextCursor: expect.any(String),
    })
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, values] = query.mock.calls[0]
    expect(sql).toContain('archive.workspace_id = $1')
    expect(sql).toContain('archive.base_id = $2')
    expect(sql).toContain('archive.sheet_id = $3')
    expect(sql).toContain("archive.state = 'verified'")
    expect(sql).toContain("archive.coverage_status = 'complete'")
    expect(sql).toContain('archive.expires_at > clock_timestamp()')
    expect(values).toEqual([WORKSPACE_ID, BASE_ID, SHEET_ID, 3])

    query.mockResolvedValueOnce({ rows: [] })
    await listRecoveryArchiveCatalog(transaction, input({
      cursor: page.nextCursor,
      limit: 2,
    }))
    const [, cursorValues] = query.mock.calls[1]
    expect(cursorValues).toEqual([
      WORKSPACE_ID,
      BASE_ID,
      SHEET_ID,
      '2026-08-27T09:00:00.000Z',
      GENERATION_B,
      3,
    ])
  })

  it('reads one exact available generation and existence-hides every other scope', async () => {
    const query = vi.fn<RecoveryArchiveCatalogQuery>()
      .mockResolvedValueOnce({
        rows: [row(GENERATION_A, '2026-08-28T09:00:00.000Z')],
      })
      .mockResolvedValueOnce({ rows: [] })
    const transaction = makeTransaction(query)

    await expect(readRecoveryArchiveCatalogEntry(transaction, input({
      generationId: GENERATION_A,
    }))).resolves.toMatchObject({ generationId: GENERATION_A })
    const [, values] = query.mock.calls[0]
    expect(values).toEqual([WORKSPACE_ID, BASE_ID, SHEET_ID, GENERATION_A])

    await expect(readRecoveryArchiveCatalogEntry(transaction, input({
      generationId: GENERATION_B,
    }))).rejects.toMatchObject<Partial<RecoveryArchiveCatalogError>>({
      code: 'RECOVERY_ARCHIVE_CATALOG_NOT_FOUND',
    })
  })

  it('fails closed on malformed persistence instead of projecting a partial recovery point', async () => {
    const query = vi.fn<RecoveryArchiveCatalogQuery>().mockResolvedValue({
      rows: [row(GENERATION_A, '2026-08-28T09:00:00.000Z', {
        coverage_row_count: null,
      })],
    })

    await expect(listRecoveryArchiveCatalog(makeTransaction(query), input()))
      .rejects.toMatchObject<Partial<RecoveryArchiveCatalogError>>({
        code: 'RECOVERY_ARCHIVE_CATALOG_PERSISTENCE_INVALID',
      })
  })
})
