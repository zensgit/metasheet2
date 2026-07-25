import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Pool } from 'pg'
import {
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  createVerifiedAttendanceCalculationTargetIdentityV1,
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceCalculationTargetLocks,
  acquireAttendanceResultOperationLocks,
  buildAttendanceCalculationRolloutAdvisoryKey,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  resolveSegmentCalculationPosture,
  type AttendanceW4TransactionClientV1,
  type VerifiedAttendanceOrgIdentityV1,
} from '../../src/attendance/w4c0-identity'

/**
 * W4C-0 (#4556) Stage B — TS/SQL golden parity + advisory acquisition against real Postgres.
 *
 * Amendment section 1.3: "A mandatory TS/SQL golden-parity gate covers all three namespaces
 * and rejects namespace, NUL, tuple-order, endian, version-bit, or variant-bit drift."
 *
 *  - the three pinned UUIDv5 goldens must be reproduced independently by BOTH the TS factory
 *    and the Stage A SQL function `attendance_w4_uuidv5` (byte-for-byte namespace + NUL name
 *    bytes parity — the same literals are pinned in src/attendance/__tests__/w4c0-identity.test.ts);
 *  - randomized inputs agree between TS derivation and SQL derivation for import/integration/
 *    scheduled shapes (catches tuple-order/NUL/endian drift beyond the fixed goldens);
 *  - the canonical SQL date text function agrees with the TS canonical work-date form;
 *  - the acquisition helpers take REAL pg_advisory_xact locks: pg_locks shows the exact
 *    classid/objid split of the signed 64-bit golden keys with the expected ShareLock/
 *    ExclusiveLock modes, held only for the transaction.
 */
const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const ORG = '55555555-5555-4555-8555-555555555555'
const IMPORT_ROOT = '11111111-1111-4111-8111-111111111111'
const INTEGRATION_ROOT = '22222222-2222-4222-8222-222222222222'
const SCHED_RUN = '33333333-3333-4333-8333-333333333333'
const SCHED_USER = '44444444-4444-4444-8444-444444444444'
const SCHED_DATE = '2026-03-01'
const FP_A = 'a'.repeat(64)
const FP_B = 'b'.repeat(64)

const GOLDEN_IMPORT_ITEM_UUID = 'e22b42e2-c607-50b4-8bcf-dcc383d15bc3'
const GOLDEN_INTEGRATION_ITEM_UUID = 'c3bf2b78-8f9e-5b45-a441-772905c30e4e'
const GOLDEN_SCHEDULED_UUID = '3e1fa29a-f411-5840-bed0-4c0f92c9f140'
const GOLDEN_ROLLOUT_KEY_ORG = 2207163269983992351n
const GOLDEN_OPERATION_KEY_ITEM = -9078275941089543826n
const GOLDEN_TARGET_KEY = -4551290893819917091n
const DIRECT_ID = '66666666-6666-4666-8666-666666666666'

const IMPORT_NS = '6f67fdaa-e2aa-48b3-b76c-c4aab9723173'
const INTEGRATION_NS = '46501375-c273-459f-a5af-f926859f6411'
const SCHEDULED_NS = 'e4363171-f53f-47d7-a074-607ef3fad391'

/** classid = high 32 bits, objid = low 32 bits of the signed-bigint advisory key (as u64). */
function lockIdParts(key: bigint): { classid: number; objid: number } {
  const u64 = BigInt.asUintN(64, key)
  return { classid: Number(u64 >> 32n), objid: Number(u64 & 0xffffffffn) }
}

