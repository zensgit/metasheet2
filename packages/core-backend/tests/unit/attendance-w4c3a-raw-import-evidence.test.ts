/**
 * W4C-3a raw import evidence + frozen import snapshot producers
 * (plugins/plugin-attendance/index.cjs prepareOnly path).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseRawImportEvidenceV1 } from '../../src/attendance/w4c3a-legacy-execution-plan'

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
)
const PLUGIN = path.join(ROOT, 'plugins/plugin-attendance/index.cjs')
const require = createRequire(import.meta.url)
const attendancePlugin = require(PLUGIN) as {
  __attendanceImportForTests: {
    rawImportFieldPresence(value: unknown): { present: boolean; value: unknown }
    firstDefinedPresence(...candidates: unknown[]): unknown
    buildRawImportEvidenceV1(options: Record<string, unknown>): Record<string, unknown>
    buildImportRowProvenanceV1(options: Record<string, unknown>): Record<string, unknown>
    buildFrozenImportSnapshotV1(options: Record<string, unknown>): Record<string, unknown>
    buildImportAttendanceAttributionSnapshotV1(
      options: Record<string, unknown>,
    ): Record<string, unknown>
    buildImportCanonicalFreezeSourceV1(options: Record<string, unknown>): Record<string, unknown>
    buildClosedImportAttributionSnapshotV1(
      sources: readonly Record<string, unknown>[],
    ): { schemaVersion: 1; sources: readonly Record<string, unknown>[] }
    buildClosedImportPolicySnapshotV1(
      sources: readonly Record<string, unknown>[],
    ): { schemaVersion: 1; sources: readonly Record<string, unknown>[] }
    computeImportPolicySourceFingerprintV1(options: Record<string, unknown>): string
    resolveLegacyImportRowSourceKind(options: {
      payload: Record<string, unknown>
      csvFileId?: string | null
    }): string
    sha256HexOfUtf8(text: string): string
  }
  __attendanceW4C3aSyncCompatibilityForTests: {
    foldAttendanceImportPreparedTargets(input: {
      items: readonly Record<string, unknown>[]
      existingMap: Map<string, Record<string, unknown>>
      orgId: string
      sourceBatchId: string
    }): {
      recordWrites: readonly Record<string, unknown>[]
      targetRefBySourceOrdinal: Map<number, string>
    }
  }
}

const helpers = attendancePlugin.__attendanceImportForTests
const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)

describe('W4C-3a raw import evidence producer', () => {
  it('distinguishes present-null from absent for fields and metrics', () => {
    const absent = helpers.buildRawImportEvidenceV1({
      sourceOrdinal: 0,
      fields: {
        userId: 'user-1',
        workDate: '2026-07-30',
        // firstInAt / lastOutAt / status / timezone / isWorkday omitted ⇒ absent
      },
      metrics: {
        // workMinutes omitted ⇒ absent
        lateMinutes: null, // present-null
      },
      provenance: helpers.buildImportRowProvenanceV1({
        legacyRowSourceKind: 'direct_rows',
        batchId: 'batch-1',
      }),
    })

    expect(absent.fields.firstInAt).toEqual({ present: false, value: null })
    expect(absent.fields.lastOutAt).toEqual({ present: false, value: null })
    expect(absent.fields.status).toEqual({ present: false, value: null })
    expect(absent.metrics.workMinutes).toEqual({ present: false, value: null })
    expect(absent.metrics.lateMinutes).toEqual({ present: true, value: null })
    expect(absent.punches).toEqual([])

    const presentNull = helpers.buildRawImportEvidenceV1({
      sourceOrdinal: 1,
      fields: {
        userId: 'user-1',
        workDate: '2026-07-30',
        firstInAt: null,
        lastOutAt: null,
        status: null,
        timezone: null,
        isWorkday: null,
      },
      metrics: {
        workMinutes: null,
        lateMinutes: null,
        earlyLeaveMinutes: null,
        leaveMinutes: null,
        overtimeMinutes: null,
      },
      provenance: helpers.buildImportRowProvenanceV1({
        legacyRowSourceKind: 'direct_rows',
        batchId: 'batch-1',
      }),
    })

    expect(presentNull.fields.firstInAt).toEqual({ present: true, value: null })
    expect(presentNull.fields.lastOutAt).toEqual({ present: true, value: null })
    expect(presentNull.fields.status).toEqual({ present: true, value: null })
    expect(presentNull.metrics.workMinutes).toEqual({ present: true, value: null })
    expect(presentNull.punches).toEqual([])

    // Strict durable-plan parser accepts both shapes.
    expect(parseRawImportEvidenceV1(absent)).toMatchObject({ sourceOrdinal: 0 })
    expect(parseRawImportEvidenceV1(presentNull)).toMatchObject({ sourceOrdinal: 1 })
  })

  it('preserves zero-valued metrics and derives punches only from present instants', () => {
    const firstIn = '2026-07-30T01:00:00.000Z'
    const lastOut = '2026-07-30T10:00:00.000Z'
    const evidence = helpers.buildRawImportEvidenceV1({
      sourceOrdinal: 2,
      fields: {
        userId: 'user-z',
        workDate: '2026-07-30',
        timezone: 'Asia/Shanghai',
        firstInAt: new Date(firstIn),
        lastOutAt: new Date(lastOut),
        status: 'normal',
        isWorkday: true,
      },
      metrics: {
        workMinutes: 0,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        leaveMinutes: 0,
        overtimeMinutes: 0,
      },
      provenance: helpers.buildImportRowProvenanceV1({
        legacyRowSourceKind: 'entries',
        batchId: 'batch-z',
      }),
    })

    expect(evidence.metrics.workMinutes).toEqual({ present: true, value: 0 })
    expect(evidence.metrics.lateMinutes).toEqual({ present: true, value: 0 })
    expect(evidence.punches).toEqual([
      { direction: 'check_in', occurredAt: firstIn },
      { direction: 'check_out', occurredAt: lastOut },
    ])
    expect(parseRawImportEvidenceV1(evidence).punches).toHaveLength(2)

    // Mutation-discriminating: zero → non-zero must change the closed evidence shape.
    const mutated = helpers.buildRawImportEvidenceV1({
      sourceOrdinal: 2,
      fields: {
        userId: 'user-z',
        workDate: '2026-07-30',
        timezone: 'Asia/Shanghai',
        firstInAt: new Date(firstIn),
        lastOutAt: new Date(lastOut),
        status: 'normal',
        isWorkday: true,
      },
      metrics: {
        workMinutes: 1,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        leaveMinutes: 0,
        overtimeMinutes: 0,
      },
      provenance: helpers.buildImportRowProvenanceV1({
        legacyRowSourceKind: 'entries',
        batchId: 'batch-z',
      }),
    })
    expect(mutated.metrics.workMinutes).not.toEqual(evidence.metrics.workMinutes)
    expect(JSON.stringify(mutated)).not.toBe(JSON.stringify(evidence))
  })

  it('differentiates uploaded vs inline CSV provenance without leaking paths', () => {
    const inlineText = 'userId,workDate\nu1,2026-07-30\n'
    const inlineHash = helpers.sha256HexOfUtf8(inlineText)
    const inline = helpers.buildImportRowProvenanceV1({
      legacyRowSourceKind: 'inline_csv',
      batchId: 'batch-inline',
      normalizedCsvSha256: inlineHash,
    })
    const uploaded = helpers.buildImportRowProvenanceV1({
      legacyRowSourceKind: 'uploaded_csv',
      batchId: 'batch-upload',
      csvFileId: '10000000-0000-4000-8000-000000000099',
      artifactSha256: HEX_A,
      normalizedCsvSha256: HEX_B,
    })
    const direct = helpers.buildImportRowProvenanceV1({
      legacyRowSourceKind: 'direct_rows',
      batchId: 'batch-rows',
    })
    const entries = helpers.buildImportRowProvenanceV1({
      legacyRowSourceKind: 'entries',
      batchId: 'batch-entries',
    })
    const dingtalk = helpers.buildImportRowProvenanceV1({
      legacyRowSourceKind: 'dingtalk_tabular',
      batchId: 'batch-dt',
    })

    expect(inline.transport).toBe('csv_text')
    expect(inline.normalizedCsvSha256).toBe(inlineHash)
    expect(inline.artifactSha256).toBeNull()
    expect(inline.sourceRef).toBe('attendance-import:batch-inline:inline_csv')

    expect(uploaded.transport).toBe('csv_upload')
    expect(uploaded.artifactSha256).toBe(HEX_A)
    expect(uploaded.normalizedCsvSha256).toBe(HEX_B)
    expect(uploaded.sourceRef).toContain('uploaded_csv:10000000-0000-4000-8000-000000000099')
    expect(uploaded.sourceRef).not.toMatch(/[/\\]/)
    expect(JSON.stringify(uploaded)).not.toMatch(/uploads|attendance-import\//)

    expect(direct.transport).toBe('rows')
    expect(entries.transport).toBe('rows')
    expect(dingtalk.transport).toBe('rows')
    expect(direct.sourceRef).toContain('direct_rows')
    expect(entries.sourceRef).toContain('entries')
    expect(dingtalk.sourceRef).toContain('dingtalk_tabular')
    expect(new Set([direct.sourceRef, entries.sourceRef, dingtalk.sourceRef]).size).toBe(3)

    // Parser-valid closed provenance for every variant.
    for (const provenance of [inline, uploaded, direct, entries, dingtalk]) {
      expect(
        parseRawImportEvidenceV1(
          helpers.buildRawImportEvidenceV1({
            sourceOrdinal: 0,
            fields: { userId: 'u', workDate: '2026-07-30' },
            metrics: {},
            provenance,
          }),
        ).provenance.transport,
      ).toBe(provenance.transport)
    }
  })

  it('builds closed attribution/policy freeze wrappers that match sourceOrdinals', () => {
    const unsupported = {
      posture: 'unsupported',
      sourceSchemaVersion: null,
      reason: 'missing',
      sourceFingerprint: null,
    }
    const context = {
      schemaVersion: 1,
      selector: 'legacy',
      orgId: 'org-1',
      userId: 'user-1',
      workDate: '2026-07-30',
      timezone: 'Asia/Shanghai',
      shiftId: 'shift-1',
      isWorkday: true,
      holidayKind: null,
      calculationGroupId: null,
      roundingMinutes: 0,
      severeLateThresholdMinutes: 30,
      absenceLateThresholdMinutes: 60,
      segments: [
        {
          index: 0,
          startTime: '09:00',
          endTime: '18:00',
          startDayOffset: 0,
          endDayOffset: 0,
          lateGraceMinutes: 0,
          earlyLeaveGraceMinutes: 0,
        },
      ],
    }
    const sources = [2, 0, 1].map((ordinal) =>
      helpers.buildImportCanonicalFreezeSourceV1({
        sourceOrdinal: ordinal,
        attribution: unsupported,
        context: ordinal === 0 ? context : null,
        ruleVersion: 'org-default-rule',
        engineVersion: null,
        rule: {
          timezone: 'Asia/Shanghai',
          workStartTime: '09:00',
          workEndTime: '18:00',
          lateGraceMinutes: 0,
          earlyGraceMinutes: 0,
          roundingMinutes: 1,
          workingDays: [1, 2, 3, 4, 5],
        },
        output: {
          status: 'normal',
          workMinutes: 0,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          leaveMinutes: 0,
          overtimeMinutes: 0,
        },
      }),
    )

    const attributionSnapshot = helpers.buildClosedImportAttributionSnapshotV1(sources)
    const policySnapshot = helpers.buildClosedImportPolicySnapshotV1(sources)
    expect(attributionSnapshot).toEqual({
      schemaVersion: 1,
      sources: [
        { sourceOrdinal: 0, attribution: unsupported, context },
        { sourceOrdinal: 1, attribution: unsupported, context: null },
        { sourceOrdinal: 2, attribution: unsupported, context: null },
      ],
    })
    expect(policySnapshot.schemaVersion).toBe(1)
    expect(policySnapshot.sources.map((row) => row.sourceOrdinal)).toEqual([0, 1, 2])
    for (const row of policySnapshot.sources) {
      expect(Object.keys(row).sort()).toEqual([
        'engineVersion',
        'output',
        'ruleVersion',
        'sourceFingerprint',
        'sourceOrdinal',
      ])
      expect(row.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect(row.ruleVersion).toBe('org-default-rule')
      expect(row.engineVersion).toBeNull()
      expect(Object.keys(row.output as object).sort()).toEqual([
        'earlyLeaveMinutes',
        'lateMinutes',
        'leaveMinutes',
        'overtimeMinutes',
        'status',
        'workMinutes',
      ])
      expect((row.output as { workMinutes: number }).workMinutes).toBe(0)
    }

    // Single-target wrapper uses the same shape.
    const single = helpers.buildClosedImportAttributionSnapshotV1([sources[1]])
    expect(single).toEqual({
      schemaVersion: 1,
      sources: [{ sourceOrdinal: 0, attribution: unsupported, context }],
    })

    // Fingerprint ignores mutable metric bytes — same rule inputs ⇒ same hash.
    const fpA = helpers.computeImportPolicySourceFingerprintV1({
      ruleVersion: 'org-default-rule',
      engineVersion: null,
      rule: { timezone: 'UTC', workStartTime: '09:00', workEndTime: '18:00', workingDays: [1, 5, 3] },
    })
    const fpB = helpers.computeImportPolicySourceFingerprintV1({
      ruleVersion: 'org-default-rule',
      engineVersion: null,
      rule: { timezone: 'UTC', workStartTime: '09:00', workEndTime: '18:00', workingDays: [5, 1, 3] },
    })
    expect(fpA).toBe(fpB)
    expect(fpA).toMatch(/^[0-9a-f]{64}$/)
  })

  it('builds unsupported/resolved_v2 attribution snapshots from import resolution', () => {
    expect(
      helpers.buildImportAttendanceAttributionSnapshotV1({
        orgId: 'org-1',
        userId: 'user-1',
        resolution: null,
      }),
    ).toEqual({
      posture: 'unsupported',
      sourceSchemaVersion: null,
      reason: 'missing',
      sourceFingerprint: null,
    })

    const absoluteStart = '2026-07-30T01:00:00.000Z'
    const absoluteEnd = '2026-07-30T10:00:00.000Z'
    const resolved = helpers.buildImportAttendanceAttributionSnapshotV1({
      orgId: 'org-1',
      userId: 'user-1',
      nowIso: '2026-07-30T12:00:00.000Z',
      resolution: {
        kind: 'resolved',
        workDate: '2026-07-30',
        shiftId: 'shift-1',
        reasonCode: 'CURRENT_DAY_CONTAINING_SHIFT',
        attributionTailMinutes: 0,
        approvedOvertimeWindows: [],
        fullWinner: {
          workStartTime: '09:00',
          workEndTime: '18:00',
          timezone: 'Asia/Shanghai',
          isOvernight: false,
          absoluteWindow: {
            startAt: new Date(absoluteStart),
            endAt: new Date(absoluteEnd),
          },
          attributionWindow: {
            startAt: new Date(absoluteStart),
            endAt: new Date(absoluteEnd),
          },
        },
      },
    })
    expect(resolved.posture).toBe('resolved_v2')
    expect(resolved).toMatchObject({
      posture: 'resolved_v2',
      value: {
        schemaVersion: 2,
        orgId: 'org-1',
        userId: 'user-1',
        workDate: '2026-07-30',
        shiftId: 'shift-1',
        source: 'import_resolution',
        absoluteWindow: { startAt: absoluteStart, endAt: absoluteEnd },
        attributionWindow: { startAt: absoluteStart, endAt: absoluteEnd },
        attributionTailMinutes: 0,
        extendedByApprovedOvertime: false,
      },
    })
    expect((resolved.value as { windowEvidenceFingerprint: string }).windowEvidenceFingerprint).toMatch(
      /^[0-9a-f]{64}$/,
    )
  })

  it('fold emits identical closed freeze wrappers for single and multi-source targets', () => {
    const fold = attendancePlugin.__attendanceW4C3aSyncCompatibilityForTests
      .foldAttendanceImportPreparedTargets
    const freeze0 = helpers.buildImportCanonicalFreezeSourceV1({
      sourceOrdinal: 3,
      attribution: {
        posture: 'unsupported',
        sourceSchemaVersion: null,
        reason: 'unresolved',
        sourceFingerprint: null,
      },
      context: null,
      ruleVersion: 'org-default-rule',
      engineVersion: null,
      rule: { timezone: 'UTC', workStartTime: '09:00', workEndTime: '18:00', workingDays: [1] },
      output: {
        status: 'late',
        workMinutes: 60,
        lateMinutes: 15,
        earlyLeaveMinutes: 0,
        leaveMinutes: 0,
        overtimeMinutes: 0,
      },
    })
    const freeze1 = helpers.buildImportCanonicalFreezeSourceV1({
      sourceOrdinal: 4,
      attribution: {
        posture: 'unsupported',
        sourceSchemaVersion: null,
        reason: 'unresolved',
        sourceFingerprint: null,
      },
      context: null,
      ruleVersion: 'org-default-rule',
      engineVersion: null,
      rule: { timezone: 'UTC', workStartTime: '09:00', workEndTime: '18:00', workingDays: [1] },
      output: {
        status: 'normal',
        workMinutes: 480,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        leaveMinutes: 0,
        overtimeMinutes: 0,
      },
    })
    const common = {
      userId: 'user-1',
      workDate: '2026-07-31',
      timezone: 'Asia/Taipei',
      mode: 'override',
      statusOverride: null,
      overrideMetrics: {
        workMinutes: 480,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        status: 'normal',
      },
      isWorkday: true,
      meta: {},
      sourceBatchId: '10000000-0000-4000-8000-000000000001',
      rule: {
        timezone: 'Asia/Taipei',
        workStartTime: '09:00',
        workEndTime: '18:00',
        lateGraceMinutes: 0,
        earlyGraceMinutes: 0,
        roundingMinutes: 1,
      },
      leaveMinutes: 0,
      overtimeMinutes: 0,
      updateLastOutAt: null,
    }
    const multi = fold({
      items: [
        {
          ...common,
          sourceOrdinal: 4,
          updateFirstInAt: new Date('2026-07-31T01:00:00.000Z'),
          canonicalFreezeSource: freeze1,
        },
        {
          ...common,
          sourceOrdinal: 3,
          updateFirstInAt: new Date('2026-07-31T01:30:00.000Z'),
          statusOverride: 'late',
          overrideMetrics: {
            workMinutes: 60,
            lateMinutes: 15,
            earlyLeaveMinutes: 0,
            status: 'late',
          },
          canonicalFreezeSource: freeze0,
        },
      ],
      existingMap: new Map(),
      orgId: 'org-1',
      sourceBatchId: common.sourceBatchId,
    })
    expect(multi.recordWrites).toHaveLength(1)
    const write = multi.recordWrites[0] as {
      sourceOrdinals: number[]
      attributionSnapshot: { schemaVersion: number; sources: { sourceOrdinal: number }[] }
      policySnapshot: { schemaVersion: number; sources: { sourceOrdinal: number }[] }
    }
    expect(write.sourceOrdinals).toEqual([3, 4])
    expect(write.attributionSnapshot.schemaVersion).toBe(1)
    expect(write.policySnapshot.schemaVersion).toBe(1)
    expect(write.attributionSnapshot.sources.map((s) => s.sourceOrdinal)).toEqual([3, 4])
    expect(write.policySnapshot.sources.map((s) => s.sourceOrdinal)).toEqual([3, 4])
    expect(Object.keys(write.attributionSnapshot.sources[0] as object).sort()).toEqual([
      'attribution',
      'context',
      'sourceOrdinal',
    ])
    expect(Object.keys(write.policySnapshot.sources[0] as object).sort()).toEqual([
      'engineVersion',
      'output',
      'ruleVersion',
      'sourceFingerprint',
      'sourceOrdinal',
    ])

    const single = fold({
      items: [
        {
          ...common,
          sourceOrdinal: 7,
          updateFirstInAt: new Date('2026-07-31T01:00:00.000Z'),
          canonicalFreezeSource: {
            ...freeze0,
            sourceOrdinal: 7,
          },
        },
      ],
      existingMap: new Map(),
      orgId: 'org-1',
      sourceBatchId: common.sourceBatchId,
    })
    const singleWrite = single.recordWrites[0] as {
      sourceOrdinals: number[]
      attributionSnapshot: { schemaVersion: number; sources: unknown[] }
      policySnapshot: { schemaVersion: number; sources: unknown[] }
    }
    expect(singleWrite.sourceOrdinals).toEqual([7])
    expect(singleWrite.attributionSnapshot.schemaVersion).toBe(1)
    expect(singleWrite.policySnapshot.schemaVersion).toBe(1)
    expect(singleWrite.attributionSnapshot.sources).toHaveLength(1)
    expect(singleWrite.policySnapshot.sources).toHaveLength(1)
  })

  it('classifies legacy row source kinds for provenance selection', () => {
    expect(
      helpers.resolveLegacyImportRowSourceKind({
        payload: { rows: [{ workDate: '2026-07-30' }] },
      }),
    ).toBe('direct_rows')
    expect(
      helpers.resolveLegacyImportRowSourceKind({
        payload: { entries: [{ userId: 'u' }] },
      }),
    ).toBe('entries')
    expect(
      helpers.resolveLegacyImportRowSourceKind({
        payload: { csvText: 'a,b\n1,2\n' },
      }),
    ).toBe('inline_csv')
    expect(
      helpers.resolveLegacyImportRowSourceKind({
        payload: {},
        csvFileId: '10000000-0000-4000-8000-000000000001',
      }),
    ).toBe('uploaded_csv')
    expect(
      helpers.resolveLegacyImportRowSourceKind({
        payload: { columns: [], data: [] },
      }),
    ).toBe('dingtalk_tabular')
  })
})

describe('W4C-3a prepareOnly rawEvidence wiring (static + mutation)', () => {
  const source = fs.readFileSync(PLUGIN, 'utf8')

  it('requests full winner for import attribution freeze and attaches rawEvidence on plan items', () => {
    expect(source).toMatch(/includeFullWinner:\s*true/)
    expect(source).toContain('buildRawImportEvidenceV1')
    expect(source).toContain('buildImportRowProvenanceV1')
    expect(source).toContain('buildImportAttendanceAttributionSnapshotV1')
    expect(source).toContain('buildClosedImportAttributionSnapshotV1')
    expect(source).toContain('buildClosedImportPolicySnapshotV1')
    expect(source).toContain('buildW4ShadowFrozenContextV1')
    expect(source).toContain('canonicalFreezeSource')

    const prepareFn = source.slice(
      source.indexOf('const commitAttendanceImportPayload = async'),
      source.indexOf('// Register queue processor'),
    )
    expect(prepareFn).toMatch(/rawEvidence:\s*item\.rawEvidence/)
    expect(prepareFn).toMatch(/kind:\s*'skip'[\s\S]*rawEvidence/)
    expect(prepareFn).toMatch(/Attendance prepareOnly apply item missing rawEvidence/)
    // Imported values captured before computed overrides.
    expect(prepareFn).toMatch(
      /Raw evidence must bind imported values before computed\/policy\/engine overrides/,
    )
    expect(prepareFn.indexOf('const rowRawEvidence = prepareOnly')).toBeLessThan(
      prepareFn.indexOf('const computed = computeMetrics'),
    )
    // Closed freeze wrappers on every recordWrite (single + folded).
    expect(source).toContain('attributionSnapshot: buildClosedImportAttributionSnapshotV1(freezeSources)')
    expect(source).toContain('policySnapshot: buildClosedImportPolicySnapshotV1(freezeSources)')
  })

  it('mutation-discriminates rawEvidence requirement on prepareOnly apply items', () => {
    const guardRe =
      /if\s*\(\s*!item\.rawEvidence\s*\)\s*\{\s*throw new Error\('Attendance prepareOnly apply item missing rawEvidence'\)\s*\}/
    expect(source).toMatch(guardRe)
    const weakened = source.replace(guardRe, '/* rawEvidence guard removed */')
    expect(weakened).not.toContain('Attendance prepareOnly apply item missing rawEvidence')
    // Restoring the guard is load-bearing for the prepareOnly plan contract.
    expect(source).toContain('Attendance prepareOnly apply item missing rawEvidence')
  })
})
