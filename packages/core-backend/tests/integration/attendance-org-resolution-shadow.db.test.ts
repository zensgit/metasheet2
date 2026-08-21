/**
 * Route-level coverage for the SHADOW audit of the self-service punch route's org resolution
 * (plugins/plugin-attendance/lib/attendance-org-resolution-shadow.cjs, wired into
 * POST /api/attendance/punch in plugins/plugin-attendance/index.cjs). Boots ONE real
 * MetaSheetServer with the real plugin and drives the real route end to end against real
 * PostgreSQL — this proves the ROUTE actually calls the shadow recorder under the right env
 * posture and never under the wrong one, not just that the decision logic is correct in
 * isolation (that is covered, without a database, by
 * tests/unit/attendance-org-resolution-shadow.test.ts).
 *
 * `ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1` is read ONCE, inside `activate()`, at plugin
 * ACTIVATION time — not at server boot. A second `MetaSheetServer` boot in the same process is
 * NOT how this suite gets a second posture: `MetaSheetServer.stop()` closes the module-level
 * shared `pool` (packages/core-backend/src/db/pg.ts, imported by every server instance in the
 * process), so a second `new Server().start()` after a first `.stop()` fails outright — this
 * codebase has no precedent of >1 `new Server(` per test file for exactly that reason. Instead,
 * this suite uses the SAME mechanism a real operator would: the admin plugin-reload API
 * (`POST /api/admin/plugins/plugin-attendance/enable`, `requireAdminRole()`-gated, wired to
 * `activatePluginByName` in packages/core-backend/src/index.ts). That call re-runs the SAME
 * `activate(context)` this plugin already ran at boot — reading `process.env` fresh — after
 * `cleanupPluginRuntimeRegistrations` tears down the previous activation's routes. One server,
 * one shared pool, three activations (off at boot, then shadow, then enforce).
 *
 * Cases (each uses its own user so no case's punch can trip another case's min-punch-interval
 * guard, and cleanup is exact per case):
 *   (a)  Activation 1 — env UNSET (default 'off'), the posture the plugin boots with: member of
 *        the default org, no orgId in body -> punch 200, ZERO rows in
 *        attendance_org_resolution_shadow. The off-gate is at the ROUTE'S CALL SITE
 *        (plugins/plugin-attendance/index.cjs, `if (attendanceOrgResolutionShadowMode ===
 *        SHADOW_MODE_SHADOW)`), not an internal early-return inside the module, so "zero rows"
 *        here is also proof of "zero membership queries issued by this module" — the module is
 *        never invoked at all on this posture. (Instrumenting the shared `db.query` call count
 *        directly is not available from outside the real server process this suite boots, so
 *        the row count plus this code-level guarantee is the evidence, per this line's own
 *        "otherwise assert zero rows + document" fallback.)
 *   ---  env switched to 'shadow', plugin reactivated via the admin API (asserted `active`) ---
 *   (b)  sole membership 'default', no orgId, no tenant claim -> punch 200, one row:
 *        org_legacy='default', org_claim=null, org_chosen='default', rule='legacy_default',
 *        agree=true.
 *   (c)  memberships {default, X}, TOKEN CLAIM 'default' (minted via dev-token's own
 *        `tenantId=default` param, re-verified server-side against this user's real 'default'
 *        membership row by AuthService.resolveSessionTenantId), no orgId -> punch 200, one row:
 *        org_legacy='default', org_claim='default', org_chosen=X,
 *        rule='sole_non_default_membership', agree=false. THE DISCRIMINATING ROW — the
 *        'default'-claim loop the design lock calls out: a claim of the legacy sentinel must
 *        NOT beat a real non-default membership.
 *   (d)  sole membership X, body.orgId=X (member, matches the existing
 *        attendance-punch-org-resolution.cjs check) -> punch 200, one row: org_legacy=X,
 *        org_chosen=X, rule='request', agree=true.
 *   (P2-1) THE ORG_LEGACY PROVENANCE CASE (gate #5064 must-fix): sole membership orgY, request
 *        `x-org-id: orgY` header AND body `{orgId: ""}` (EMPTY STRING, not absent) -> punch 200.
 *        `getOrgId(req)` (the route's OWN legacy helper) and `extractRequestedPunchOrgIdV1`
 *        (what the route's actual org resolution — and this module's `request_org_supplied` —
 *        goes through) diverge on exactly this shape: `getOrgId` reads RAW values through `??`,
 *        so an empty-string `body.orgId` is already non-null/non-undefined and short-circuits
 *        the chain there, NEVER reaching the header, resolving to `'default'`;
 *        `extractRequestedPunchOrgIdV1` normalizes each source FIRST (empty string -> `null`)
 *        and THEN chains with `??`, so it correctly falls through to the header and resolves to
 *        `orgY`. The route's real DML write goes through the second (correct) path, so
 *        `attendance_records.org_id` for this punch is `orgY` — independently queried as the
 *        ground truth. This case asserts `attendance_org_resolution_shadow.org_legacy` matches
 *        THAT ground truth exactly, not merely that the row is internally self-consistent
 *        (`org_chosen`/`agree` mirror whatever `org_legacy` was handed under rule `request`
 *        regardless of whether it is right, so they cannot catch this class of bug — only a
 *        cross-check against the independently-written `attendance_records` row can).
 *   (LB) LOAD-BEARING (owner-review P2): a REAL Postgres-side delay (BEFORE INSERT trigger +
 *        pg_sleep, not a JS mock) on the recorder's own INSERT -> the punch response completes
 *        in well under the delay, proving the call site does not `await` the recorder. After
 *        `whenIdleForTestingV1()` settles, the (delayed) row lands with the expected fields.
 *   (ST) STATEMENT-TIMEOUT (owner-review P2 follow-up): the same real-delay mechanism, this
 *        time longer than SHADOW_STATEMENT_TIMEOUT_MS but shorter than RECORD_TIMEOUT_MS ->
 *        Postgres itself cancels the stuck statement (a real `query_canceled`, not a JS-side
 *        abandonment) — the punch is unaffected, no row ever lands, and the metrics delta shows
 *        `failed` incrementing (not `timed_out`) — proof the DB-side timeout fired first.
 *   (e)  the shadow INSERT itself fails (the table is renamed away for the duration of this one
 *        punch, then renamed back in a finally, AFTER `whenIdleForTestingV1()` — the recorder is
 *        fire-and-forget now, so renaming the table back too early could race a still-pending
 *        INSERT and let it land against the real table after all) -> punch STILL 200 — the
 *        audit write is non-fatal by construction.
 *   ---  env switched to 'enforce', plugin reactivated via the admin API ---
 *   (f)  `parseAttendanceOrgResolutionShadowModeV1` throws inside `activate()`;
 *        `activatePluginInstance` catches plugin-activation throws and records `status:
 *        'failed'` rather than rejecting the reactivation call — so this case asserts on the
 *        `/enable` call's OWN response body (`runtime.status === 'failed'`, `runtime.error`
 *        naming the offending env var) AND that POST /api/attendance/punch — never re-mounted,
 *        since this activation attempt aborted before this plugin's
 *        `context.api.http.addRoute` calls ran, and the PRIOR (shadow) activation's routes were
 *        already torn down by `cleanupPluginRuntimeRegistrations` before this attempt — returns
 *        exactly `404` (Express's own unmounted-route response; pinned to the actual value, not
 *        `not.toBe(200)`), using a FRESH user that has never punched anywhere in this file, so
 *        the 404 cannot be a business-logic rejection (e.g. a repeat-punch/interval guard)
 *        wearing a "not 200" disguise — a fresh user hitting the SAME unmounted route also gets
 *        404, so the assertion is not vacuous.
 *
 * Mutations this suite must catch (see the PR's mutation self-check):
 *   - make `agree` always true in the module -> (c) reds (expects agree=false).
 *   - skip the `orgClaim !== 'default'` guard in rule 2 -> (c) reds (expects rule
 *     'sole_non_default_membership', not 'claim').
 *   - remove the env gate at the route call site -> (a) reds (expects zero rows).
 *   - the call site's `orgLegacy: orgId` mutated to `orgLegacy: getOrgId(req)` -> (P2-1) reds
 *     (org_legacy would read 'default' while attendance_records.org_id is orgY).
 *   - restore `await` at the call site (drop the fire-and-forget `void ... .catch(() => {})`)
 *     -> (LB) reds (elapsedMs would be >= the trigger's sleep duration instead of well under
 *     it).
 *   - remove the module's `SET LOCAL statement_timeout` statement -> (ST) reds (the delta would
 *     show `timed_out` incrementing instead of `failed`, since nothing would cancel the
 *     statement before RECORD_TIMEOUT_MS's JS-side backstop).
 *
 * Shared-DB discipline: every fixture id is a file-namespaced random UUID.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as path from 'node:path'
import net from 'net'
import http from 'http'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import type { MetaSheetServer } from '../../src/index'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '../../../../')
const ATTENDANCE_PLUGIN_DIR = path.join(REPO_ROOT, 'plugins', 'plugin-attendance')
const SHADOW_TABLE = 'attendance_org_resolution_shadow'
const SHADOW_ENV_VAR = 'ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1'

// The plugin (a .cjs file, loaded in-process by the real MetaSheetServer this suite boots) and
// this test file resolve the SAME absolute path here, so Node's CJS require cache hands back
// the exact same module instance the route actually calls — whenIdleForTestingV1() and the
// metrics snapshot below reflect the REAL recorder's in-flight/metrics state, not a separate
// copy of the module.
const requireCjs = createRequire(import.meta.url)
const shadowModule = requireCjs(path.join(ATTENDANCE_PLUGIN_DIR, 'lib', 'attendance-org-resolution-shadow.cjs')) as {
  whenIdleForTestingV1: () => Promise<void>
  getShadowMetricsSnapshotForTestingV1: () => { attempted: number; written: number; timed_out: number; dropped: number; failed: number }
  SHADOW_STATEMENT_TIMEOUT_MS: number
  RECORD_TIMEOUT_MS: number
}
const { whenIdleForTestingV1, getShadowMetricsSnapshotForTestingV1, SHADOW_STATEMENT_TIMEOUT_MS, RECORD_TIMEOUT_MS } = shadowModule

type HttpResponse = { status: number; body?: any; raw: string }
function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        method: options.method || 'GET',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
      },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          let body: unknown
          try { body = data ? JSON.parse(data) : undefined } catch { body = undefined }
          resolve({ status: res.statusCode || 0, body, raw: data })
        })
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

describeDb('POST /api/attendance/punch — org resolution shadow audit', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool | undefined
  let baseUrl = ''
  let priorRbacBypass: string | undefined
  let priorSkipPlugins: string | undefined
  let priorShadowEnv: string | undefined

  const orgX = randomUUID()
  const orgY = randomUUID() // (P2-1) org_legacy provenance case

  const adminUser = randomUUID() // reactivates the plugin via the admin API between phases
  const userA = randomUUID() // (a) sole membership 'default', no orgId — env off
  const userB = randomUUID() // (b) sole membership 'default', no claim, no orgId
  const userC = randomUUID() // (c) memberships {default, X}, claim 'default', no orgId — THE discriminating row
  const userD = randomUUID() // (d) sole membership X, body.orgId=X
  const userP2 = randomUUID() // (P2-1) sole membership orgY, body.orgId="" + x-org-id header
  const userE = randomUUID() // (e) insert failure is non-fatal
  const userLB = randomUUID() // (LB) LOAD-BEARING: response completes while the recorder's own INSERT is still delayed
  const userST = randomUUID() // (ST) SET LOCAL statement_timeout genuinely cancels a stuck recorder statement server-side
  const userF = randomUUID() // (f) FRESH — never punches; proves the 404 isn't a business-logic rejection

  const allUserIds = [adminUser, userA, userB, userC, userD, userP2, userE, userLB, userST, userF]

  // (LB) / (ST): a BEFORE INSERT trigger on the shadow table, scoped to ONE user_id via a WHEN
  // clause, that sleeps before letting the row through — a REAL Postgres-side delay, not a JS
  // mock. This is what proves (LB) the punch response never awaits the recorder's own INSERT,
  // and (ST) that SHADOW_STATEMENT_TIMEOUT_MS is a genuine server-side statement_timeout (the
  // statement is CANCELLED by Postgres itself once exceeded — pg_sleep(n) only asks Postgres to
  // sleep for n seconds; statement_timeout still cuts it off early at the configured bound).
  const installDelayTrigger = async (userId: string, fnName: string, triggerName: string, sleepSeconds: number) => {
    await pool!.query(`
      CREATE OR REPLACE FUNCTION ${fnName}() RETURNS TRIGGER AS $$
      BEGIN
        PERFORM pg_sleep(${sleepSeconds});
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    await pool!.query(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON ${SHADOW_TABLE}
      FOR EACH ROW
      WHEN (NEW.user_id = '${userId}')
      EXECUTE FUNCTION ${fnName}();
    `)
  }

  const removeDelayTrigger = async (fnName: string, triggerName: string) => {
    await pool!.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${SHADOW_TABLE}`).catch(() => undefined)
    await pool!.query(`DROP FUNCTION IF EXISTS ${fnName}()`).catch(() => undefined)
  }

  const mintToken = async (userId: string, tenantId?: string): Promise<string> => {
    const tenantParam = tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : ''
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin')}${tenantParam}`,
    )
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }

  const punch = async (userId: string, opts: { orgId?: string; tenantId?: string; xOrgIdHeader?: string } = {}) =>
    requestJson(`${baseUrl}/api/attendance/punch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await mintToken(userId, opts.tenantId)}`,
        'Content-Type': 'application/json',
        // Only added when explicitly requested — `undefined` here must NOT become the literal
        // string 'undefined' via the header-object surface.
        ...(opts.xOrgIdHeader !== undefined ? { 'x-org-id': opts.xOrgIdHeader } : {}),
      },
      body: JSON.stringify({
        eventType: 'check_in',
        operationId: randomUUID(),
        // `!== undefined` (not truthy) so a caller can force a LITERAL EMPTY STRING through —
        // case (P2-1) needs body.orgId==="" specifically, which `opts.orgId ? ... : ...` would
        // silently drop.
        ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
      }),
    })

  const shadowRowFor = async (userId: string): Promise<Record<string, unknown> | undefined> => {
    const result = await pool!.query(
      `SELECT user_id, route, org_legacy, org_claim, request_org_supplied, membership_count,
              non_default_membership_count, org_chosen, agree, rule
       FROM ${SHADOW_TABLE} WHERE user_id = $1`,
      [userId],
    )
    return result.rows[0]
  }

  const shadowRowCountFor = async (userId: string): Promise<number> =>
    Number((await pool!.query(`SELECT COUNT(*)::int AS n FROM ${SHADOW_TABLE} WHERE user_id = $1`, [userId])).rows[0]?.n ?? 0)

  // Ground truth for (P2-1): the org the punch route ACTUALLY wrote the record under —
  // completely independent of the shadow module/table, since this reads what the pre-existing
  // (unmutated-by-this-PR) attendance-punch-org-resolution.cjs + DML write path produced.
  const attendanceRecordOrgIdFor = async (userId: string): Promise<string | undefined> =>
    (await pool!.query(`SELECT org_id FROM attendance_records WHERE user_id = $1`, [userId])).rows[0]?.org_id

  // Re-runs plugin-attendance's activate() with whatever ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1
  // is set to right now, via the same admin reload path a real operator would use — see the file
  // header for why this replaces a second server boot.
  const reactivateAttendancePlugin = async (): Promise<HttpResponse> => {
    const token = await mintToken(adminUser)
    return requestJson(`${baseUrl}/api/admin/plugins/plugin-attendance/enable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('suite needs loopback + DATABASE_URL')

    priorRbacBypass = process.env.RBAC_BYPASS
    priorSkipPlugins = process.env.SKIP_PLUGINS
    priorShadowEnv = process.env[SHADOW_ENV_VAR]
    delete process.env[SHADOW_ENV_VAR] // boot with the default 'off' posture — case (a)
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'

    const { MetaSheetServer: Server } = await import('../../src/index')
    server = new Server({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [ATTENDANCE_PLUGIN_DIR],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('no TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })

    for (const userId of allUserIds) {
      await pool.query(
        `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
         VALUES ($1, $2, $1, 'org resolution shadow fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [userId, `${userId}@org-resolution-shadow.test`],
      )
    }
    // Real RBAC admin row (packages/core-backend/src/rbac/service.ts's `isAdmin`, the check
    // behind requireAdminRole()) — distinct from RBAC_BYPASS, which only short-circuits
    // plugin-attendance's OWN attendance:* permission helper, not this core admin route.
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [adminUser])

    const addMembership = (userId: string, orgId: string) =>
      pool!.query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [userId, orgId])
    await addMembership(userA, 'default')
    await addMembership(userB, 'default')
    await addMembership(userC, 'default')
    await addMembership(userC, orgX)
    await addMembership(userD, orgX)
    await addMembership(userP2, orgY)
    await addMembership(userE, 'default')
    await addMembership(userLB, 'default')
    await addMembership(userST, 'default')
    await addMembership(userF, 'default')
  }, 180_000)

  afterAll(async () => {
    // Belt-and-braces: (LB)/(ST) already remove their own trigger/function in a `finally`, but
    // clean up here too in case a test failed before reaching it.
    await removeDelayTrigger('shadow_lb_delay_fn', 'shadow_lb_delay_trigger').catch(() => undefined)
    await removeDelayTrigger('shadow_st_delay_fn', 'shadow_st_delay_trigger').catch(() => undefined)
    await pool?.query(`DELETE FROM ${SHADOW_TABLE} WHERE user_id = ANY($1::text[])`, [allUserIds]).catch(() => undefined)
    for (const table of ['attendance_record_segments', 'attendance_record_calculations', 'attendance_records', 'attendance_events']) {
      await pool?.query(`DELETE FROM ${table} WHERE user_id = ANY($1::text[])`, [allUserIds]).catch(() => undefined)
    }
    await pool?.query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [allUserIds]).catch(() => undefined)
    await pool?.query(`DELETE FROM user_roles WHERE user_id = $1`, [adminUser]).catch(() => undefined)
    await pool?.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [allUserIds]).catch(() => undefined)
    await pool?.end()
    await server?.stop?.()
    if (priorRbacBypass === undefined) delete process.env.RBAC_BYPASS
    else process.env.RBAC_BYPASS = priorRbacBypass
    if (priorSkipPlugins === undefined) delete process.env.SKIP_PLUGINS
    else process.env.SKIP_PLUGINS = priorSkipPlugins
    if (priorShadowEnv === undefined) delete process.env[SHADOW_ENV_VAR]
    else process.env[SHADOW_ENV_VAR] = priorShadowEnv
  }, 60_000)

  it('(a) env unset (boot posture) -> punch succeeds exactly as before, and writes ZERO shadow audit rows', async () => {
    expect(await shadowRowCountFor(userA)).toBe(0)
    const res = await punch(userA)
    expect(res.status).toBe(200)
    expect(await shadowRowCountFor(userA)).toBe(0)
  })

  it("switches the plugin to env=shadow via the admin reload API (a real operator's mechanism, not a second server boot)", async () => {
    process.env[SHADOW_ENV_VAR] = 'shadow'
    const res = await reactivateAttendancePlugin()
    expect(res.status).toBe(200)
    expect(res.body?.runtime?.status).toBe('active')
  })

  it('(b) sole membership "default", no claim, no orgId -> 200, one row: legacy_default, agree=true', async () => {
    const res = await punch(userB)
    expect(res.status).toBe(200)
    // The recorder is fire-and-forget (owner-review P2) — the response can return before the
    // audit row lands. Settle deterministically instead of racing the background INSERT.
    await whenIdleForTestingV1()
    const row = await shadowRowFor(userB)
    expect(row).toMatchObject({
      user_id: userB,
      route: '/api/attendance/punch',
      org_legacy: 'default',
      org_claim: null,
      request_org_supplied: false,
      membership_count: 1,
      non_default_membership_count: 0,
      org_chosen: 'default',
      agree: true,
      rule: 'legacy_default',
    })
  })

  it("(c) THE DISCRIMINATING ROW — memberships {default, X}, token claim 'default', no orgId -> 200, org_chosen=X, rule=sole_non_default_membership, agree=false", async () => {
    const res = await punch(userC, { tenantId: 'default' })
    expect(res.status).toBe(200)
    await whenIdleForTestingV1()
    const row = await shadowRowFor(userC)
    expect(row).toMatchObject({
      user_id: userC,
      route: '/api/attendance/punch',
      org_legacy: 'default',
      org_claim: 'default',
      request_org_supplied: false,
      membership_count: 2,
      non_default_membership_count: 1,
      org_chosen: orgX,
      agree: false,
      rule: 'sole_non_default_membership',
    })
  })

  it('(d) sole membership X, body.orgId=X -> 200, org_legacy=X, org_chosen=X, rule=request, agree=true', async () => {
    const res = await punch(userD, { orgId: orgX })
    expect(res.status).toBe(200)
    await whenIdleForTestingV1()
    const row = await shadowRowFor(userD)
    expect(row).toMatchObject({
      user_id: userD,
      route: '/api/attendance/punch',
      org_legacy: orgX,
      request_org_supplied: true,
      org_chosen: orgX,
      agree: true,
      rule: 'request',
    })
  })

  it("(P2-1) org_legacy PROVENANCE — sole membership orgY, body.orgId='' (empty string) + x-org-id: orgY -> punch 200, actually written under orgY (ground truth), and org_legacy MATCHES that ground truth exactly (not 'default')", async () => {
    const res = await punch(userP2, { orgId: '', xOrgIdHeader: orgY })
    expect(res.status).toBe(200)
    await whenIdleForTestingV1()

    // Ground truth, independent of the shadow table entirely.
    const actualOrgId = await attendanceRecordOrgIdFor(userP2)
    expect(actualOrgId).toBe(orgY)

    const row = await shadowRowFor(userP2)
    // The load-bearing assertion: org_legacy must equal the INDEPENDENTLY-queried actual org,
    // not merely be internally self-consistent with org_chosen/agree (see the file header for
    // why those two cannot catch this bug on their own).
    expect(row?.org_legacy).toBe(actualOrgId)
    expect(row).toMatchObject({
      user_id: userP2,
      route: '/api/attendance/punch',
      org_legacy: orgY,
      request_org_supplied: true,
      org_chosen: orgY,
      agree: true,
      rule: 'request',
    })
  })

  it('(LOAD-BEARING) the punch response completes while the recorder\'s own INSERT is still delayed — proves the call site does not await it', async () => {
    // A real Postgres-side delay (BEFORE INSERT trigger + pg_sleep), not a JS mock — see
    // installDelayTrigger's own comment. sleepSeconds is well under both
    // SHADOW_STATEMENT_TIMEOUT_MS and RECORD_TIMEOUT_MS, so this is a plain "still working"
    // delay, not a cancellation/timeout case (that is (ST) below).
    const fnName = 'shadow_lb_delay_fn'
    const triggerName = 'shadow_lb_delay_trigger'
    const lbSleepSeconds = 2
    await installDelayTrigger(userLB, fnName, triggerName, lbSleepSeconds)
    try {
      const start = Date.now()
      const res = await punch(userLB)
      const elapsedMs = Date.now() - start
      expect(res.status).toBe(200)
      // The response must not have waited for the trigger delay — this is the exact assertion
      // a restored `await recordShadowOrgResolutionV1(...)` at the call site would break
      // (elapsedMs would be >= ~lbSleepSeconds*1000 instead). SHADOW_STATEMENT_TIMEOUT_MS is
      // this suite's own margin reference: comfortably below it AND below the sleep itself.
      expect(elapsedMs).toBeLessThan(Math.min(lbSleepSeconds * 1000, SHADOW_STATEMENT_TIMEOUT_MS) - 500)

      // At this exact point the INSERT is (most likely) still sleeping inside the trigger —
      // not asserted as a hard requirement (a slow CI runner could theoretically let it land
      // between the response and this line), but the settle-then-assert pair below is the
      // load-bearing proof regardless of that timing wobble.
      await whenIdleForTestingV1()
    } finally {
      await removeDelayTrigger(fnName, triggerName)
    }
    const row = await shadowRowFor(userLB)
    expect(row).toMatchObject({
      user_id: userLB,
      org_legacy: 'default',
      org_chosen: 'default',
      agree: true,
      rule: 'legacy_default',
    })
  })

  it('(STATEMENT-TIMEOUT) a recorder statement stuck past SHADOW_STATEMENT_TIMEOUT_MS is CANCELLED SERVER-SIDE by Postgres — not merely abandoned client-side — and lands in the failed (not timed_out) metrics bucket', async () => {
    // stSleepSeconds exceeds SHADOW_STATEMENT_TIMEOUT_MS but stays under RECORD_TIMEOUT_MS —
    // Postgres's own statement_timeout must cancel the statement well before the JS race's
    // backstop would. If SET LOCAL statement_timeout were removed (mutation), nothing would
    // cancel the sleep before the JS race hits RECORD_TIMEOUT_MS, flipping the outcome from
    // 'failed' to 'timed_out' — this is exactly what makes this test mutation-sensitive.
    const fnName = 'shadow_st_delay_fn'
    const triggerName = 'shadow_st_delay_trigger'
    const stSleepSeconds = Math.ceil(RECORD_TIMEOUT_MS / 1000) + 1
    await installDelayTrigger(userST, fnName, triggerName, stSleepSeconds)
    const before = getShadowMetricsSnapshotForTestingV1()
    try {
      const res = await punch(userST)
      expect(res.status).toBe(200) // the punch itself is entirely unaffected
      await whenIdleForTestingV1()
    } finally {
      await removeDelayTrigger(fnName, triggerName)
    }
    const after = getShadowMetricsSnapshotForTestingV1()
    // The statement was cancelled (a real Postgres error, caught by performShadowRecordV1's own
    // try/catch) — NOT abandoned by the JS-side race — so this lands in `failed`, not
    // `timed_out`.
    expect(after.failed - before.failed).toBe(1)
    expect(after.timed_out - before.timed_out).toBe(0)
    // No row was ever committed — Postgres cancelled the INSERT statement before it could land.
    expect(await shadowRowCountFor(userST)).toBe(0)
  })

  it('(e) the shadow INSERT fails (table renamed away for this one punch) -> punch STILL 200, non-fatal by construction', async () => {
    const hiddenName = `${SHADOW_TABLE}_hidden_e_${randomUUID().replace(/-/g, '')}`
    await pool!.query(`ALTER TABLE ${SHADOW_TABLE} RENAME TO ${hiddenName}`)
    try {
      const res = await punch(userE)
      expect(res.status).toBe(200)
      // The recorder is fire-and-forget — the table must stay renamed until its (failed)
      // attempt has actually run, or renaming it back below could race a still-pending INSERT
      // and let it land against the real table after all.
      await whenIdleForTestingV1()
    } finally {
      await pool!.query(`ALTER TABLE ${hiddenName} RENAME TO ${SHADOW_TABLE}`)
    }
    // Restored: no row could have been written for userE (the table didn't exist under its
    // real name for the duration of the punch), and the table is provably usable again.
    expect(await shadowRowFor(userE)).toBeUndefined()
  })

  it('switches the plugin to env=enforce via the admin reload API -> the reload itself reports status=failed', async () => {
    process.env[SHADOW_ENV_VAR] = 'enforce'
    const res = await reactivateAttendancePlugin()
    expect(res.status).toBe(200)
    expect(res.body?.runtime?.status).toBe('failed')
    expect(res.body?.runtime?.error).toMatch(/ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1/)
    expect(res.body?.runtime?.error).toMatch(/enforce/)
  })

  it('(f) POST /api/attendance/punch is no longer mounted once activation failed closed -> exactly 404, using a FRESH user so this cannot be a business-logic rejection wearing a "not 200" disguise', async () => {
    const res = await punch(userF)
    expect(res.status).toBe(404)
  })
})