function trxClient(client: { query: (sqlText: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): AttendanceW4TransactionClientV1 {
  return {
    query: (sqlText, params) => client.query(sqlText, params) as Promise<{ rows: Array<Record<string, unknown>> }>,
  }
}

async function mintOrg(trx: AttendanceW4TransactionClientV1): Promise<VerifiedAttendanceOrgIdentityV1> {
  const posture = await resolveSegmentCalculationPosture(trx, ORG)
  return createVerifiedAttendanceOrgIdentityV1({ orgKey: ORG, posture })
}

describeIfDatabase('W4C-0 Stage B — TS/SQL identity golden parity (real DB)', () => {
  it('reproduces all three pinned namespace goldens through the SQL boundary function', async () => {
    const pool = new Pool({ connectionString: dbUrl })
    try {
      const importRow = await pool.query(
        'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $3))::text AS v',
        [IMPORT_NS, IMPORT_ROOT, FP_A],
      )
      expect(importRow.rows[0].v).toBe(GOLDEN_IMPORT_ITEM_UUID)
      const integrationRow = await pool.query(
        'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 7, $3))::text AS v',
        [INTEGRATION_NS, INTEGRATION_ROOT, FP_B],
      )
      expect(integrationRow.rows[0].v).toBe(GOLDEN_INTEGRATION_ITEM_UUID)
      const scheduledRow = await pool.query(
        'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_scheduled_name_bytes($2::uuid, $3::uuid, $4::date))::text AS v',
        [SCHEDULED_NS, SCHED_RUN, SCHED_USER, SCHED_DATE],
      )
      expect(scheduledRow.rows[0].v).toBe(GOLDEN_SCHEDULED_UUID)
      // canonical date text parity (leap day exercises the IMMUTABLE lpad/extract SQL form)
      const dateRow = await pool.query('SELECT attendance_w4_canonical_date_text($1::date) AS v', ['2028-02-29'])
      expect(dateRow.rows[0].v).toBe('2028-02-29')
    } finally {
      await pool.end()
    }
  })

  it('agrees with TS derivation on randomized import/integration/scheduled tuples', async () => {
    const pool = new Pool({ connectionString: dbUrl })
    try {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const trx = trxClient(client)
        const org = await mintOrg(trx)
        for (let round = 0; round < 5; round += 1) {
          const root = crypto.randomUUID()
          const ordinal = crypto.randomInt(0, 100000)
          const fp = crypto.randomBytes(32).toString('hex')
          const tsImport = createVerifiedAttendanceOperationIdentityV1({
            org,
            kind: 'item',
            entrypoint: 'import_batch',
            source: { sourceKind: 'import_item', batchCommandId: root, ordinal, semanticFingerprint: fp },
          })
          const sqlImport = await client.query(
            'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, $3::int, $4))::text AS v',
            [IMPORT_NS, root, ordinal, fp],
          )
          expect(sqlImport.rows[0].v).toBe(tsImport.id)

          const tsIntegration = createVerifiedAttendanceOperationIdentityV1({
            org,
            kind: 'item',
            entrypoint: 'integration_batch',
            source: { sourceKind: 'integration_item', syncRunId: root, ordinal, semanticFingerprint: fp },
          })
          const sqlIntegration = await client.query(
            'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, $3::int, $4))::text AS v',
            [INTEGRATION_NS, root, ordinal, fp],
          )
          expect(sqlIntegration.rows[0].v).toBe(tsIntegration.id)

          const user = crypto.randomUUID()
          const day = `2026-0${crypto.randomInt(1, 9)}-1${crypto.randomInt(0, 9)}`
          const tsScheduled = createVerifiedAttendanceOperationIdentityV1({
            org,
            kind: 'item',
            entrypoint: 'scheduled',
            source: { sourceKind: 'scheduled', scheduledRunId: root, userId: user, workDate: day },
          })
          const sqlScheduled = await client.query(
            'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_scheduled_name_bytes($2::uuid, $3::uuid, $4::date))::text AS v',
            [SCHEDULED_NS, root, user, day],
          )
          expect(sqlScheduled.rows[0].v).toBe(tsScheduled.id)
        }
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    } finally {
      await pool.end()
    }
  })

  it('acquisition helpers take the exact golden advisory keys with the selected modes', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 2 })
    try {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const trx = trxClient(client)
        const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG)
        await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')
        const org = await mintOrg(trx)
        const operation = createVerifiedAttendanceOperationIdentityV1({
          org,
          kind: 'item',
          entrypoint: 'live_punch',
          source: { sourceKind: 'direct_live_punch', clientOperationId: DIRECT_ID },
        })
        await acquireAttendanceResultOperationLocks(trx, [operation])
        const target = createVerifiedAttendanceCalculationTargetIdentityV1({
          org,
          userId: SCHED_USER,
          workDate: SCHED_DATE,
        })
        await acquireAttendanceCalculationTargetLocks(trx, [target])

        const pidRow = await client.query('SELECT pg_backend_pid() AS pid')
        const pid = pidRow.rows[0].pid
        const locks = await client.query(
          "SELECT classid, objid, mode FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 1 AND pid = $1",
          [pid],
        )
        const held = new Map<string, string>(
          locks.rows.map((row: { classid: string | number; objid: string | number; mode: string }) => [
            `${row.classid}:${row.objid}`,
            row.mode,
          ]),
        )
        const rollout = lockIdParts(GOLDEN_ROLLOUT_KEY_ORG)
        const op = lockIdParts(GOLDEN_OPERATION_KEY_ITEM)
        const tgt = lockIdParts(GOLDEN_TARGET_KEY)
        expect(buildAttendanceCalculationRolloutAdvisoryKey(orgKey)).toBe(GOLDEN_ROLLOUT_KEY_ORG)
        expect(held.get(`${rollout.classid}:${rollout.objid}`)).toBe('ShareLock')
        expect(held.get(`${op.classid}:${op.objid}`)).toBe('ExclusiveLock')
        expect(held.get(`${tgt.classid}:${tgt.objid}`)).toBe('ExclusiveLock')
        await client.query('COMMIT')

        // xact-scoped: nothing survives the transaction
        const after = await client.query(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = $1",
          [pid],
        )
        expect(after.rows[0].n).toBe(0)
      } finally {
        client.release()
      }
    } finally {
      await pool.end()
    }
  })
})
