import { describe, expect, it } from 'vitest'
import {
  REQUIRED_DIRECTORY_MIGRATIONS,
  REQUIRED_DIRECTORY_TABLES,
  buildDirectorySchemaFinding,
  buildMigrationAuditReport,
  buildMigrationListEntries,
  buildMigrationOrderFinding,
} from '../../src/db/migration-health'

describe('migration-health', () => {
  it('marks executed and pending migrations when tracking is available', () => {
    const entries = buildMigrationListEntries(
      ['001_first', '002_second'],
      [{ name: '001_first', executedAt: new Date('2026-03-27T00:00:00.000Z') }],
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

  it('marks status as unknown when tracking is unavailable', () => {
    const entries = buildMigrationListEntries(['001_first'])
    expect(entries).toEqual([
      {
        name: '001_first',
        status: 'unknown',
        executedAt: null,
      },
    ])
  })

  it('detects prefix order mismatch between executed and filesystem migrations', () => {
    const finding = buildMigrationOrderFinding(
      ['001_first', '002_second', '003_third'],
      ['001_first', '003_third'],
    )

    expect(finding.ok).toBe(false)
    expect(finding.firstMismatchIndex).toBe(1)
    expect(finding.expectedName).toBe('002_second')
    expect(finding.actualName).toBe('003_third')
  })

  it('reports directory schema availability and missing tables', () => {
    const finding = buildDirectorySchemaFinding({
      [REQUIRED_DIRECTORY_TABLES[0]]: true,
      [REQUIRED_DIRECTORY_TABLES[1]]: false,
    })

    expect(finding.available).toBe(true)
    expect(finding.present).toContain(REQUIRED_DIRECTORY_TABLES[0])
    expect(finding.missing).toContain(REQUIRED_DIRECTORY_TABLES[1])
  })

  it('builds an audit report with order and schema errors', () => {
    const report = buildMigrationAuditReport({
      filesystemNames: [...REQUIRED_DIRECTORY_MIGRATIONS],
      trackedMigrations: [
        { name: REQUIRED_DIRECTORY_MIGRATIONS[0], executedAt: new Date('2026-03-27T01:00:00.000Z') },
        { name: REQUIRED_DIRECTORY_MIGRATIONS[2], executedAt: new Date('2026-03-27T01:05:00.000Z') },
      ],
      tableAvailability: {
        [REQUIRED_DIRECTORY_TABLES[0]]: true,
        [REQUIRED_DIRECTORY_TABLES[1]]: true,
        [REQUIRED_DIRECTORY_TABLES[2]]: false,
      },
    })

    expect(report.order.ok).toBe(false)
    expect(report.errors).toContain('Executed migrations do not match the filesystem prefix order.')
    expect(report.errors).toContain('Directory schema is missing 9 required table(s).')
    expect(report.requiredDirectoryMigrations.missing).toEqual([])
  })
})
