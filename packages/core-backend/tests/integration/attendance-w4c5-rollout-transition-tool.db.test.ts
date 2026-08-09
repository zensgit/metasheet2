/**
 * W4C-5 operator transition tooling — real-PostgreSQL proof.
 *
 * docs/development/attendance-issue-4556-w4c5-transition-safety-amendment-20260804.md
 * (OD-W4C-61=(a), ratified at 2a2a5eee4f00abceff94ed6360e8c051708e35f7, owner comment
 * 5189421034 on PR 4747).
 *
 * Covers, against real PostgreSQL: the plan reporter's zero-write property (dynamic query
 * sweep + before/after row-count invariance), a full legacy -> shadow plan+apply cycle through
 * the actual CLI subprocess, idempotent re-apply, and one test per refusal class named in the
 * task — each asserting its SPECIFIC failure code. Pure orchestration/manifest/digest logic is
 * covered without a database in
 * scripts/ops/attendance-w4c5-rollout-transition-lib.test.ts.
 */
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import {
  planAttendanceCalculationRolloutTransitionV1,
  transitionAttendanceCalculationRolloutV1,
  type AttendanceRolloutTransitionPlanV1,
  type EvidenceReferencesV1,
} from '../../src/attendance/w4c3a-rollout-control'
import {
  acquireAttendanceCalculationRolloutLockSessionExclusiveV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  releaseAttendanceCalculationRolloutLockSessionExclusiveV1,
  type AttendanceW4TransactionClientV1,
} from '../../src/attendance/w4c0-identity'
import {
  ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
  computeAttendanceW4C5PlanDigestV1,
} from '../../../../scripts/ops/attendance-w4c5-rollout-transition-lib'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const run = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

const ALLOWLIST_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const CLI_PATH = join(process.cwd(), '..', '..', 'scripts', 'ops', 'attendance-w4c5-rollout-transition.ts')
const TSX_CLI = join(process.cwd(), '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')

async function createBase(pool: Pool): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query(`
    CREATE TABLE attendance_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      first_in_at timestamptz, last_out_at timestamptz, work_minutes integer NOT NULL DEFAULT 0,
      late_minutes integer NOT NULL DEFAULT 0, early_leave_minutes integer NOT NULL DEFAULT 0,
      status varchar(64) NOT NULL DEFAULT 'normal', is_workday boolean, meta jsonb,
      source_batch_id uuid, org_id text NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      request_type varchar(30) NOT NULL, status varchar(20) NOT NULL DEFAULT 'pending', org_id text NOT NULL,
      requested_in_at timestamptz, requested_out_at timestamptz, reason text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb, approval_instance_id text
    )`)
  await pool.query(`
    CREATE TABLE approval_instances (
      id text PRIMARY KEY, status text NOT NULL, version integer NOT NULL DEFAULT 0
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, batch_id uuid NOT NULL,
      created_by text NOT NULL, idempotency_key text, status varchar(20) NOT NULL DEFAULT 'queued',
      progress integer NOT NULL DEFAULT 0, total integer NOT NULL DEFAULT 0, error text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb, started_at timestamptz, finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_batches (
      id uuid PRIMARY KEY, org_id text NOT NULL, idempotency_key text, status text NOT NULL,
      row_count integer NOT NULL DEFAULT 0, meta jsonb NOT NULL DEFAULT '{}'::jsonb
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL, org_id text NOT NULL,
      user_id text, work_date date, record_id uuid, preview_snapshot jsonb
    )`)
}

function transactionClient(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: (text, values) =>
      client.query(text, values as unknown[]) as unknown as Promise<{ rows: Array<Record<string, unknown>> }>,
  }
}

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    orgId: overrides.orgId,
    targetState: overrides.targetState,
    imageSha: 'sha-tool-test',
    pendingMigrations: 0,
    serviceHealthy: true,
    ownerAuthorizationRef: 'owner-ref-tool-test',
    syntheticOrgRef: 'synthetic-ref-tool-test',
    customerData: false,
    externalNotificationsDisabled: true,
    externalDestinationCount: 0,
    entrypointInventoryRef: 'inventory-ref-tool-test',
    ...overrides,
  }
}

