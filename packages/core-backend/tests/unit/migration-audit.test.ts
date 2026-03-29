import { describe, expect, it } from 'vitest'
import {
  DIRECTORY_MIGRATION_TABLES,
  DIRECTORY_REQUIRED_MIGRATIONS,
  buildExecutedMigrationNames,
  buildMigrationListEntries,
  buildMigrationOrderCheck,
  buildRequiredMigrationAudit,
  filterAndSortMigrations,
  formatMigrationAuditReport,
  parseMigrationCliArgs,
  sortRecordedMigrationExecutions,
  type MigrationAuditReport,
} from '../../src/db/migration-audit'

describe('migration-audit', () => {
  it('parses allow-destructive from argv', () => {
    const args = parseMigrationCliArgs(['--allow-destructive', '--rollback'])
    expect(args.action).toBe('rollback')
    expect(args.allowDestructive).toBe(true)
  })

  it('marks executed and pending migrations when tracking is available', () => {
    const entries = buildMigrationListEntries(
      ['001_first', '002_second'],
      [
        { name: '001_first', executedAt: new Date('2026-03-27T00:00:00.000Z') } as never,
        { name: '002_second', executedAt: undefined } as never,
      ],
    )

    expect(entries).toEqual([
      {
        name: '001_first',
        status: 'executed',
        executedAt: '2026-03-27T00:00:00.000Z',
      },
      {
        name: '002_second',
        status: 'pending',
        executedAt: null,
      },
    ])
  })

  it('skips order drift evaluation when tracking is unavailable', () => {
    const finding = buildMigrationOrderCheck(['001_first'], [], false)
    expect(finding.ok).toBeNull()
    expect(finding.firstMismatchIndex).toBeNull()
  })

  it('detects prefix order mismatch between executed and filesystem migrations', () => {
    const finding = buildMigrationOrderCheck(
      ['001_first', '002_second', '003_third'],
      ['001_first', '003_third'],
    )

    expect(finding.ok).toBe(false)
    expect(finding.firstMismatchIndex).toBe(1)
    expect(finding.expectedName).toBe('002_second')
    expect(finding.actualName).toBe('003_third')
  })

  it('prefers recorded execution order over filesystem status order when available', () => {
    const executedNames = buildExecutedMigrationNames(
      [
        { name: '001_first', executedAt: new Date('2026-03-27T00:00:00.000Z') } as never,
        { name: '002_second', executedAt: new Date('2026-03-27T00:01:00.000Z') } as never,
      ],
      [
        { name: '002_second', executedAt: '2026-03-27T00:01:00.000Z' },
        { name: '001_first', executedAt: '2026-03-27T00:00:00.000Z' },
      ],
    )

    expect(executedNames).toEqual(['002_second', '001_first'])
  })

  it('sorts recorded executions by timestamp and then name', () => {
    const ordered = sortRecordedMigrationExecutions([
      { name: '003_third', executedAt: '2026-03-27T00:00:00.103Z' },
      { name: '002_second', executedAt: '2026-03-27T00:00:00.102Z' },
      { name: '001_first', executedAt: '2026-03-27T00:00:00.102Z' },
    ])

    expect(ordered.map((item) => item.name)).toEqual([
      '001_first',
      '002_second',
      '003_third',
    ])
  })

  it('tracks required directory migrations', () => {
    const finding = buildRequiredMigrationAudit([
      DIRECTORY_REQUIRED_MIGRATIONS[0],
      DIRECTORY_REQUIRED_MIGRATIONS[2],
    ])

    expect(finding.presentNames).toEqual([
      DIRECTORY_REQUIRED_MIGRATIONS[0],
      DIRECTORY_REQUIRED_MIGRATIONS[2],
    ])
    expect(finding.missingNames).toContain(DIRECTORY_REQUIRED_MIGRATIONS[1])
  })

  it('filters hidden migrations and sorts filesystem order deterministically', () => {
    const ordered = filterAndSortMigrations({
      zzzz20260324143000_create_user_external_auth_grants: { up: true },
      _draft_local_only: { up: false },
      zzzz20260323153000_add_attendance_shift_overnight: { up: true },
      zzzz20260323133000_harden_user_external_identities: { up: true },
    })

    expect(Object.keys(ordered)).toEqual([
      'zzzz20260323133000_harden_user_external_identities',
      'zzzz20260323153000_add_attendance_shift_overnight',
      'zzzz20260324143000_create_user_external_auth_grants',
    ])
  })

  it('formats skipped order checks and required migration counts', () => {
    const report: MigrationAuditReport = {
      generatedAt: '2026-03-27T15:00:00.000Z',
      databaseReachable: false,
      migrationTableExists: false,
      migrationLockTableExists: false,
      filesystemMigrations: {
        count: 5,
        first: '001_first',
        last: '005_last',
      },
      trackedMigrations: {
        available: false,
        executedCount: 0,
        pendingCount: 5,
        lastExecuted: null,
      },
      orderCheck: {
        ok: null,
        firstMismatchIndex: null,
        expectedName: null,
        actualName: null,
      },
      requiredDirectoryMigrations: {
        expectedNames: DIRECTORY_REQUIRED_MIGRATIONS,
        presentNames: [DIRECTORY_REQUIRED_MIGRATIONS[0]],
        missingNames: DIRECTORY_REQUIRED_MIGRATIONS.slice(1) as string[],
      },
      directorySchema: {
        expectedTables: DIRECTORY_MIGRATION_TABLES,
        presentTables: [DIRECTORY_MIGRATION_TABLES[0]],
        missingTables: DIRECTORY_MIGRATION_TABLES.slice(1) as string[],
      },
      warnings: ['tracking unavailable'],
      errors: ['schema drift'],
    }

    const formatted = formatMigrationAuditReport(report)
    expect(formatted).toContain('orderCheck: skipped')
    expect(formatted).toContain('requiredDirectoryMigrations: present=1, missing=5')
    expect(formatted).toContain('directorySchema.missingTables:')
  })
})
