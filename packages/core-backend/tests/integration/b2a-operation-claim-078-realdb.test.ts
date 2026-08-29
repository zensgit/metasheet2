/**
 * O1-C — real-Postgres proof of migration 078's one-shot B2a operation claim (closing the honest
 * not-done disclosed in PR #5313).
 *
 * plugins/plugin-integration-core/lib/b2a-trial-registry.cjs's `createB2aOperationClaim({db})`
 * acquires the operation claim with a plain INSERT into `integration_b2a_operation_claim`
 * (migration 078, packages/core-backend/migrations/078_create_integration_b2a_operation_claim.sql),
 * whose `claim_key TEXT PRIMARY KEY` is what turns "of two concurrent claimers exactly one wins"
 * from an application-level hope into a database-enforced fact. The existing proof —
 * plugins/plugin-integration-core/__tests__/b2a-trial-registry.test.cjs's R-03b — is hermetic: it
 * races two module instances against a FAKE db whose `insertOne` models one-statement PRIMARY KEY
 * atomicity by hand (a gated in-memory Map insert). That is a faithful MODEL of the property; it is
 * not the property. This file drives the REAL `createB2aOperationClaim` against the REAL migrated
 * table over TWO INDEPENDENT live Postgres connections, racing their INSERTs with `Promise.all` —
 * the actual PRIMARY KEY, not a hand-rolled stand-in for it, picks the winner.
 *
 * Requiring the plugin's .cjs modules directly from a core-backend TS integration test is an
 * established, CI-executed pattern here — see
 * tests/integration/stock-preparation-p4-repair-once-realdb.test.ts, which already requires
 * plugins/plugin-integration-core/lib/db.cjs (createDb, the exact scoped SQL helper
 * createB2aOperationClaim is built on) the identical way. This file follows that precedent rather
 * than reimplementing the claim protocol, per the task's own fallback ("test the table's contract
 * directly... if importing the plugin module is unclean") — importing it here is NOT unclean, so the
 * real function is driven directly.
 *
 * WHERE THIS RUNS IN CI — stated plainly, because the honest answer is "nowhere yet":
 *   Every real-DB integration step in every workflow in this repo (plugin-tests.yml's "Run multitable
 *   real-DB integration" and its sibling steps, every standalone approval-realdb-*.yml,
 *   sealed-export-s5-sqlserver.yml, migration-replay.yml, multitable-recovery-schema-drift.yml) invokes
 *   `vitest --config vitest.integration.config.ts run` with an EXPLICIT whole-file argument list —
 *   never a bare directory or glob. The one command in this repo that WOULD pick up every file under
 *   tests/integration/ via vitest.integration.config.ts's own `include` glob —
 *   `@metasheet/core-backend`'s `test:integration` package script
 *   ("vitest --config vitest.integration.config.ts run tests/integration --reporter=dot") — is never
 *   invoked by any workflow (confirmed by searching every .github/workflows/*.yml for its name; only
 *   the unrelated `test:integration:after-sales` script is called). So there is no glob-covered
 *   CI-executed lane for a new tests/integration/*.test.ts file to land in. Per this task's explicit
 *   instruction, .github/workflows/** is NOT touched by this PR — wiring this file into a named
 *   real-DB step (the other half of this repo's two-point convention) is therefore a deliberate,
 *   disclosed follow-up, not something silently skipped. This file IS excluded from the no-DB
 *   packages/core-backend/vitest.config.ts (the in-scope half of the convention — that file is not a
 *   workflow), so it cannot be silently collected and failed by the required no-DB `test` job for want
 *   of a DATABASE_URL it was never going to have.
 *
 * LOCAL RUN STATUS: no DATABASE_URL, no reachable Postgres (127.0.0.1:5432 refused) and no Docker were
 * available in the sandbox this file was authored in, so this suite could not be executed there — every
 * assertion below was checked against the production call shapes in b2a-trial-registry.cjs/db.cjs and
 * the precedented patterns in sibling *-realdb.test.ts files, but no local green run was witnessed. The
 * `sentinel` test below fails loudly (not skip-green) if that ever changes silently.
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'module'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'

const require = createRequire(import.meta.url)
const {
  createB2aOperationClaim,
  B2A_OPERATION_CLAIM_TABLE,
} = require('../../../../plugins/plugin-integration-core/lib/b2a-trial-registry.cjs') as {
  createB2aOperationClaim: (opts: { db: unknown }) => {
    claim: (input: {
      claimKey: string
      registrationId: string
      registrationVersion: number
      operationDigest: string
      runId: string
      claimedAtMs: number
    }) => Promise<{ held: boolean; claimed: boolean; holderRunId: string | null }>
  }
  B2A_OPERATION_CLAIM_TABLE: string
}
const { createDb } = require('../../../../plugins/plugin-integration-core/lib/db.cjs') as {
  createDb: (opts: { database: { query: (sql: string, params?: unknown[]) => Promise<unknown> } }) => unknown
}

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// Unique per test run (pid + Date.now(), the same scheme tests/integration/
// stock-preparation-p4-repair-once-realdb.test.ts uses) so parallel/rerun invocations never collide
// on claim_key. No production data, no real identifiers — synthetic only.
const TOKEN = `${process.pid}_${Date.now().toString(36)}`
const REGISTRATION_ID = `o1c_reg_${TOKEN}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function dbOn(client: PoolClient) {
  return createDb({ database: { query: (sql: string, params?: unknown[]) => client.query(sql, params) } })
}

function claimInputs(suffix: string, runId: string) {
  return {
    claimKey: `integration:b2a:operation-claim:${REGISTRATION_ID}:${suffix}`,
    registrationId: REGISTRATION_ID,
    registrationVersion: 1,
    operationDigest: createHash('sha256').update(`${REGISTRATION_ID}:${suffix}`).digest('hex').slice(0, 32),
    runId,
    claimedAtMs: Date.now(),
  }
}

describeIfDatabase('O1-C migration 078 real-Postgres one-shot operation claim', () => {
  let clientA: PoolClient
  let clientB: PoolClient
  let clientC: PoolClient

  beforeAll(async () => {
    clientA = await poolManager.get().getInternalPool().connect()
    clientB = await poolManager.get().getInternalPool().connect()
    clientC = await poolManager.get().getInternalPool().connect()
  })

  afterAll(async () => {
    clientA?.release()
    clientB?.release()
    clientC?.release()
    await q(`DELETE FROM ${B2A_OPERATION_CLAIM_TABLE} WHERE registration_id = $1`, [REGISTRATION_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── (1) migration 078's table is really there, and claim_key is really its PRIMARY KEY ──────────
  test('migration 078: integration_b2a_operation_claim exists and claim_key is the (sole) PRIMARY KEY column', async () => {
    // The migration runner (db:migrate) runs before this suite, the same as every sibling real-DB
    // integration test — this asserts the schema it left behind rather than re-running migrations.
    const existsResult = (await q(`SELECT to_regclass('public.${B2A_OPERATION_CLAIM_TABLE}') AS reg`)) as {
      rows: Array<{ reg: string | null }>
    }
    expect(existsResult.rows[0]?.reg).toBe(B2A_OPERATION_CLAIM_TABLE)

    const pkResult = (await q(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position`,
      [B2A_OPERATION_CLAIM_TABLE],
    )) as { rows: Array<{ column_name: string }> }
    // THE property this whole suite exists to exercise: claim_key, and only claim_key, is the
    // PRIMARY KEY — read live from the catalog, not asserted from the migration file's text (that
    // static check already exists as M78 in the fake-db suite).
    expect(pkResult.rows.map((r) => r.column_name)).toEqual(['claim_key'])
  })

  // ── (2) two genuinely concurrent claimers, two independent connections, one real winner ─────────
  test(
    'two concurrent claimers over two independent connections race for the SAME operation: ' +
      'exactly one wins; the loser resolves the winner\'s run_id via read-back; a third Run is ' +
      'refused; the winning Run\'s own re-entry continues on its claim',
    async () => {
      const claimA = createB2aOperationClaim({ db: dbOn(clientA) })
      const claimB = createB2aOperationClaim({ db: dbOn(clientB) })

      const inputA = claimInputs('race', 'run-o1c-a')
      const inputB = claimInputs('race', 'run-o1c-b') // SAME claim_key as inputA — this is the race

      // Both INSERTs fire concurrently over two SEPARATE physical connections. No coordinator gate is
      // needed (unlike the fake-db R-03b harness, which has to hand-simulate one-statement atomicity):
      // a real network round trip against a real unique index is already a genuine race.
      const [resultA, resultB] = await Promise.all([claimA.claim(inputA), claimB.claim(inputB)])

      const claimedFlags = [resultA.claimed, resultB.claimed]
      expect(claimedFlags.filter(Boolean)).toHaveLength(1) // exactly one INSERT actually landed

      const aWon = resultA.claimed
      const winner = { result: aWon ? resultA : resultB, runId: aWon ? inputA.runId : inputB.runId, claim: aWon ? claimA : claimB, input: aWon ? inputA : inputB }
      const loser = { result: aWon ? resultB : resultA, runId: aWon ? inputB.runId : inputA.runId }

      expect(winner.result.held).toBe(true)
      expect(winner.result.holderRunId).toBe(winner.runId)

      // The LOSER resolves the WINNER's run_id via read-back — never its own, and never null (which
      // would mean the INSERT failed for some reason OTHER than the unique index, an unestablished
      // claim per createB2aOperationClaim's fail-closed contract).
      expect(loser.result.claimed).toBe(false)
      expect(loser.result.held).toBe(false)
      expect(loser.result.holderRunId).toBe(winner.runId)

      // The database itself holds exactly one row for this operation — the PRIMARY KEY, not
      // application logic, is what picked the winner.
      const rowsResult = (await q(`SELECT run_id FROM ${B2A_OPERATION_CLAIM_TABLE} WHERE claim_key = $1`, [
        inputA.claimKey,
      ])) as { rows: Array<{ run_id: string }> }
      expect(rowsResult.rows).toHaveLength(1)
      expect(rowsResult.rows[0]?.run_id).toBe(winner.runId)

      // A THIRD attempt from a DIFFERENT Run (its own independent connection) is refused, resolving
      // to the SAME winner — not a fresh coin flip.
      const claimC = createB2aOperationClaim({ db: dbOn(clientC) })
      const inputC = claimInputs('race', 'run-o1c-c')
      const resultC = await claimC.claim(inputC)
      expect(resultC.claimed).toBe(false)
      expect(resultC.held).toBe(false)
      expect(resultC.holderRunId).toBe(winner.runId)

      // The WINNING Run re-entering (bounded paging inside one operation, or the large-BOM job
      // legitimately re-entering under its own job id) CONTINUES on the claim it already holds —
      // held: true, claimed: false — never a second row.
      const reentry = await winner.claim.claim({ ...winner.input, claimedAtMs: Date.now() })
      expect(reentry.held).toBe(true)
      expect(reentry.claimed).toBe(false)
      expect(reentry.holderRunId).toBe(winner.runId)

      const finalRows = (await q(`SELECT count(*)::int AS n FROM ${B2A_OPERATION_CLAIM_TABLE} WHERE claim_key = $1`, [
        inputA.claimKey,
      ])) as { rows: Array<{ n: number }> }
      expect(finalRows.rows[0]?.n).toBe(1) // still exactly one row after the third attempt AND the re-entry
    },
  )

  // ── (3) permanence: no TTL, no expiry column, an ancient claim still refuses ─────────────────────
  test('permanence: the table has no TTL/expiry column, and a claim backdated years still refuses a new Run — the row survives untouched', async () => {
    // Structural half: the guarantee is permanent BY CONSTRUCTION — there is no column an expiry
    // check could even read. (Migration 077's confirmation-decision reconcile lease, this table's
    // named sibling, is the one that DOES carry a TTL-shaped column; this table deliberately does not.)
    const columnsResult = (await q(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [B2A_OPERATION_CLAIM_TABLE],
    )) as { rows: Array<{ column_name: string }> }
    const columnNames = columnsResult.rows.map((r) => r.column_name)
    expect(columnNames.sort()).toEqual(
      ['claim_key', 'claimed_at', 'operation_digest', 'registration_id', 'registration_version', 'run_id'].sort(),
    )
    for (const name of columnNames) {
      expect(name.toLowerCase()).not.toMatch(/expir|ttl|_until|valid_to|renew/)
    }

    // Behavioural half: claim, then backdate claimed_at to a date far older than any TTL-ish window
    // in this codebase (MAX_B2A_REGISTRATION_WINDOW_MS is 180 days; this is ~25 years), then present a
    // brand-new Run. Nothing purges or expires the row — it refuses exactly as it would a second later.
    const claimP = createB2aOperationClaim({ db: dbOn(clientA) })
    const input = claimInputs('permanence', 'run-o1c-perm-1')
    const first = await claimP.claim(input)
    expect(first.claimed).toBe(true)

    const longAgo = new Date('2000-01-01T00:00:00.000Z').toISOString()
    await q(`UPDATE ${B2A_OPERATION_CLAIM_TABLE} SET claimed_at = $1 WHERE claim_key = $2`, [longAgo, input.claimKey])

    const second = await claimP.claim({ ...input, runId: 'run-o1c-perm-2', claimedAtMs: Date.now() })
    expect(second.claimed).toBe(false)
    expect(second.held).toBe(false)
    expect(second.holderRunId).toBe(input.runId) // still the ORIGINAL run — nothing reassigned it

    // The row survives: same holder, and the ancient timestamp itself is untouched — no lazy-expiry
    // sweep, no renewal, nothing rewrote it just because a new Run showed up.
    const rowResult = (await q(`SELECT run_id, claimed_at FROM ${B2A_OPERATION_CLAIM_TABLE} WHERE claim_key = $1`, [
      input.claimKey,
    ])) as { rows: Array<{ run_id: string; claimed_at: Date }> }
    const row = rowResult.rows[0]
    expect(row?.run_id).toBe(input.runId)
    expect(row && new Date(row.claimed_at).toISOString()).toBe(longAgo)
  })
})
