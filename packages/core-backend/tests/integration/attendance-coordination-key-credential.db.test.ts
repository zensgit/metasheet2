/**
 * Attendance settlement coordination — dedicated key and handover credential against a real
 * PostgreSQL (P1-1 acceptance A02, S1-scope legs).
 *
 *  - key2 goldens are computed by the DATABASE (pgcrypto over a bytea preimage, since text cannot
 *    carry NUL), independently of the module's JavaScript derivation;
 *  - `pg_locks` shows the dedicated key with objid = key2 read as unsigned (guard ③), and the
 *    class-00 key equal to the W4 builder's key, for upper- and lower-case spellings of one org;
 *  - the credential verifies only on the same connection, for the same org, inside the same
 *    transaction; never after COMMIT / ROLLBACK, never in a later transaction on the same client;
 *  - guard ④: every two-int4 advisory call in production source whose key1 is a constant is in the
 *    fixed key1 registry, the registry's values are pairwise distinct, and none but the coordination
 *    entry equals 0x4D533243. The population is read from source, values are computed in PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Pool } from 'pg'

import {
  SettlementCoordinationCredentialV1,
  commitSettlementCoordinationTransactionV1,
  invalidateSettlementCoordinationCredentialsV1,
  planSettlementCoordinationV1,
  rollbackSettlementCoordinationTransactionV1,
  runSettlementCoordinationHandoverV1,
  runSettlementCoordinationS1V1,
  verifySettlementCoordinationCredentialV1,
} from '../../src/attendance/coordination/settlement-coordination-handover'
import {
  ADVISORY_FIXED_KEY1_REGISTRY,
  SETTLEMENT_COORDINATION_KEY1,
  SETTLEMENT_COORDINATION_KEY2_PREFIX,
  buildSettlementCoordinationKeyV1,
} from '../../src/attendance/coordination/settlement-coordination-key'
import {
  buildAttendanceCalculationRolloutAdvisoryKey,
  parseCanonicalAttendanceRolloutOrgKeyV1,
} from '../../src/attendance/w4c0-identity'
import { advisoryLocksOf, backendPid, isBigintLock, isDedicatedLock } from '../helpers/settlement-coordination-db'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have a database URL (a DB-expected run must never skip-green)', () => {
  expect(dbUrl).toBeTruthy()
})

// Every test destroys the connections it borrowed instead of handing them back: a failed
// assertion can leave session-level locks on a backend, and a reused backend would turn one red
// test into a chain of unrelated ones.
const DESTROY = new Error('test: never hand a test connection to the next test')

const HANDOVER = { isolation: 'READ COMMITTED' as const, timeouts: { kind: 'none' as const }, entryLabel: 'test.credential' }
const REPO_ROOT = path.resolve(__dirname, '../../../..')

describeIfDatabase('attendance settlement coordination — key and credential (real database)', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl, max: 4 })
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  })

  afterAll(async () => {
    await pool.end()
  })

  async function key2InDatabase(org: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT ((get_byte(d, 0)::bigint << 24) | (get_byte(d, 1)::bigint << 16)
               | (get_byte(d, 2)::bigint << 8) | get_byte(d, 3)::bigint) AS unsigned
         FROM (SELECT digest(convert_to($1, 'UTF8') || '\\x00'::bytea || convert_to($2, 'UTF8'), 'sha256') AS d) s`,
      [SETTLEMENT_COORDINATION_KEY2_PREFIX, org],
    )
    const unsigned = Number(rows[0].unsigned)
    return unsigned >= 2 ** 31 ? unsigned - 2 ** 32 : unsigned
  }

  it('key2 matches a derivation computed by PostgreSQL (pgcrypto over a bytea preimage)', async () => {
    const orgs = ['default', crypto.randomUUID(), 'legacy-org-42', '部门-甲', `legacy-${crypto.randomUUID()}`]
    for (const org of orgs) {
      const key = buildSettlementCoordinationKeyV1(org)
      expect(await key2InDatabase(key.org.lexical)).toBe(key.key2)
    }
  })

  it('pg_locks shows key2 as unsigned objid and class-00 equal to the W4 builder, for either spelling of the org', async () => {
    const lower = crypto.randomUUID()
    for (const spelling of [lower, lower.toUpperCase()]) {
      const plan = planSettlementCoordinationV1(spelling, { needsClassZero: true })
      const expectedClassZero = buildAttendanceCalculationRolloutAdvisoryKey(parseCanonicalAttendanceRolloutOrgKeyV1(lower))
      expect(plan.classZeroKey).toBe(expectedClassZero)
      const client = await pool.connect()
      const pid = await backendPid(client)
      try {
        expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
        const held = await advisoryLocksOf(pool, pid)
        expect(held.some((row) => isDedicatedLock(row, buildSettlementCoordinationKeyV1(lower).key2))).toBe(true)
        expect(held.some((row) => isBigintLock(row, expectedClassZero))).toBe(true)
        await client.query(
          `SELECT pg_advisory_unlock_shared(${SETTLEMENT_COORDINATION_KEY1}, ${plan.key.key2}),
                  pg_advisory_unlock_shared(${expectedClassZero.toString()}::bigint)`,
        )
      } finally {
        client.release(DESTROY)
      }
    }
  })

  it('compares a negative key2 against pg_locks as unsigned', async () => {
    const plan = planSettlementCoordinationV1('legacy-org-42', { needsClassZero: true })
    expect(plan.key.key2).toBeLessThan(0)
    const client = await pool.connect()
    const pid = await backendPid(client)
    try {
      expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
      const held = await advisoryLocksOf(pool, pid)
      expect(held).toHaveLength(1)
      expect(held[0].objid).toBe(String(plan.key.key2 >>> 0))
      expect(held[0].objid).not.toBe(String(plan.key.key2))
      await client.query(`SELECT pg_advisory_unlock_shared(${SETTLEMENT_COORDINATION_KEY1}, ${plan.key.key2})`)
    } finally {
      client.release(DESTROY)
    }
  })

  it('the credential is bound to this connection, this org and this transaction', async () => {
    const org = crypto.randomUUID()
    const plan = planSettlementCoordinationV1(org, { needsClassZero: true })
    const client = await pool.connect()
    const otherClient = await pool.connect()
    try {
      expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
      const handover = await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)
      if (handover.kind !== 'handed-over') throw new Error(`handover failed: ${JSON.stringify(handover)}`)
      const credential = handover.credential

      expect(verifySettlementCoordinationCredentialV1(client, credential, org, { needsClassZero: true })).toBe(true)
      expect(verifySettlementCoordinationCredentialV1(client, credential, org.toUpperCase(), { needsClassZero: true })).toBe(true)
      expect(verifySettlementCoordinationCredentialV1(otherClient, credential, org, { needsClassZero: true })).toBe(false)
      expect(verifySettlementCoordinationCredentialV1(client, credential, crypto.randomUUID(), { needsClassZero: true })).toBe(false)
      expect(verifySettlementCoordinationCredentialV1(client, undefined, org, { needsClassZero: true })).toBe(false)
      expect(verifySettlementCoordinationCredentialV1(client, { ...credential }, org, { needsClassZero: true })).toBe(false)
      expect(verifySettlementCoordinationCredentialV1(client, credential, ' not-trimmed', { needsClassZero: true })).toBe(false)
      expect(() => new SettlementCoordinationCredentialV1(Symbol('forged'), client, org, true)).toThrow()

      expect(await commitSettlementCoordinationTransactionV1(client, credential)).toEqual({ kind: 'committed' })
      expect(verifySettlementCoordinationCredentialV1(client, credential, org, { needsClassZero: true })).toBe(false)

      // A later transaction on the same pooled client must not inherit it.
      await client.query('BEGIN')
      expect(verifySettlementCoordinationCredentialV1(client, credential, org, { needsClassZero: true })).toBe(false)
      await client.query('ROLLBACK')
    } finally {
      client.release(DESTROY)
      otherClient.release(DESTROY)
    }
  })

  it('a credential minted without class-00 does not satisfy a caller that needs class-00', async () => {
    const org = crypto.randomUUID()
    const plan = planSettlementCoordinationV1(org, { needsClassZero: false })
    const client = await pool.connect()
    try {
      expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
      const handover = await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)
      if (handover.kind !== 'handed-over') throw new Error(`handover failed: ${JSON.stringify(handover)}`)
      expect(verifySettlementCoordinationCredentialV1(client, handover.credential, org, { needsClassZero: false })).toBe(true)
      expect(verifySettlementCoordinationCredentialV1(client, handover.credential, org, { needsClassZero: true })).toBe(false)
      expect(await rollbackSettlementCoordinationTransactionV1(client, handover.credential)).toEqual({ kind: 'rolled-back' })
      expect(verifySettlementCoordinationCredentialV1(client, handover.credential, org, { needsClassZero: false })).toBe(false)
    } finally {
      client.release(DESTROY)
    }
  })

  it('a release-path invalidation drops the live credential', async () => {
    const org = `legacy-${crypto.randomUUID()}`
    const plan = planSettlementCoordinationV1(org, { needsClassZero: true })
    const client = await pool.connect()
    try {
      expect(await runSettlementCoordinationS1V1(client, plan)).toEqual({ kind: 'acquired' })
      const handover = await runSettlementCoordinationHandoverV1(client, plan, HANDOVER)
      if (handover.kind !== 'handed-over') throw new Error(`handover failed: ${JSON.stringify(handover)}`)
      invalidateSettlementCoordinationCredentialsV1(client)
      expect(verifySettlementCoordinationCredentialV1(client, handover.credential, org, { needsClassZero: false })).toBe(false)
      await client.query('ROLLBACK')
    } finally {
      client.release(DESTROY)
    }
  })

  it('guard ④: every constant two-int4 key1 in production source is registered, distinct, and not 0x4D533243', async () => {
    const ROOTS = ['packages', 'plugins', 'scripts']
    const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '__tests__', 'tests', '__fixtures__'])
    const EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.cjs', '.mjs', '.sql'])
    const CALL = /pg_(?:try_)?advisory_(?:xact_)?(?:un)?lock(?:_shared)?\s*\(\s*(?:hashtext\s*\(\s*'([^']*)'\s*\)|\(?\s*(-?\d+)\s*\)?(?:\s*::\s*int4)?)\s*,/gi
    const files: string[] = []
    const walk = (dir: string): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(full)
        } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name)) && !/\.(test|spec)\.[cm]?[jt]s$/.test(entry.name)) {
          files.push(full)
        }
      }
    }
    for (const root of ROOTS) walk(path.join(REPO_ROOT, root))
    const relative = files.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
    // The scan must reach the known constant-key1 user.
    expect(relative).toContain('packages/core-backend/src/audit/AuditRepository.ts')

    const foundHashtext = new Set<string>()
    const foundLiterals = new Set<number>()
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      for (const match of text.matchAll(CALL)) {
        if (match[1] !== undefined) foundHashtext.add(match[1])
        else if (match[2] !== undefined) foundLiterals.add(Number(match[2]))
      }
    }
    expect(foundHashtext.has('audit_logs_partition')).toBe(true)

    const registeredHashtext = new Set(ADVISORY_FIXED_KEY1_REGISTRY.flatMap((entry) => ('hashtext' in entry.key1 ? [entry.key1.hashtext] : [])))
    const registeredLiterals = new Set(ADVISORY_FIXED_KEY1_REGISTRY.flatMap((entry) => ('literal' in entry.key1 ? [entry.key1.literal] : [])))
    expect([...foundHashtext].filter((value) => !registeredHashtext.has(value))).toEqual([])
    expect([...foundLiterals].filter((value) => !registeredLiterals.has(value))).toEqual([])

    const values: Array<{ name: string; value: number }> = []
    for (const entry of ADVISORY_FIXED_KEY1_REGISTRY) {
      if ('literal' in entry.key1) {
        values.push({ name: entry.name, value: entry.key1.literal })
      } else {
        const { rows } = await pool.query('SELECT hashtext($1)::int AS v', [entry.key1.hashtext])
        values.push({ name: entry.name, value: Number(rows[0].v) })
      }
    }
    expect(new Set(values.map((entry) => entry.value)).size).toBe(values.length)
    for (const entry of values) {
      if (entry.name !== 'attendance-settlement-coordination') expect(entry.value).not.toBe(SETTLEMENT_COORDINATION_KEY1)
    }
  })
})
