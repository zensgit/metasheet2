import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_ACTIVE_CURRENT_RELATION_V1,
  assertActiveCurrentSurfaceSourceV1,
  listActiveCurrentAttendanceRecordsForAnomalyListingV1,
  loadActiveCurrentAttendanceRecordForDecisionTraceV1,
  loadActiveCurrentAttendanceRecordForMakeupAnomalyFactsV1,
  listActiveCurrentOpenRecordsForWorkDateResolverV1,
} from '../w4c3c-active-current'

describe('W4C-3c active-current helper (P20)', () => {
  it('issues SELECTs only against the singular active-current relation for all four surfaces', async () => {
    const seen: string[] = []
    const query = async (sql: string) => {
      seen.push(sql)
      return { rows: [] }
    }
    await loadActiveCurrentAttendanceRecordForDecisionTraceV1(query, {
      orgId: 'o',
      userId: 'u',
      workDate: '2026-08-01',
    })
    await loadActiveCurrentAttendanceRecordForMakeupAnomalyFactsV1(query, {
      orgId: 'o',
      userId: 'u',
      workDate: '2026-08-01',
    })
    await listActiveCurrentAttendanceRecordsForAnomalyListingV1(query, {
      orgId: 'o',
      userId: 'u',
      from: '2026-08-01',
      to: '2026-08-07',
      excludedStatuses: ['normal'],
    })
    await listActiveCurrentOpenRecordsForWorkDateResolverV1(query, {
      orgId: 'o',
      userId: 'u',
      workDates: ['2026-08-01'],
    })
    expect(seen.length).toBe(4)
    for (const sql of seen) {
      expect(sql).toContain(ATTENDANCE_ACTIVE_CURRENT_RELATION_V1)
      expect(sql).not.toMatch(/FROM\s+attendance_records\b/)
    }
  })

  it('keeps anomaly filtering closed instead of accepting caller SQL fragments', async () => {
    let seen = ''
    await listActiveCurrentAttendanceRecordsForAnomalyListingV1(async (sql) => {
      seen = sql
      return { rows: [] }
    }, {
      orgId: 'o',
      userId: 'u',
      from: '2026-08-01',
      to: '2026-08-07',
      excludedStatuses: ['normal'],
      owedPunchOnly: true,
    })
    expect(seen).toContain("status = 'partial'")
    expect(seen).toContain("status = 'absent'")
    expect(seen).toContain('first_in_at IS NULL OR last_out_at IS NULL')
    expect(seen).not.toContain('extraWhereSql')
  })

  it('independent surface source controls: dropping relation fails only that surface', () => {
    const surfaces = [
      'anomaly_listing',
      'makeup_anomaly_facts',
      'open_record_attribution',
      'decision_trace',
    ] as const
    for (const surface of surfaces) {
      expect(() =>
        assertActiveCurrentSurfaceSourceV1(
          surface,
          'SELECT * FROM attendance_records WHERE org_id = $1',
        ),
      ).toThrowError(/ATTENDANCE_P20_ACTIVE_CURRENT_SURFACE_MISSING/)
      expect(() =>
        assertActiveCurrentSurfaceSourceV1(
          surface,
          `SELECT * FROM ${ATTENDANCE_ACTIVE_CURRENT_RELATION_V1}`,
        ),
      ).not.toThrow()
    }
  })

  it('mutation: a local duplicate helper that reads attendance_records is rejected by surface assertion', () => {
    const forgedLocalHelper = `
      async function listActiveCurrentAttendanceRecordsForAnomalyListing(db, options) {
        return db.query('SELECT * FROM attendance_records WHERE org_id = $1', [options.orgId])
      }
    `
    expect(() =>
      assertActiveCurrentSurfaceSourceV1('anomaly_listing', forgedLocalHelper),
    ).toThrowError(/ATTENDANCE_P20_ACTIVE_CURRENT_SURFACE_MISSING/)
  })

  it('each of four surfaces independently excludes a retired fixture via the active-current relation', async () => {
    const active = { id: 'active-1', status: 'late', visibility_state: 'active' }
    const retired = { id: 'retired-1', status: 'late', visibility_state: 'retired' }
    const query = async (sql: string) => {
      // View path: only active rows. Base table path would leak the retired fixture.
      if (sql.includes(ATTENDANCE_ACTIVE_CURRENT_RELATION_V1)) {
        return { rows: [active] }
      }
      if (/FROM\s+attendance_records\b/.test(sql)) {
        return { rows: [active, retired] }
      }
      return { rows: [] }
    }

    const decision = await loadActiveCurrentAttendanceRecordForDecisionTraceV1(query, {
      orgId: 'o', userId: 'u', workDate: '2026-08-01',
    })
    const makeup = await loadActiveCurrentAttendanceRecordForMakeupAnomalyFactsV1(query, {
      orgId: 'o', userId: 'u', workDate: '2026-08-01',
    })
    const listing = await listActiveCurrentAttendanceRecordsForAnomalyListingV1(query, {
      orgId: 'o', userId: 'u', from: '2026-08-01', to: '2026-08-07', excludedStatuses: ['normal'],
    })
    const open = await listActiveCurrentOpenRecordsForWorkDateResolverV1(query, {
      orgId: 'o', userId: 'u', workDates: ['2026-08-01'],
    })

    for (const rows of [[decision], [makeup], listing, open]) {
      const ids = rows.filter(Boolean).map((row) => (row as { id?: string }).id)
      expect(ids).not.toContain('retired-1')
      if (ids.length > 0) expect(ids).toContain('active-1')
    }
  })

  it('mutation: neutering one surface predicate exposes only that surface to the retired fixture', async () => {
    const active = { id: 'active-1', status: 'late' }
    const retired = { id: 'retired-1', status: 'late' }
    const moduleSource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../w4c3c-active-current.ts', import.meta.url), 'utf8'),
    )

    const surfaceBodies: Record<string, { fnName: string; call: (q: (sql: string) => Promise<{ rows: unknown[] }>) => Promise<unknown> }> = {
      anomaly_listing: {
        fnName: 'listActiveCurrentAttendanceRecordsForAnomalyListingV1',
        call: (q) => listActiveCurrentAttendanceRecordsForAnomalyListingV1(q, {
          orgId: 'o', userId: 'u', from: '2026-08-01', to: '2026-08-07', excludedStatuses: [],
        }),
      },
      makeup_anomaly_facts: {
        fnName: 'loadActiveCurrentAttendanceRecordForMakeupAnomalyFactsV1',
        call: (q) => loadActiveCurrentAttendanceRecordForMakeupAnomalyFactsV1(q, {
          orgId: 'o', userId: 'u', workDate: '2026-08-01',
        }),
      },
      open_record_attribution: {
        fnName: 'listActiveCurrentOpenRecordsForWorkDateResolverV1',
        call: (q) => listActiveCurrentOpenRecordsForWorkDateResolverV1(q, {
          orgId: 'o', userId: 'u', workDates: ['2026-08-01'],
        }),
      },
      decision_trace: {
        fnName: 'loadActiveCurrentAttendanceRecordForDecisionTraceV1',
        call: (q) => loadActiveCurrentAttendanceRecordForDecisionTraceV1(q, {
          orgId: 'o', userId: 'u', workDate: '2026-08-01',
        }),
      },
    }

    type Surface = 'anomaly_listing' | 'makeup_anomaly_facts' | 'open_record_attribution' | 'decision_trace'
    for (const [surface, meta] of Object.entries(surfaceBodies) as Array<[Surface, typeof surfaceBodies[string]]>) {
      // Positive: live source for this surface still carries the relation.
      const liveFnMatch = moduleSource.match(
        new RegExp(`export async function ${meta.fnName}[\\s\\S]*?(?=\\nexport async function |\\nexport function |$)`),
      )
      expect(liveFnMatch?.[0], surface).toBeTruthy()
      expect(() => assertActiveCurrentSurfaceSourceV1(surface, liveFnMatch![0])).not.toThrow()

      // Mutation: neuter only this surface's relation/constant → only this surface fails the source control.
      const neutered = liveFnMatch![0]
        .replaceAll('ATTENDANCE_ACTIVE_CURRENT_RELATION_V1', 'attendance_records')
        .replaceAll(ATTENDANCE_ACTIVE_CURRENT_RELATION_V1, 'attendance_records')
      expect(() =>
        assertActiveCurrentSurfaceSourceV1(surface, neutered),
      ).toThrowError(new RegExp(`ATTENDANCE_P20_ACTIVE_CURRENT_SURFACE_MISSING:${surface}`))

      // Other surfaces remain intact in the unmutated module source.
      for (const [other, otherMeta] of Object.entries(surfaceBodies) as Array<[Surface, typeof surfaceBodies[string]]>) {
        if (other === surface) continue
        const otherMatch = moduleSource.match(
          new RegExp(`export async function ${otherMeta.fnName}[\\s\\S]*?(?=\\nexport async function |\\nexport function |$)`),
        )
        expect(() =>
          assertActiveCurrentSurfaceSourceV1(other, otherMatch![0]),
        ).not.toThrow()
      }

      // Runtime: healthy surfaces never see retired rows via the view.
      const query = async (sql: string) => {
        if (sql.includes(ATTENDANCE_ACTIVE_CURRENT_RELATION_V1)) return { rows: [active] }
        if (/attendance_records/.test(sql)) return { rows: [active, retired] }
        return { rows: [] }
      }
      const result = await meta.call(query)
      const rows = Array.isArray(result) ? result : result ? [result] : []
      expect(rows.map((r) => (r as { id?: string }).id)).not.toContain('retired-1')
    }
  })
})
