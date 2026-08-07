/**
 * #4783 owner review batch 2 — the P1-1 write gate (`createTimerJob` throwing
 * `BpmnTimerPollerDisabledError` before its own `INSERT`) was placed too late:
 * `startProcess()` had ALREADY persisted the `bpmn_process_instances` row (`state:
 * 'ACTIVE'`), and `executeStartEvents`/`executeActivity` had ALREADY persisted
 * `bpmn_activity_instances` rows, by the time that throw fired. The catch block in
 * `startProcess()` only logs and rethrows — nothing marks the instance terminated — so the
 * owner's real repro against a fresh migrated database (`243db11f1`) showed:
 *
 *   process:     ACTIVE            (permanent residue)
 *   activities:  startEvent=COMPLETED, intermediateCatchEvent=FAILED
 *   incident:    OPEN
 *   timer jobs:  0                 (P1-1 did stop THIS write)
 *
 * Batch 2's fix moves the gate to `startProcess()`'s own entry, BEFORE any write: if the
 * poller is disabled and the process definition contains a 'date'/'duration' timer
 * ANYWHERE in its structure (`BPMNWorkflowEngine.definitionHasPollerDependentTimer`, a
 * sound full-definition scan, not a reachability analysis — see that method's own
 * comment), `startProcess` throws immediately, before the `bpmn_process_instances` INSERT.
 * The owner's completion door is literally FOUR zeros — process, activity, incident, AND
 * timer rows all zero — not "cleaned up to a terminal state" (an earlier revision of this
 * fix persisted-then-terminated with a RESOLVED incident; the owner explicitly rejected
 * that shape because it still leaves non-zero activity/incident rows behind).
 *
 * This file drives the REAL production HTTP surface — `POST /api/workflow/deploy` then
 * `POST /api/workflow/start/:key` against a REAL booted `MetaSheetServer` and REAL
 * PostgreSQL — never `engine.createTimerJob(...)` or any other private method directly.
 *
 * BPMN XML fixture note: this codebase's `BPMNWorkflowEngine.deployProcess()` reads
 * `parsed.definitions.process[0]` (UNPREFIXED keys), while `executeStartEvents` /
 * `findActivity` read children via `'bpmn:startEvent'`/`'bpmn:sequenceFlow'`/etc.
 * (PREFIXED keys) off that same `process` object. Verified directly against this
 * project's actual `xml2js.parseString` (not assumed): a `<bpmn:definitions>`-prefixed
 * root parses to a `'bpmn:definitions'` top-level key, which `deployProcess`'s own
 * `parsed.definitions.process[0]` cannot see (`definitions` is `undefined`) — it would
 * throw before persisting anything, unrelated to this PR. A fully unprefixed root parses
 * cleanly for `deployProcess` but then `executeStartEvents`'s `'bpmn:startEvent'` lookup
 * matches nothing, so nothing ever executes. The one shape that satisfies BOTH readers
 * (confirmed by direct `xml2js.parseString` invocation) is what this file uses: unprefixed
 * `<definitions>`/`<process>` root elements, `bpmn:`-prefixed descendants.
 */
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dropScratchDatabase, formatScratchDropOutcome } from '../helpers/scratch-database'
import type { MetaSheetServer } from '../../src/index'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

type JsonResponse = { status: number; body: Record<string, any> | null; raw: string }

function canListen(): Promise<boolean> {
  const probe = net.createServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = options.body ? JSON.stringify(options.body) : null
    const request = http.request({
      method: options.method ?? 'GET',
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...options.headers,
      },
    }, (response) => {
      let raw = ''
      response.on('data', (chunk) => { raw += String(chunk) })
      response.on('end', () => {
        let body: Record<string, any> | null = null
        try { body = raw ? JSON.parse(raw) as Record<string, any> : null } catch { body = null }
        resolve({ status: response.statusCode ?? 0, body, raw })
      })
    })
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

/** A process with a start event flowing directly into a 'duration' intermediateCatchEvent
 *  timer — the exact shape of the owner's own repro (start completes, then the timer path
 *  is what trips the gate). See file header for why this specific mixed prefix convention
 *  is required for THIS engine's own deploy+execute code paths, both. */
