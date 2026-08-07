#!/usr/bin/env node
/**
 * Attendance Windows-native QA v2 — isolated-DB reset + migration-SET/trigger integrity (Fix 2).
 *
 * Draft/HOLD. Synthetic data only. No deployment/staging authorization.
 * Pinned product SOURCE_SHA: 0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b (unchanged by QA tooling).
 *
 * CLEANUP = DROP + recreate the isolated DB, never per-row DELETE — the append-only / deny-delete
 * triggers reject per-row cleanup on rollout state/events, calculations, snapshots, segments, the
 * operation registries, the outbox, and the scheduled-run tables (durable_storage.ts:1258-1301,
 * scheduled_run_...:218-368). After recreate + re-migrate, residue-check.sql returns 0 because the
 * DB is fresh.
 *
 * FALSE-ZERO GUARD (owner gate 2): a partial / wrong-DB re-migrate that leaves tables or triggers
 * missing would ALSO show zero synthetic rows and read clean. So "migration HEAD reached" is a
 * SET + TRIGGER integrity check, NOT a count/last-name heuristic (unordered histories allow a
 * dropped middle migration under a matching last name). Verify asserts ALL of:
 *   (a) db:migrate --list reports Pending: 0
 *   (b) the applied-migration NAME SET equals the pinned golden set (missing AND extra reported)
 *   (c) the two key W4C-0 / W4C-2 migrations are --confirm applied by name
 *   (d) every deny/append-only trigger exists AND is enabled (tgenabled <> 'D')
 * plus an optional live deny-trigger FIRES negative control (--prove-deny-delete).
 *
 * SAFETY (owner gate 4): before any DROP, hard-verify the target is EXACTLY metasheet_windows_qa on
 * a LOCAL host (parsed, not substring-matched — see qa-runtime.assertLocalIsolatedTarget), that the
 * app SERVICE is stopped (PM2 has no online process AND the app ports are not listening — a
 * running-but-idle app would pass the instantaneous session check and reconnect after the drop), and
 * that NO other session is connected. Refuse (throw, no drop) otherwise. DROP is issued from `postgres`.
 *
 * Usage (the runtime MODE picks the migrate CLI — tsx => src, plain node => built dist/src):
 *   macOS source proof:  node --import tsx reset-isolated-db.mjs        # migrations via tsx+src
 *   Windows package:     node reset-isolated-db.mjs                     # migrations via dist/src
 *   flags: --verify-only (verify a-d, no drop) | --prove-deny-delete (deny trigger RAISES probe)
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  CORE_BACKEND,
  assertLocalIsolatedTarget,
  importProduct,
  loadPg,
  productModuleMode,
  resolveProductModule,
} from './harness/qa-runtime.mjs'
import {
  EXPECTED_MIGRATION_CONFIRM_NAMES,
  EXPECTED_DENY_TRIGGERS,
} from './harness/qa-identities.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN_SET = JSON.parse(
  fs.readFileSync(path.join(HERE, 'harness', 'expected-migration-set.json'), 'utf8'),
)
const TARGET_DB = 'metasheet_windows_qa'

function log(msg) {
  console.log(`[reset-isolated-db] ${msg}`)
}

// Owner FIX 3 — service-stopped proof. pg_stat_activity=0 is a single instant: a running-but-IDLE app
// (0 open sessions right now) passes it and reconnects immediately after the drop. So we ALSO prove the
// app process is stopped. The packaged app runs under PM2 (ecosystem.windows-native.config.cjs), so the
// primary check is PM2; a listening app port is the belt-and-suspenders that also covers a host without
// PM2 (so pm2-absence is NOT a silent fail-open — a live app still LISTENS even when idle).
// Owner P2 (fail-open): QA_APP_PORT SUPPLEMENTS the defaults, it does not REPLACE them. The old code
// returned ONLY [QA_APP_PORT] when it was set, so pointing QA_APP_PORT at a free port let a service
// still listening on a default port (8900/8080) slip past the liveness check. UNION QA_APP_PORT with
// the defaults; dedupe; keep only finite positive ports.
export const DEFAULT_APP_PORTS = () => {
  const ports = new Set([
    Number(process.env.PORT || 8900),
    Number(process.env.WINDOWS_NATIVE_GATEWAY_PORT || 8080),
  ])
  const single = process.env.QA_APP_PORT
  if (single && single.trim() !== '') ports.add(Number(single))
  return [...ports].filter((p) => Number.isFinite(p) && p > 0)
}

function isTcpPortListening(host, port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port })
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(500)
    sock.once('connect', () => finish(true)) // something is accepting connections on this port
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false)) // ECONNREFUSED etc. => nothing listening
  })
}

/**
 * Prove the packaged app service is STOPPED (both a PM2 check and an app-port liveness check), so a
 * running-but-idle app cannot slip past the instantaneous DB-session check and reconnect post-drop.
 * Throws (no drop) if the service looks up.
 */
