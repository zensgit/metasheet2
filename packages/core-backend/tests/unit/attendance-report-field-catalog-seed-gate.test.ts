import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

// B3 item ② (spec-B3-stock-prep-own-base, 2026-09-14): ATTENDANCE_REPORT_FIELD_CATALOG_SEED=false must
// skip ONLY the activate()-time preload of the attendance report field catalog — the call site is the
// `await ensureAttendanceReportFieldCatalog(context, DEFAULT_ORG_ID, logger)` inside activate(). Default
// (unset) keeps today's behaviour so existing installs are byte-identical.
//
// The gate deliberately lives in activate(), NOT inside ensureAttendanceReportFieldCatalog: the on-demand
// callers (saveAttendanceReportFormulaField, buildAttendanceReportFieldCatalogResponse) must still
// provision/seed when a report is opened. Those on-demand paths are covered by
// tests/unit/attendance-report-field-catalog.test.ts (which calls the ensure helper directly and is
// unaffected by this env var — proving the gate is not inside the helper).
//
// Every activate() case below carries a POSITIVE CONTROL in the same file: the env-unset case MUST show
// exactly one catalog ensureObject call, so a broken harness (activate throwing early) reds instead of
// silently passing the "zero calls" assertion.
const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests as {
  isAttendanceReportFieldCatalogSeedEnabled: () => boolean
  ATTENDANCE_REPORT_FIELD_CATALOG_OBJECT_ID: string
}

const CATALOG_OBJECT_ID = 'attendance_report_field_catalog'
const CATALOG_PROJECT_ID = 'default:attendance'
const ENV_NAME = 'ATTENDANCE_REPORT_FIELD_CATALOG_SEED'

type EnsureObjectInput = { projectId: string; descriptor: { id: string } }

function buildHarness() {
  const db = {
    query: async () => [],
    transaction: async (callback: (client: unknown) => unknown) => callback(db),
  }
  const ensureObject = vi.fn(async (input: EnsureObjectInput) => ({
    baseId: 'base-1',
    sheet: { id: `sheet-${input.descriptor.id}`, baseId: 'base-1', name: input.descriptor.id, description: null },
    fields: [],
  }))
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const context = {
    api: {
      database: db,
      events: { emit: async () => undefined },
      http: { addRoute: () => undefined },
      multitable: {
        provisioning: {
          ensureObject,
          ensureView: vi.fn().mockResolvedValue({ id: 'view-1' }),
          resolveFieldIds: vi.fn().mockResolvedValue({}),
        },
        records: {
          queryRecords: vi.fn().mockResolvedValue([]),
          createRecord: vi.fn(async (input: { sheetId: string; data: Record<string, unknown> }) => ({
            id: 'rec-1',
            sheetId: input.sheetId,
            version: 1,
            data: input.data,
          })),
        },
      },
    },
    services: {},
    logger,
  }
  const catalogEnsureCalls = () =>
    ensureObject.mock.calls.filter(
      ([input]) => input?.descriptor?.id === CATALOG_OBJECT_ID && input?.projectId === CATALOG_PROJECT_ID,
    )
  const loggedWith = (spy: typeof logger.info, needle: string) =>
    spy.mock.calls.filter(([message]) => typeof message === 'string' && message.includes(needle))
  return { context, logger, catalogEnsureCalls, loggedWith }
}

describe(`#B3-② attendance report field catalog boot preload — ${ENV_NAME} env gate (pure)`, () => {
  afterEach(() => {
    delete process.env[ENV_NAME]
  })

  it('defaults ON: unset env keeps today behaviour', () => {
    delete process.env[ENV_NAME]
    expect(helpers.isAttendanceReportFieldCatalogSeedEnabled()).toBe(true)
  })

  it('only the explicit disabling values turn it off — trimmed and case-insensitive', () => {
    for (const off of ['false', 'FALSE', '  False  ', '0', 'no']) {
      process.env[ENV_NAME] = off
      expect(helpers.isAttendanceReportFieldCatalogSeedEnabled()).toBe(false)
    }
    for (const on of ['true', 'TRUE', ' 1 ', 'yes', 'nonsense', '']) {
      process.env[ENV_NAME] = on
      expect(helpers.isAttendanceReportFieldCatalogSeedEnabled()).toBe(true)
    }
  })

  it('is read at call time, not at module load (both branches observable in one process)', () => {
    process.env[ENV_NAME] = 'false'
    expect(helpers.isAttendanceReportFieldCatalogSeedEnabled()).toBe(false)
    delete process.env[ENV_NAME]
    expect(helpers.isAttendanceReportFieldCatalogSeedEnabled()).toBe(true)
  })
})

describe(`#B3-② attendance plugin activate() — catalog preload call count under ${ENV_NAME}`, () => {
  afterEach(async () => {
    delete process.env[ENV_NAME]
    await attendancePlugin.deactivate()
  })

  it('POSITIVE CONTROL — env unset: activate() provisions the catalog exactly once for default:attendance', async () => {
    delete process.env[ENV_NAME]
    const { context, logger, catalogEnsureCalls, loggedWith } = buildHarness()

    await attendancePlugin.activate(context)

    expect(catalogEnsureCalls()).toHaveLength(1)
    expect(loggedWith(logger.warn, 'Attendance report field catalog preload failed')).toHaveLength(0)
    expect(loggedWith(logger.info, ENV_NAME)).toHaveLength(0)
    expect(loggedWith(logger.info, 'Attendance plugin activated')).toHaveLength(1)
  })

  it(`${ENV_NAME}=false: activate() makes ZERO catalog provisioning calls and logs one values-free info line`, async () => {
    process.env[ENV_NAME] = 'false'
    const { context, logger, catalogEnsureCalls, loggedWith } = buildHarness()

    await attendancePlugin.activate(context)

    expect(catalogEnsureCalls()).toHaveLength(0)
    const skipped = loggedWith(logger.info, ENV_NAME)
    expect(skipped).toHaveLength(1)
    // values-free: the line carries the env name only — no org id, no tenant, no connection string.
    expect(skipped[0]).toEqual([
      'Attendance report field catalog preload skipped (ATTENDANCE_REPORT_FIELD_CATALOG_SEED=false)',
    ])
    expect(loggedWith(logger.warn, 'Attendance report field catalog preload failed')).toHaveLength(0)
    // the rest of activate() still runs
    expect(loggedWith(logger.info, 'Attendance plugin activated')).toHaveLength(1)
  })
})