describeIfDatabase('W4C-5 operator transition tooling (real PostgreSQL)', () => {
  const scratchName = `ms2_w4c5_tool_${run}`
  const actorId = `w4c5-tool-${run}`
  const allowlisted = new Set<string>()
  let adminPool: Pool
  let pool: Pool
  let workdir: string

  function allow(id: string): void {
    allowlisted.add(id)
    process.env[ALLOWLIST_ENV] = [...allowlisted].join(',')
  }

  function spawnCli(argv: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [TSX_CLI, CLI_PATH, ...argv], {
      encoding: 'utf8',
      cwd: join(process.cwd()),
      env: { ...process.env, DATABASE_URL: dbUrl?.replace(/\/[^/]+$/, `/${scratchName}`), [ALLOWLIST_ENV]: [...allowlisted].join(',') },
      timeout: 30_000,
    })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  function writeManifest(name: string, manifest: Record<string, unknown>): string {
    const filePath = join(workdir, `${name}.json`)
    writeFileSync(filePath, JSON.stringify(manifest), 'utf8')
    return filePath
  }

  async function rolloutRow(orgId: string): Promise<{ state: string; version: number } | null> {
    const result = await pool.query(
      `SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1`,
      [orgId],
    )
    return result.rows.length === 1 ? (result.rows[0] as { state: string; version: number }) : null
  }

  async function eventCount(orgId: string): Promise<number> {
    const result = await pool.query(
      `SELECT count(*)::int AS n FROM attendance_calculation_rollout_events WHERE org_id = $1`,
      [orgId],
    )
    return result.rows[0].n as number
  }

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'w4c5-tool-'))
    const adminUrl = new URL(dbUrl as string)
    adminUrl.pathname = '/postgres'
    adminPool = new Pool({ connectionString: adminUrl.toString() })
    await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
    await adminPool.query(`CREATE DATABASE ${scratchName}`)
    const scratchUrl = new URL(dbUrl as string)
    scratchUrl.pathname = `/${scratchName}`
    pool = new Pool({ connectionString: scratchUrl.toString() })
    await createBase(pool)
    const db = new Kysely<never>({ dialect: new PostgresDialect({ pool }) })
    await w4c0Up(db)
  }, 60_000)

  afterAll(async () => {
    delete process.env[ALLOWLIST_ENV]
    await pool?.end().catch(() => undefined)
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`).catch(() => undefined)
      await adminPool.end().catch(() => undefined)
    }
    rmSync(workdir, { recursive: true, force: true })
  })

  describe('plan reporter: zero-write proof', () => {
    it('issues no write statement and always ends with ROLLBACK, never COMMIT', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      const statements: string[] = []
      const spy: AttendanceW4TransactionClientV1 = {
        query: (text, values) => {
          statements.push(text.trim())
          return client.query(text, values as unknown[]) as unknown as Promise<{ rows: Array<Record<string, unknown>> }>
        },
      }
      try {
        const plan = await planAttendanceCalculationRolloutTransitionV1(spy, { orgId, targetState: 'shadow' })
        expect(plan.rowExists).toBe(false)
        expect(plan.canBootstrap).toBe(true)

        for (const statement of statements) {
          expect(statement.toUpperCase()).not.toMatch(/^(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE)\b/)
        }
        expect(statements.at(-1)?.toUpperCase()).toBe('ROLLBACK')
        expect(statements.some((s) => s.toUpperCase() === 'COMMIT')).toBe(false)
      } finally {
        client.release()
      }
    })

    it('leaves the rollout row and event count exactly unchanged across a plan call', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      try {
        const before = await rolloutRow(orgId)
        const beforeEvents = await eventCount(orgId)
        expect(before).toBeNull()
        expect(beforeEvents).toBe(0)

        await planAttendanceCalculationRolloutTransitionV1(transactionClient(client), {
          orgId,
          targetState: 'shadow',
        })

        const after = await rolloutRow(orgId)
        const afterEvents = await eventCount(orgId)
        expect(after).toBeNull()
        expect(afterEvents).toBe(0)
      } finally {
        client.release()
      }
    })
  })

  describe('full legacy -> shadow plan+apply cycle (CLI), idempotent re-apply', () => {
    const orgId = crypto.randomUUID()

    it('plan reports an unblocked legacy -> shadow bootstrap-eligible transition', () => {
      allow(orgId)
      const result = spawnCli(['plan', '--org', orgId, '--target', 'shadow'])
      expect(result.status).toBe(0)
      const plan = JSON.parse(result.stdout) as AttendanceRolloutTransitionPlanV1 & { planDigest: string }
      expect(plan.blocked).toBe(false)
      expect(plan.legalPair).toBe(true)
      expect(plan.canBootstrap).toBe(true)
      expect(plan.currentState).toBe('legacy')
      expect(plan.targetState).toBe('shadow')
      expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/)
    })

    let planDigest: string
    let correlationId: string

    it('apply transitions legacy -> shadow through the CLI and persists exactly one event', () => {
      const planResult = spawnCli(['plan', '--org', orgId, '--target', 'shadow'])
      const plan = JSON.parse(planResult.stdout) as { planDigest: string }
      planDigest = plan.planDigest
      correlationId = crypto.randomUUID()

      const manifestPath = writeManifest('legacy-to-shadow', baseManifest({ orgId, targetState: 'shadow' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'shadow',
        '--expected-state', 'legacy',
        '--expected-version', '1',
        '--plan-digest', planDigest,
        '--confirm', ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', correlationId,
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(0)
      const outcome = JSON.parse(applyResult.stdout) as { outcome: string; state: string }
      expect(outcome.outcome).toBe('transitioned')
      expect(outcome.state).toBe('shadow')
    })

    it('persisted exactly the expected row and event after apply', async () => {
      const row = await rolloutRow(orgId)
      expect(row).toEqual({ state: 'shadow', version: 2 })
      expect(await eventCount(orgId)).toBe(1)

      const events = await pool.query(
        `SELECT evidence FROM attendance_calculation_rollout_events WHERE org_id = $1`,
        [orgId],
      )
      const evidence = events.rows[0].evidence as Record<string, unknown>
      expect(evidence.correlationId).toBe(correlationId)
      expect(typeof evidence.manifestSha256).toBe('string')
      expect((evidence.manifestSha256 as string)).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(evidence)).not.toMatch(/secret/i)
    })

    it('re-applying the SAME invocation is a no-op — zero DML, not a second transition', () => {
      const manifestPath = writeManifest('legacy-to-shadow-reapply', baseManifest({ orgId, targetState: 'shadow' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'shadow',
        '--expected-state', 'legacy',
        '--expected-version', '1',
        '--plan-digest', planDigest,
        '--confirm', ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', crypto.randomUUID(),
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(0)
      const outcome = JSON.parse(applyResult.stdout) as { outcome: string }
      expect(outcome.outcome).toBe('noop_already_at_target')
    })

    it('the idempotent re-apply left state, version, and event count byte-identical', async () => {
      const row = await rolloutRow(orgId)
      expect(row).toEqual({ state: 'shadow', version: 2 })
      expect(await eventCount(orgId)).toBe(1)
    })
  })

  describe('refusal matrix — one test per class, each asserting its SPECIFIC failure code', () => {
    it('unknown org: no row and not bootstrap-eligible (target != shadow) refuses with STATE_MISSING and zero DML', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const planResult = spawnCli(['plan', '--org', orgId, '--target', 'eligible'])
      const plan = JSON.parse(planResult.stdout) as { planDigest: string }

      const manifestPath = writeManifest('unknown-org', baseManifest({ orgId, targetState: 'eligible' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'eligible',
        '--expected-state', 'shadow',
        '--expected-version', '1',
        '--plan-digest', plan.planDigest,
        '--confirm', ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', crypto.randomUUID(),
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(7)
      expect(applyResult.stderr).toContain('W4C3A_ROLLOUT_CONTROL_STATE_MISSING')
      expect(await rolloutRow(orgId)).toBeNull()
    })

    it('org not in expected current state: a stale expected-version refuses with STALE_EXPECTED_STATE (direct boundary proof)', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId,
          actorId,
          correlationId: crypto.randomUUID(),
          engineVersion: 'w4c5-tool-test',
          targetState: 'shadow',
          expectedState: 'legacy',
          expectedVersion: 1,
          evidenceManifestSha256: crypto.createHash('sha256').update('stale-fixture').digest('hex'),
          evidenceReferences: { imageSha: 'x', ownerAuthorizationRef: 'y', syntheticOrgRef: 'z' } as EvidenceReferencesV1,
          reasonCode: 'rollout_transition',
        })

        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId,
            actorId,
            correlationId: crypto.randomUUID(),
            engineVersion: 'w4c5-tool-test',
            targetState: 'eligible',
            expectedState: 'shadow',
            expectedVersion: 99, // deliberately stale
            evidenceManifestSha256: crypto.createHash('sha256').update('stale-fixture-2').digest('hex'),
            evidenceReferences: { imageSha: 'x', ownerAuthorizationRef: 'y', syntheticOrgRef: 'z' } as EvidenceReferencesV1,
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_STALE_EXPECTED_STATE' })

        expect(await rolloutRow(orgId)).toEqual({ state: 'shadow', version: 2 })
      } finally {
        client.release()
      }
    })

    it('transition pair absent from the ratified matrix refuses with ILLEGAL_TRANSITION and zero DML', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const planResult = spawnCli(['plan', '--org', orgId, '--target', 'suspended'])
      const plan = JSON.parse(planResult.stdout) as { planDigest: string; legalPair: boolean }
      expect(plan.legalPair).toBe(false)

      const manifestPath = writeManifest('illegal-pair', baseManifest({ orgId, targetState: 'suspended' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'suspended',
        '--expected-state', 'legacy',
        '--expected-version', '1',
        '--plan-digest', plan.planDigest,
        '--confirm', ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', crypto.randomUUID(),
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(7)
      expect(applyResult.stderr).toContain('W4C3A_ROLLOUT_CONTROL_ILLEGAL_TRANSITION')
      expect(await rolloutRow(orgId)).toBeNull()
    })

    it('missing confirmation refuses with W4C5_TOOL_CONFIRMATION_REQUIRED before any DB access', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const manifestPath = writeManifest('missing-confirm', baseManifest({ orgId, targetState: 'shadow' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'shadow',
        '--expected-state', 'legacy',
        '--expected-version', '1',
        '--plan-digest', 'a'.repeat(64),
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', crypto.randomUUID(),
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(3)
      expect(applyResult.stderr).toContain('W4C5_TOOL_CONFIRMATION_REQUIRED')
      expect(await rolloutRow(orgId)).toBeNull()
    })

    it('stale/mismatched plan digest refuses with W4C5_TOOL_PLAN_DIGEST_MISMATCH and zero DML', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const manifestPath = writeManifest('digest-mismatch', baseManifest({ orgId, targetState: 'shadow' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'shadow',
        '--expected-state', 'legacy',
        '--expected-version', '1',
        '--plan-digest', '0'.repeat(64), // never a real digest for this fresh org
        '--confirm', ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', crypto.randomUUID(),
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(5)
      expect(applyResult.stderr).toContain('W4C5_TOOL_PLAN_DIGEST_MISMATCH')
      expect(await rolloutRow(orgId)).toBeNull()
    })

    it('a concurrent transition in flight refuses with the boundary\'s own bounded-wait busy code (real two-connection proof)', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const holder = await pool.connect()
      const contender = await pool.connect()
      try {
        const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(orgId)
        await acquireAttendanceCalculationRolloutLockSessionExclusiveV1(transactionClient(holder), orgKey)
        try {
          await expect(
            transitionAttendanceCalculationRolloutV1(transactionClient(contender), {
              orgId,
              actorId,
              correlationId: crypto.randomUUID(),
              engineVersion: 'w4c5-tool-test',
              targetState: 'shadow',
              expectedState: 'legacy',
              expectedVersion: 1,
              evidenceManifestSha256: crypto.createHash('sha256').update('busy-fixture').digest('hex'),
              evidenceReferences: { imageSha: 'x', ownerAuthorizationRef: 'y', syntheticOrgRef: 'z' } as EvidenceReferencesV1,
              reasonCode: 'rollout_transition',
            }),
          ).rejects.toMatchObject({ code: 'ATTENDANCE_CALCULATION_ROLLOUT_BUSY' })
        } finally {
          await releaseAttendanceCalculationRolloutLockSessionExclusiveV1(transactionClient(holder), orgKey)
        }
        expect(await rolloutRow(orgId)).toBeNull()
      } finally {
        holder.release()
        contender.release()
      }
    }, 20_000)
  })

  describe('planDigest arithmetic sanity (direct, no CLI)', () => {
    it('computeAttendanceW4C5PlanDigestV1 over a real plan matches what the CLI printed', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      try {
        const plan = await planAttendanceCalculationRolloutTransitionV1(transactionClient(client), {
          orgId,
          targetState: 'shadow',
        })
        const digest = computeAttendanceW4C5PlanDigestV1(plan)
        const cliResult = spawnCli(['plan', '--org', orgId, '--target', 'shadow'])
        const cliPlan = JSON.parse(cliResult.stdout) as { planDigest: string }
        expect(cliPlan.planDigest).toBe(digest)
      } finally {
        client.release()
      }
    })
  })
})
