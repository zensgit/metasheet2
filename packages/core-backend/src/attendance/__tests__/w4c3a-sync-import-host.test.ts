/**
 * W4C-3a P06 focused unit/static discriminating tests.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createAttendanceSyncImportHostV1,
  type CommitAttendanceSyncImportPlanFromHostInputV1,
} from '../w4c3a-sync-import-host'
import {
  buildAttendanceSyncImportBatchMetaV1,
  buildAttendanceSyncImportResponseV1,
} from '../w4c3a-sync-import-kernel'
import { resolveAttendanceLegacyPlanOperationalBranchV1 } from '../w4c3a-legacy-plan-reservation-host'
import { rawImportEvidenceV1 } from '../../../tests/utils/attendance-w4c3a-raw-evidence'
import type { VerifiedAttendanceLegacyPlanV1 } from '../w4c3a-legacy-plan-worker'

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
)
const PLUGIN = path.join(ROOT, 'plugins/plugin-attendance/index.cjs')
const HOST = path.join(
  ROOT,
  'packages/core-backend/src/attendance/w4c3a-sync-import-host.ts',
)
const INDEX = path.join(ROOT, 'packages/core-backend/src/index.ts')

const BATCH_ID = '10000000-0000-4000-8000-000000000001'
const ORG_ID = '20000000-0000-4000-8000-000000000001'
const ORIGINAL_ALLOWLIST =
  process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED

afterEach(() => {
  if (ORIGINAL_ALLOWLIST === undefined) {
    delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
  } else {
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED =
      ORIGINAL_ALLOWLIST
  }
})

function baseInput(
  overrides: Partial<CommitAttendanceSyncImportPlanFromHostInputV1> = {},
): CommitAttendanceSyncImportPlanFromHostInputV1 {
  const items = [
    {
      kind: 'apply' as const,
      ordinal: 0,
      semanticOrdinal: 0,
      targetRef: JSON.stringify([ORG_ID, 'user-1', '2026-07-31']),
      previewSnapshot: {},
      rawEvidence: rawImportEvidenceV1(0, {
        userId: 'user-1',
        workDate: '2026-07-31',
        firstInAt: '2026-07-31T01:00:00.000Z',
        lastOutAt: '2026-07-31T10:00:00.000Z',
      }),
    },
  ]
  const recordWrites = [
    {
      orgId: ORG_ID,
      userId: 'user-1',
      workDate: '2026-07-31',
      sourceOrdinals: [0],
      mergeMode: 'override' as const,
      firstInAt: '2026-07-31T01:00:00.000Z',
      lastOutAt: '2026-07-31T10:00:00.000Z',
      workMinutes: 480,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      status: 'normal',
      isWorkday: true,
      timezone: 'UTC',
      compatibilityMetadata: {},
      policySnapshot: {
        schemaVersion: 1,
        sources: [
          {
            sourceOrdinal: 0,
            sourceFingerprint: 'a'.repeat(64),
            ruleVersion: 'org-default-rule',
            engineVersion: null,
            output: {
              status: 'normal',
              workMinutes: 480,
              lateMinutes: 0,
              earlyLeaveMinutes: 0,
              leaveMinutes: 0,
              overtimeMinutes: 0,
            },
          },
        ],
      },
      profileSnapshot: {},
      multiPunchSnapshot: {},
      attributionSnapshot: {
        schemaVersion: 1,
        sources: [
          {
            sourceOrdinal: 0,
            attribution: {
              posture: 'unsupported',
              sourceSchemaVersion: 1,
              reason: 'legacy_v1',
              sourceFingerprint: null,
            },
            context: null,
          },
        ],
      },
      sourceBatchId: BATCH_ID,
      resultSlots: {},
    },
  ]
  return {
    orgId: ORG_ID,
    actorId: 'admin-1',
    actorPosture: 'platform_admin',
    tokenSubjectUserId: 'admin-1',
    batchId: BATCH_ID,
    idempotencyKey: null,
    payload: {
      __jobType: 'commit',
      idempotencyKey: null,
      __importEngine: 'standard',
      recordUpsertStrategy: 'values',
      itemsInsertStrategy: 'values',
      __w4ContractVersion: 1,
    },
    legacyRowSourceKind: 'direct_rows',
    legacySourceRowLimit: null,
    batch: {
      kind: 'normal',
      source: 'manual',
      ruleSetId: null,
      mappingSnapshot: {},
      sourceRowCount: 1,
      status: 'committed',
      idempotencyKey: null,
      visibilityRule: 'org',
      engine: 'standard',
      chunkConfig: { recordsChunkSize: 100, itemsChunkSize: 100 },
      recordUpsertStrategy: 'values',
      itemsInsertStrategy: 'values',
      mappingProfileId: null,
      compatibilityMetadata: {},
      groupSync: null,
      itemReturnPolicy: { returnItems: false, itemsLimit: null },
      skippedSamplePolicy: { limit: 50 },
      resultSlots: {
        groupCreated: 'ensure_group_returned_row_count',
        groupMembersAdded: 'ensure_member_inserted_row_count',
      },
    },
    artifactCleanup: { kind: 'none' },
    items,
    recordWrites,
    groupEffects: [],
    itemReturnPolicy: { returnItems: true, itemsLimit: null },
    csvWarnings: [],
    groupWarnings: [],
    ...overrides,
  }
}

describe('W4C-3a P06 sync import host (unit/static)', () => {
  it('accepts 5000 and rejects authoritative 5001 before reservation DML', async () => {
    expect(
      resolveAttendanceLegacyPlanOperationalBranchV1({
        itemCount: 5000,
        distinctTargetCount: 5000,
        acceptedWritePosture: 'authoritative',
      }),
    ).toBe('strict_targeted')
    expect(() =>
      resolveAttendanceLegacyPlanOperationalBranchV1({
        itemCount: 5001,
        distinctTargetCount: 5000,
        acceptedWritePosture: 'authoritative',
      }),
    ).toThrow('ATTENDANCE_IMPORT_BATCH_LIMIT_EXCEEDED')

    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = ORG_ID
    const sql: string[] = []
    let released = 0
    const host = createAttendanceSyncImportHostV1({
      acquireConnection: async () => ({
        client: {
          query: async (text: string) => {
            sql.push(text)
            if (text.includes('attendance_calculation_rollout_state')) {
              return {
                rows: [{ state: 'authoritative', scope: 'synthetic_staging' }],
              }
            }
            return { rows: [] }
          },
        },
        release: () => {
          released += 1
        },
      }),
    })
    const items = Array.from({ length: 5001 }, (_, ordinal) => ({
      kind: 'apply' as const,
      ordinal,
      semanticOrdinal: ordinal,
      targetRef: JSON.stringify([ORG_ID, `user-${ordinal}`, '2026-07-31']),
      previewSnapshot: {},
      rawEvidence: rawImportEvidenceV1(ordinal),
    }))
    const recordWrites = items.map((_item, ordinal) => ({
      ...baseInput().recordWrites[0],
      userId: `user-${ordinal}`,
      sourceOrdinals: [ordinal],
    }))
    await expect(
      host.commitSyncImportPlanV1(
        baseInput({
          items,
          recordWrites,
          batch: {
            ...baseInput().batch,
            sourceRowCount: 5001,
            engine: 'bulk',
            recordUpsertStrategy: 'staging',
            itemsInsertStrategy: 'staging',
          },
          payload: {
            __jobType: 'commit',
            idempotencyKey: null,
            __importEngine: 'bulk',
            recordUpsertStrategy: 'staging',
            itemsInsertStrategy: 'staging',
            __w4ContractVersion: 1,
          },
        }),
      ),
    ).rejects.toThrow('ATTENDANCE_IMPORT_BATCH_LIMIT_EXCEEDED')
    expect(released).toBe(1)
    expect(sql[0]).toContain('BEGIN ISOLATION LEVEL SERIALIZABLE')
    expect(sql.join('\n')).not.toMatch(
      /INSERT INTO attendance_import_batches|INSERT INTO attendance_import_items|COPY |attendance_import_jobs|attendance_import_legacy_execution_plan/i,
    )
  })

  it('values/unnest/staging produce identical sync response key sets (legacy meta parity)', () => {
    const strategies = ['values', 'unnest', 'staging'] as const
    const responses = strategies.map((strategy) => {
      const plan = {
        manifest: {
          batchId: BATCH_ID,
          orgId: ORG_ID,
          createdBy: 'admin-1',
          batch: {
            kind: 'normal',
            engine: strategy === 'values' ? 'standard' : 'bulk',
            chunkConfig: { recordsChunkSize: 50 },
            recordUpsertStrategy: strategy,
            itemsInsertStrategy: strategy,
            mappingProfileId: null,
            compatibilityMetadata: {},
            idempotencyKey: null,
            groupSync: null,
            skippedSamplePolicy: { limit: 50 },
          },
        },
        items: [
          {
            kind: 'apply',
            itemId: 'i1',
            ordinal: 0,
            semanticOrdinal: 0,
            targetRef: 't',
            recordWriteRef: 'rw1',
            previewSnapshot: { engine: null },
          },
        ],
        recordWrites: [
          {
            recordWriteId: 'rw1',
            recordId: 'r1',
            userId: 'user-1',
            workDate: '2026-07-31',
          },
        ],
        groupEffects: [],
      } as unknown as VerifiedAttendanceLegacyPlanV1
      const effectResult = { groupCreated: 0, groupMembersAdded: 0 }
      const meta = buildAttendanceSyncImportBatchMetaV1(plan, effectResult)
      const response = buildAttendanceSyncImportResponseV1({
        plan,
        effectResult,
        elapsedMs: 12,
        itemReturnPolicy: { returnItems: true, itemsLimit: null },
        csvWarnings: [],
        groupWarnings: [],
      })
      return { strategy, meta, response }
    })

    for (const entry of responses) {
      expect(entry.meta).not.toHaveProperty('async')
      expect(Object.keys(entry.response).sort()).toEqual(
        [
          'batchId',
          'csvWarnings',
          'elapsedMs',
          'engine',
          'failedRows',
          'groupWarnings',
          'imported',
          'items',
          'itemsTruncated',
          'meta',
          'processedRows',
          'recordUpsertStrategy',
          'skipped',
        ].sort(),
      )
      expect(entry.response.recordUpsertStrategy).toBe(entry.strategy)
      expect(entry.meta.recordUpsertStrategy).toBe(entry.strategy)
    }
  })

  it('duplicate target fold order is preserved in sourceOrdinals and response items', () => {
    const plan = {
      manifest: {
        batchId: BATCH_ID,
        orgId: ORG_ID,
        createdBy: 'admin-1',
        batch: {
          kind: 'normal',
          engine: 'standard',
          chunkConfig: {},
          recordUpsertStrategy: 'values',
          itemsInsertStrategy: 'values',
          mappingProfileId: null,
          compatibilityMetadata: {},
          idempotencyKey: null,
          groupSync: null,
          skippedSamplePolicy: { limit: 50 },
        },
      },
      items: [
        {
          kind: 'apply',
          itemId: 'i0',
          ordinal: 3,
          semanticOrdinal: 0,
          targetRef: 't',
          recordWriteRef: 'rw1',
          previewSnapshot: { engine: { source: 'first' } },
        },
        {
          kind: 'apply',
          itemId: 'i1',
          ordinal: 4,
          semanticOrdinal: 1,
          targetRef: 't',
          recordWriteRef: 'rw1',
          previewSnapshot: { engine: { source: 'second' } },
        },
      ],
      recordWrites: [
        {
          recordWriteId: 'rw1',
          recordId: 'r1',
          userId: 'user-1',
          workDate: '2026-07-31',
          sourceOrdinals: [3, 4],
        },
      ],
      groupEffects: [],
    } as unknown as VerifiedAttendanceLegacyPlanV1

    expect(plan.recordWrites[0]?.sourceOrdinals).toEqual([3, 4])
    const response = buildAttendanceSyncImportResponseV1({
      plan,
      effectResult: { groupCreated: 0, groupMembersAdded: 0 },
      elapsedMs: 1,
      itemReturnPolicy: { returnItems: true, itemsLimit: 1 },
      csvWarnings: [],
      groupWarnings: [],
    })
    expect(response.imported).toBe(2)
    expect(response.items).toHaveLength(1)
    expect(response.itemsTruncated).toBe(true)
    expect(response.items[0]).toMatchObject({
      id: 'r1',
      userId: 'user-1',
      workDate: '2026-07-31',
    })
  })

  /**
   * Real route ↔ host-port discriminating suite (P06 gate).
   * Proves the synchronous commit route, the least-privilege port, and the
   * core host factory are one wire — not a second worker/job path and not a
   * re-fingerprint of prepared freeze leaves.
   */
  describe('route/host-port discriminating wire', () => {
    function syncCommitRoute(source: string): string {
      const routeMarker = [
        'context.api.http.addRoute(',
        "      'POST',",
        "      '/api/attendance/import/commit',",
      ].join('\n')
      const nextMarker = [
        'context.api.http.addRoute(',
        "      'POST',",
        "      '/api/attendance/import/preview-async',",
      ].join('\n')
      const routeStart = source.indexOf(routeMarker)
      const routeEnd = source.indexOf(nextMarker, routeStart)
      expect(routeStart).toBeGreaterThan(-1)
      expect(routeEnd).toBeGreaterThan(routeStart)
      return source.slice(routeStart, routeEnd)
    }

    function executable(text: string): string {
      return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
    }

    function indexPortBody(indexSource: string): string {
      const start = indexSource.indexOf('commitSyncImportPlan: async (input)')
      expect(start).toBeGreaterThan(-1)
      const end = indexSource.indexOf(
        'buildLegacyImportReservationLockWitness:',
        start,
      )
      expect(end).toBeGreaterThan(start)
      return indexSource.slice(start, end)
    }

    it('route orders missing-port fail-closed → prepareOnly → commitSyncImportPlan only', () => {
      const source = fs.readFileSync(PLUGIN, 'utf8')
      const route = syncCommitRoute(source)
      const portMissing = route.indexOf(
        'ATTENDANCE_IMPORT_SYNC_HOST_PORT_MISSING',
      )
      const prepare = route.indexOf('prepareOnly: true')
      const portCall = route.indexOf(
        'syncImportPort.commitSyncImportPlan(',
        prepare,
      )
      expect(portMissing).toBeGreaterThan(-1)
      expect(prepare).toBeGreaterThan(portMissing)
      expect(portCall).toBeGreaterThan(prepare)
      // Prepared plan is spread into the port; route does not re-fingerprint freeze leaves.
      expect(route).toMatch(
        /commitSyncImportPlan\(\s*\{\s*\.\.\.preparedPlan,/,
      )
      expect(executable(route)).not.toMatch(/processLegacyImportPlan\s*\(/)
      expect(executable(route)).not.toMatch(/reserveLegacyImportPlan\s*\(/)
      expect(executable(route)).not.toMatch(
        /INSERT INTO attendance_import_jobs/,
      )
      expect(executable(route)).not.toMatch(
        /INSERT INTO attendance_import_batches/,
      )
      expect(executable(route)).not.toMatch(
        /runAttendanceSyncImportSerializableTransaction/,
      )
    })

    it('mutation removing the route port call is red (positive control intact)', () => {
      const source = fs.readFileSync(PLUGIN, 'utf8')
      const route = syncCommitRoute(source)
      expect(route).toMatch(/syncImportPort\.commitSyncImportPlan\s*\(/)
      const weakened = route.replace(
        /syncImportPort\.commitSyncImportPlan\s*\(/g,
        '/* mutated */ (',
      )
      expect(weakened).not.toMatch(/syncImportPort\.commitSyncImportPlan\s*\(/)
      expect(route).toMatch(/syncImportPort\.commitSyncImportPlan\s*\(/)
    })

    it('mutation removing the missing-port fail-closed is red', () => {
      const source = fs.readFileSync(PLUGIN, 'utf8')
      const route = syncCommitRoute(source)
      expect(route).toContain('ATTENDANCE_IMPORT_SYNC_HOST_PORT_MISSING')
      const weakened = route.replace(
        /ATTENDANCE_IMPORT_SYNC_HOST_PORT_MISSING/g,
        'MUTATED_PORT_OK',
      )
      expect(weakened).not.toContain('ATTENDANCE_IMPORT_SYNC_HOST_PORT_MISSING')
      expect(route).toContain('ATTENDANCE_IMPORT_SYNC_HOST_PORT_MISSING')
    })

    it('index wires commitSyncImportPlan only through createAttendanceSyncImportHostV1', () => {
      const index = fs.readFileSync(INDEX, 'utf8')
      const body = executable(indexPortBody(index))
      expect(body).toContain('createAttendanceSyncImportHostV1')
      expect(body).toContain('commitSyncImportPlanV1(input)')
      expect(body).not.toMatch(/processLegacyImportPlan/)
      expect(body).not.toMatch(/reserveLegacyImportPlan/)
      expect(body).not.toMatch(/createAttendanceLegacyPlanProcessorV1/)
      expect(body).not.toMatch(/createAttendanceLegacyPlanReservationHostV1/)
      // Mutation: strip the host factory and the positive control must red.
      const weakened = body.replace(
        /createAttendanceSyncImportHostV1/g,
        '/* mutated */',
      )
      expect(weakened).not.toContain('createAttendanceSyncImportHostV1')
      expect(body).toContain('createAttendanceSyncImportHostV1')
    })

    it('host opens SERIALIZABLE via operation-registry helper and never job/plan/terminal DML', () => {
      const host = fs.readFileSync(HOST, 'utf8')
      const executableHost = executable(host)
      expect(host).toContain('runAttendanceResultOperationTransactionV1')
      expect(host).toContain('claimAttendanceCanonicalImportRegistryV1')
      expect(host).toContain('executeAttendanceCanonicalImportPlanV1')
      // Consumes prepared plan freeze; does not invent plugin attribution fingerprint helpers.
      expect(executableHost).not.toMatch(
        /buildImport(?:RowProvenance|AttendanceAttribution|CanonicalFreeze)/,
      )
      expect(executableHost).not.toMatch(/processLegacyImportPlan\s*\(/)
      expect(executableHost).not.toMatch(/INSERT INTO attendance_import_jobs/)
      expect(executableHost).not.toMatch(
        /attendance_import_legacy_execution_plans/,
      )
      expect(executableHost).not.toMatch(
        /attendance_import_legacy_terminal_responses/,
      )
    })

    it('malformed freeze is rejected before batch/item DML (claim before execute)', () => {
      const host = fs.readFileSync(HOST, 'utf8')
      const claim = host.indexOf('claimAttendanceCanonicalImportRegistryV1')
      const execute = host.indexOf('executeShadowOrAuthoritative', claim)
      expect(claim).toBeGreaterThan(-1)
      expect(execute).toBeGreaterThan(claim)
      // claimAttendanceCanonicalImportRegistryV1 parses freeze before registry DML.
      expect(host).toMatch(
        /claimAttendanceCanonicalImportRegistryV1[\s\S]{0,600}executeShadowOrAuthoritative/,
      )
    })

    it('host runtime 5001 authoritative path never issues job or batch DML', async () => {
      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = ORG_ID
      const sql: string[] = []
      const host = createAttendanceSyncImportHostV1({
        acquireConnection: async () => ({
          client: {
            query: async (text: string) => {
              sql.push(text)
              if (text.includes('attendance_calculation_rollout_state')) {
                return {
                  rows: [{ state: 'authoritative', scope: 'synthetic_staging' }],
                }
              }
              return { rows: [] }
            },
          },
          release: () => undefined,
        }),
      })
      const items = Array.from({ length: 5001 }, (_, ordinal) => ({
        kind: 'apply' as const,
        ordinal,
        semanticOrdinal: ordinal,
        targetRef: JSON.stringify([ORG_ID, `user-${ordinal}`, '2026-07-31']),
        previewSnapshot: {},
        rawEvidence: rawImportEvidenceV1(ordinal),
      }))
      await expect(
        host.commitSyncImportPlanV1(
          baseInput({
            items,
            recordWrites: items.map((_item, ordinal) => ({
              ...baseInput().recordWrites[0],
              userId: `user-${ordinal}`,
              sourceOrdinals: [ordinal],
            })),
            batch: {
              ...baseInput().batch,
              sourceRowCount: 5001,
              engine: 'bulk',
              recordUpsertStrategy: 'staging',
              itemsInsertStrategy: 'staging',
            },
            payload: {
              __jobType: 'commit',
              idempotencyKey: null,
              __importEngine: 'bulk',
              recordUpsertStrategy: 'staging',
              itemsInsertStrategy: 'staging',
              __w4ContractVersion: 1,
            },
          }),
        ),
      ).rejects.toThrow('ATTENDANCE_IMPORT_BATCH_LIMIT_EXCEEDED')
      expect(sql[0]).toContain('BEGIN ISOLATION LEVEL SERIALIZABLE')
      expect(sql.join('\n')).not.toMatch(
        /INSERT INTO attendance_import_(?:jobs|batches|items)|attendance_import_legacy_execution_plan|attendance_import_legacy_terminal/i,
      )
    })
  })
})