export async function assertAppServiceStopped() {
  // (i) PM2 — refuse if any PM2-managed process is 'online'. QA_PM2_BIN lets a test point at a stub.
  const pm2Bin = process.env.QA_PM2_BIN || 'pm2'
  let pm2Available = false
  let pm2Out = ''
  try {
    pm2Out = execFileSync(pm2Bin, ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    pm2Available = true
  } catch (error) {
    // Owner P2 (fail-open): distinguish "pm2 not installed" from "pm2 present but failing". ENOENT is
    // spawn-not-found -> pm2 is genuinely absent, so the port check below is the service-stopped proof.
    // ANY OTHER failure (non-zero exit, EACCES, ...) means pm2 IS present but we could not obtain a
    // trustworthy process list -> fail CLOSED (refuse, no drop), never treat as "no processes".
    if (error && error.code === 'ENOENT') {
      pm2Available = false
    } else {
      throw new Error(
        `Refusing to DROP ${TARGET_DB}: '${pm2Bin} jlist' failed (${error?.code ?? error?.message ?? 'unknown error'}). ` +
          `pm2 appears present but its process list is unreadable — the app-stopped state cannot be proven. ` +
          `Fix pm2 or stop the app, then retry.`,
      )
    }
  }
  if (pm2Available) {
    // Owner P2 (fail-open): a garbled / non-array jlist previously fell back to an EMPTY process list
    // (treated as "0 online" -> drop). That is fail-OPEN. A pm2 that IS present but returns unparseable
    // or non-array output cannot prove zero online processes -> fail CLOSED (refuse).
    let procs
    try {
      procs = JSON.parse(pm2Out || '[]')
    } catch {
      throw new Error(
        `Refusing to DROP ${TARGET_DB}: '${pm2Bin} jlist' returned unparseable output — cannot prove the ` +
          `app is stopped. Fix pm2 or stop the app, then retry.`,
      )
    }
    if (!Array.isArray(procs)) {
      throw new Error(
        `Refusing to DROP ${TARGET_DB}: '${pm2Bin} jlist' did not return a JSON array — cannot prove the ` +
          `app is stopped. Fix pm2 or stop the app, then retry.`,
      )
    }
    const online = procs.filter((p) => p && p.pm2_env && p.pm2_env.status === 'online')
    if (online.length > 0) {
      const names = online.map((p) => p.name ?? p.pm_id).join(', ')
      throw new Error(
        `Refusing to DROP ${TARGET_DB}: PM2 reports ${online.length} process(es) still online (${names}). ` +
          `Stop the app first (pm2 stop <name> / pm2 delete <name>).`,
      )
    }
    log(`gate 4 service-stopped (PM2): ${Array.isArray(procs) ? procs.length : 0} process(es) registered, 0 online.`)
  }
  // (ii) App-port liveness — a running (even idle) app still accepts connections on its port.
  const ports = DEFAULT_APP_PORTS().filter((p) => Number.isFinite(p) && p > 0)
  for (const port of ports) {
    if (await isTcpPortListening('127.0.0.1', port)) {
      throw new Error(
        `Refusing to DROP ${TARGET_DB}: app port ${port} on 127.0.0.1 is still accepting connections — ` +
          `the service is running. Stop it first.`,
      )
    }
  }
  log(
    `gate 4 service-stopped (port): ${ports.join(', ')} not listening` +
      (pm2Available ? '.' : ' (pm2 not installed — the port check is the service-stopped proof).'),
  )
}

/**
 * Resolve how to run the product migrate CLI. Owner scope ruling B applies here too: the runtime
 * MODE determines the ONE path (resolveProductModule enforces missing-path failure + symlink
 * rejection; the real tsc layout is dist/src/db/migrate.js — the old dist/db/migrate.js probe
 * never existed, so the dist branch silently never ran):
 *   tsx-src   -> the package's own tsx binary against src/db/migrate.ts (macOS source proof),
 *   node-dist -> plain node against the compiled dist/src/db/migrate.js (Windows package).
 */
function migrateRunner() {
  const abs = resolveProductModule('db/migrate')
  if (productModuleMode() === 'tsx-src') {
    // Run via the workspace tsx binary (what the package's own migrate npm script does).
    return { cmd: 'pnpm', baseArgs: ['exec', 'tsx', abs] }
  }
  return { cmd: process.execPath, baseArgs: [abs] }
}

function runMigrate(args, env) {
  const { cmd, baseArgs } = migrateRunner()
  return execFileSync(cmd, [...baseArgs, ...args], {
    cwd: CORE_BACKEND,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function assertNoExclusionEnv(env) {
  // gate 2: MIGRATION_EXCLUDE / MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL silently shrink or reshape
  // the provider set (migration-provider.ts:264-276), which would shift the golden set and drop
  // tables. Neither may be set when re-migrating the isolated DB.
  for (const key of ['MIGRATION_EXCLUDE', 'MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL']) {
    const v = env[key]
    if (typeof v === 'string' && v.trim() !== '') {
      throw new Error(`Refusing: ${key} is set ("${v}") — it would reshape the migration set. Unset it.`)
    }
  }
}

function pgConfigFrom(connectionString, database) {
  const u = new URL(connectionString)
  return {
    host: u.hostname || 'localhost',
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    database,
  }
}

async function withClient(config, body) {
  // Load pg lazily (not at module top level) so this module is importable — for the reset test's
  // service-stopped checks — without `pg` present. It is only needed when a DB connection is opened.
  const pg = loadPg()
  const client = new pg.Client(config)
  await client.connect()
  try {
    return await body(client)
  } finally {
    await client.end()
  }
}

async function dropAndRecreate(connectionString) {
  // Gate 4 (owner FIX 3): BOTH must hold before any DROP — (1) the app service is stopped (PM2 +
  // app-port liveness) AND (2) no other session is connected to the target. (2) alone is a single
  // instant that a running-but-idle app would pass and then reconnect through.
  await assertAppServiceStopped()
  // (2) no other session on the target, checked from the `postgres` maintenance DB (never the target).
  const adminCfg = pgConfigFrom(connectionString, 'postgres')
  await withClient(adminCfg, async (admin) => {
    const others = await admin.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TARGET_DB],
    )
    const n = others.rows[0]?.n ?? 0
    if (n !== 0) {
      throw new Error(
        `Refusing to DROP ${TARGET_DB}: ${n} other session(s) still connected. Stop the service first.`,
      )
    }
    log(`gate 4 OK: local target ${TARGET_DB}, 0 other sessions connected.`)
    await admin.query(`DROP DATABASE IF EXISTS ${TARGET_DB}`)
    log(`dropped database ${TARGET_DB}`)
    await admin.query(`CREATE DATABASE ${TARGET_DB}`)
    log(`created database ${TARGET_DB}`)
  })
}

async function verifyMigrationHead(connectionString, env) {
  // (a) Pending: 0
  const listOut = runMigrate(['--list'], env)
  const appliedMatch = listOut.match(/Applied:\s*(\d+)/)
  const pendingMatch = listOut.match(/Pending:\s*(\d+)/)
  const applied = appliedMatch ? Number(appliedMatch[1]) : NaN
  const pending = pendingMatch ? Number(pendingMatch[1]) : NaN
  if (pending !== 0) {
    throw new Error(`Migration verify FAILED (a): Pending=${pending} (expected 0).\n${listOut}`)
  }
  log(`(a) Pending: 0 (Applied: ${applied})`)

  // (b) exact applied NAME SET equality against the golden set.
  const targetCfg = pgConfigFrom(connectionString, TARGET_DB)
  const dbNames = await withClient(targetCfg, async (client) => {
    const r = await client.query('SELECT name FROM kysely_migration ORDER BY name')
    return r.rows.map((row) => row.name)
  })
  const golden = new Set(GOLDEN_SET.names)
  const live = new Set(dbNames)
  const missing = [...golden].filter((n) => !live.has(n))
  const extra = [...live].filter((n) => !golden.has(n))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Migration verify FAILED (b): applied set != golden set.\n` +
        `  missing (in golden, not applied): ${missing.length ? missing.join(', ') : '(none)'}\n` +
        `  extra   (applied, not in golden): ${extra.length ? extra.join(', ') : '(none)'}`,
    )
  }
  if (applied !== GOLDEN_SET.appliedCount) {
    throw new Error(
      `Migration verify FAILED (b): applied count ${applied} != golden ${GOLDEN_SET.appliedCount}.`,
    )
  }
  log(`(b) applied name SET == golden set (${dbNames.length} names, no missing, no extra)`)

  // (c) name-level confirmation of the two key migrations (catches "tables missing" directly).
  for (const name of EXPECTED_MIGRATION_CONFIRM_NAMES) {
    try {
      runMigrate(['--confirm', name], env)
    } catch (error) {
      throw new Error(`Migration verify FAILED (c): --confirm ${name} is NOT applied.\n${error.message}`)
    }
    log(`(c) --confirm ${name}: applied`)
  }

  // (d) every deny/append-only trigger exists AND is enabled (tgenabled <> 'D').
  await withClient(targetCfg, async (client) => {
    for (const { table, trigger } of EXPECTED_DENY_TRIGGERS) {
      const r = await client.query(
        `SELECT t.tgenabled AS en
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
          WHERE c.relname = $1 AND t.tgname = $2 AND NOT t.tgisinternal`,
        [table, trigger],
      )
      if (r.rows.length === 0) {
        throw new Error(`Migration verify FAILED (d): trigger ${trigger} on ${table} is MISSING.`)
      }
      if (r.rows[0].en === 'D') {
        throw new Error(`Migration verify FAILED (d): trigger ${trigger} on ${table} is DISABLED.`)
      }
    }
    log(`(d) ${EXPECTED_DENY_TRIGGERS.length} deny/append-only triggers present and enabled`)
  })

  return { applied, pending }
}

/**
 * Optional live negative control: prove a deny-delete trigger actually RAISES W4C0_IMMUTABLE (a
 * catalog probe alone only proves the trigger exists, not that it fires). Runs on the CURRENT DB;
 * intended for the pre-teardown negative-control phase since the seeded row cannot be deleted.
 *
 * The probe row is seeded through the PRODUCT rollout-transition boundary (canonical writer of
 * attendance_calculation_rollout_state — this script writes no raw INSERT on a w4_canonical
 * table). The DELETE below is the probe ITSELF: a deliberately forbidden statement whose ONLY
 * acceptable outcome is the deny trigger raising — it is classified as an exact-tuple negative
 * probe in the W4C-0 DML inventory (W4_CANONICAL_EXACT_NEGATIVE_PROBE_ALLOWLIST), never a
 * path/prefix exemption.
 */
async function seedDenyProbeRolloutRow(client, synthOrg) {
  // Seed one rollout-state row for the dedicated probe org if absent — via the REAL transition
  // boundary (bootstraps legacy(v1) -> shadow), exactly like the harnesses' ensureShadowPosture.
  // No raw INSERT: the product rollout-control module is the canonical writer.
  const existing = (await client.query(
    `SELECT state FROM attendance_calculation_rollout_state WHERE org_id = $1`,
    [synthOrg],
  )).rows[0]
  if (existing) return
  process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = synthOrg
  const crypto = await import('node:crypto')
  const { transitionAttendanceCalculationRolloutV1 } = await importProduct('attendance/w4c3a-rollout-control')
  const result = await transitionAttendanceCalculationRolloutV1(client, {
    orgId: synthOrg,
    actorId: 'qa_synth_probe_actor',
    correlationId: crypto.randomUUID(),
    engineVersion: 'qa_synth_engine_v1',
    targetState: 'shadow',
    expectedState: 'legacy',
    expectedVersion: 1,
    evidenceManifestSha256: crypto.createHash('sha256').update('qa_synth_deny_delete_probe').digest('hex'),
    evidenceReferences: {
      imageSha: 'qa_synth_image_sha_probe',
      ownerAuthorizationRef: 'qa_synth_owner_auth_probe',
      syntheticOrgRef: 'qa_synth_org_ref_probe',
    },
    reasonCode: 'rollout_transition',
  })
  if (result.state !== 'shadow') {
    throw new Error(`probe seed transition returned state=${result.state} (expected shadow)`)
  }
}

async function proveDenyDeleteFires(connectionString) {
  const targetCfg = pgConfigFrom(connectionString, TARGET_DB)
  const SYNTH_ORG = '00000000-0000-4000-8000-0000000000de'
  await withClient(targetCfg, async (client) => {
    await seedDenyProbeRolloutRow(client, SYNTH_ORG)
    let raised = null
    try {
      // NEGATIVE PROBE (exact-tuple classified, see W4_CANONICAL_EXACT_NEGATIVE_PROBE_ALLOWLIST):
      // this DELETE must NEVER succeed — the deny trigger raising W4C0_IMMUTABLE is the asserted
      // outcome.
      await client.query(`DELETE FROM attendance_calculation_rollout_state WHERE org_id = $1`, [SYNTH_ORG])
    } catch (error) {
      raised = error?.message || String(error)
    }
    if (!raised || !/W4C0_IMMUTABLE/.test(raised)) {
      throw new Error(
        `Deny-delete negative control FAILED: DELETE did NOT raise W4C0_IMMUTABLE (got: ${raised ?? 'no error'}).`,
      )
    }
    log(`deny-delete FIRES: DELETE on attendance_calculation_rollout_state raised -> ${raised.split('\n')[0]}`)
  })
}

async function main() {
  const { host, dbName } = assertLocalIsolatedTarget()
  const connectionString = process.env.DATABASE_URL
  const env = { ...process.env, DATABASE_URL: connectionString }
  assertNoExclusionEnv(env)
  log(`target: ${dbName} @ ${host || 'local-socket'}`)

  if (process.argv.includes('--prove-deny-delete')) {
    await proveDenyDeleteFires(connectionString)
    return
  }

  if (process.argv.includes('--verify-only')) {
    await verifyMigrationHead(connectionString, env)
    log('verify-only: migration SET + trigger integrity OK')
    return
  }

  // Full reset: gate-4 safe drop/recreate, re-migrate, verify.
  await dropAndRecreate(connectionString)
  log('re-running product migrations (MIGRATION_EXCLUDE / INCLUDE unset)...')
  const migrateOut = runMigrate([], env)
  const lastLines = migrateOut.trim().split('\n').slice(-2).join(' | ')
  log(`migrate complete: ${lastLines}`)
  await verifyMigrationHead(connectionString, env)
  log('RESET OK: recreated DB reached the pinned migration SET; deny triggers present.')
}

// Run only as a CLI (guarded like the runner) so the module can be imported by tests without firing
// main(). Use the exact pathToFileURL idiom to survive macOS /tmp -> /private/tmp symlink differences.
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(`[reset-isolated-db] ERROR: ${error?.message ?? error}`)
    process.exit(1)
  })
}