function timerBearingProcessXml(processKey: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="defs_${processKey}">
  <process id="${processKey}">
    <bpmn:startEvent id="start1">
      <bpmn:outgoing>flow1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:sequenceFlow id="flow1" sourceRef="start1" targetRef="timer1" />
    <bpmn:intermediateCatchEvent id="timer1">
      <bpmn:incoming>flow1</bpmn:incoming>
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration>PT5M</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
  </process>
</definitions>`
}

/** Structurally identical, but with no timer anywhere — the positive control proving the
 *  entry gate does not over-block ordinary poller-off starts. */
function timerFreeProcessXml(processKey: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="defs_${processKey}">
  <process id="${processKey}">
    <bpmn:startEvent id="start1">
      <bpmn:outgoing>flow1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:sequenceFlow id="flow1" sourceRef="start1" targetRef="end1" />
    <bpmn:endEvent id="end1">
      <bpmn:incoming>flow1</bpmn:incoming>
    </bpmn:endEvent>
  </process>
</definitions>`
}

describeIfDatabase('BPMNWorkflowEngine startProcess poller-disabled zero-residue (#4783 owner review batch 2, real HTTP + real PostgreSQL)', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  let adminPool: Pool
  let scratchName: string
  let baseUrl = ''
  let token = ''

  const priorEnv = {
    databaseUrl: process.env.DATABASE_URL,
    skipPlugins: process.env.SKIP_PLUGINS,
    enablePoller: process.env.ENABLE_BPMN_TIMER_POLLER,
  }

  async function mintToken(userId: string): Promise<string> {
    const response = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}`)
    const minted = response.body?.token
    if (typeof minted !== 'string' || !minted) throw new Error(`failed to mint token: ${response.raw}`)
    return minted
  }

  async function seedUser(): Promise<string> {
    const userId = randomUUID()
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $2, $1, 'BPMN #4783 batch-2 zero-residue fixture', 'x', 'user', '[]'::jsonb, TRUE, FALSE, 'activated')`,
      [userId, `bpmnp1batch2-${userId}@example.test`],
    )
    return userId
  }

  async function deploy(bpmnXml: string, key: string): Promise<JsonResponse> {
    return requestJson(`${baseUrl}/api/workflow/deploy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: { key, name: `#4783 batch-2 fixture ${key}`, bpmnXml },
    })
  }

  async function start(key: string): Promise<JsonResponse> {
    return requestJson(`${baseUrl}/api/workflow/start/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: {},
    })
  }

  async function counts(processKey: string): Promise<{ processes: number; activities: number; incidents: number; timers: number }> {
    const proc = await pool.query(
      `SELECT count(*)::int AS n FROM bpmn_process_instances WHERE process_definition_key = $1`,
      [processKey],
    )
    // bpmn_activity_instances/bpmn_incidents/bpmn_timer_jobs key off process_instance_id,
    // not process_definition_key — resolve instance ids for this key first (there should
    // be zero of them in the fail-closed leg, and that absence IS the assertion; in the
    // positive-control leg there is exactly one).
    const instanceIds = await pool.query(
      `SELECT id FROM bpmn_process_instances WHERE process_definition_key = $1`,
      [processKey],
    )
    const ids: string[] = instanceIds.rows.map((r: { id: string }) => r.id)
    const activities = ids.length
      ? await pool.query(`SELECT count(*)::int AS n FROM bpmn_activity_instances WHERE process_instance_id = ANY($1::uuid[])`, [ids])
      : { rows: [{ n: 0 }] }
    const incidents = ids.length
      ? await pool.query(`SELECT count(*)::int AS n FROM bpmn_incidents WHERE process_instance_id = ANY($1::uuid[])`, [ids])
      : { rows: [{ n: 0 }] }
    const timers = ids.length
      ? await pool.query(`SELECT count(*)::int AS n FROM bpmn_timer_jobs WHERE process_instance_id = ANY($1::uuid[])`, [ids])
      : { rows: [{ n: 0 }] }
    return {
      processes: proc.rows[0].n,
      activities: activities.rows[0].n,
      incidents: incidents.rows[0].n,
      timers: timers.rows[0].n,
    }
  }

  beforeAll(async () => {
    if (!dbUrl || !(await canListen())) throw new Error('BPMN_P1_BATCH2_TEST_REQUIRES_DATABASE_AND_LOOPBACK')

    scratchName = `ms2_bpmnp1b2_${randomUUID().slice(0, 12).replace(/-/g, '')}`
    const adminUrl = new URL(dbUrl)
    adminUrl.pathname = '/postgres'
    adminPool = new Pool({ connectionString: adminUrl.toString() })
    await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
    await adminPool.query(`CREATE DATABASE ${scratchName}`)
    const scratchUrl = new URL(dbUrl)
    scratchUrl.pathname = `/${scratchName}`
    const scratchConnectionString = scratchUrl.toString()

    const coreBackendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const { execFileSync } = await import('node:child_process')
    execFileSync('pnpm', ['exec', 'tsx', 'src/db/migrate.ts'], {
      cwd: coreBackendDir,
      env: { ...process.env, DATABASE_URL: scratchConnectionString },
      stdio: 'pipe',
    })

    process.env.DATABASE_URL = scratchConnectionString
    process.env.SKIP_PLUGINS = 'true'
    // Default-off, unset — the exact shipped state this fix targets.
    delete process.env.ENABLE_BPMN_TIMER_POLLER

    const loaded = await import('../../src/index')
    server = new loaded.MetaSheetServer({ port: 0, host: '127.0.0.1' })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: scratchConnectionString })

    const userId = await seedUser()
    token = await mintToken(userId)
  }, 120000)

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
    if (server) await server.stop()
    // #4791: drain the scratch DB's backends before dropping it. A forced drop terminates any
    // still-attached backend, and `pg` reports that to its owner as an unowned 'error' EVENT —
    // which vitest counts as an unhandled error and the step exits 1 with every test passing.
    // The outcome line is emitted UNCONDITIONALLY: `CLEAN` is the claim, `FORCED` names the
    // component still holding a connection and keeps #4791 open.
    if (adminPool) {
      const dropOutcome = await dropScratchDatabase(adminPool, scratchName)
      console.log(formatScratchDropOutcome('bpmn-poller-disabled', dropOutcome))
    }
    await adminPool?.end().catch(() => undefined)
    for (const [key, value] of Object.entries({
      DATABASE_URL: priorEnv.databaseUrl,
      SKIP_PLUGINS: priorEnv.skipPlugins,
      ENABLE_BPMN_TIMER_POLLER: priorEnv.enablePoller,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }, 60000)

  it('poller disabled + a timer-bearing process: /start rejects with BPMN_TIMER_POLLER_DISABLED and FOUR real zeros — process, activity, incident, timer rows all 0', async () => {
    const processKey = `bpmn-p1b2-gate-${randomUUID()}`
    const deployRes = await deploy(timerBearingProcessXml(processKey), processKey)
    expect(deployRes.status, deployRes.raw).toBe(201)

    const startRes = await start(processKey)
    expect(startRes.status, startRes.raw).toBe(500)
    expect(startRes.body?.error).toBe('BPMN_TIMER_POLLER_DISABLED')

    const c = await counts(processKey)
    expect(c, 'process/activity/incident/timer rows must ALL be zero — no ACTIVE residue, no orphaned activity, no incident, no timer row').toEqual({
      processes: 0,
      activities: 0,
      incidents: 0,
      timers: 0,
    })
  })

  it('poller disabled + a timer-FREE process: /start still succeeds (positive control — the gate does not over-block ordinary starts)', async () => {
    const processKey = `bpmn-p1b2-nogate-${randomUUID()}`
    const deployRes = await deploy(timerFreeProcessXml(processKey), processKey)
    expect(deployRes.status, deployRes.raw).toBe(201)

    const startRes = await start(processKey)
    expect(startRes.status, startRes.raw).toBe(201)
    expect(typeof startRes.body?.data?.instanceId).toBe('string')

    const c = await counts(processKey)
    expect(c.processes).toBe(1)
    expect(c.timers).toBe(0)
  })
})
