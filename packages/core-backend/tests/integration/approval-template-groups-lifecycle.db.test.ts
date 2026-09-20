import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { query } from '../../src/db/pg'
import type { Request } from 'express'
import {
  isApprovalTemplateVisibleForGroupLink,
  resolveApprovalTemplateVisibilityActor,
} from '../../src/routes/approvals'
import { loadApprovalTemplateVisibilityActorOnQuery } from '../../src/services/approval-record-link-txn-auth'
import {
  loadApprovalTemplateReader,
  loadReadableApprovalTemplateNames,
} from '../../src/multitable/automation-approval-template-access'
import type { QueryFn } from '../../src/multitable/permission-service'
import type { ApprovalTemplateVisibilityActor } from '../../src/services/ApprovalProductService'

/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), §6 phase 1 real-DB
 * acceptance: A / A′ / A″ / A‴ / B / B′ / B″ / F / G / H / I′ (normal-pool file — E/K live in the
 * SEPARATE RR-default-pool file, `approval-template-groups-serialization.db.test.ts`, per §6's
 * "两个新 .db.test.ts" split). C and D are OUT OF SCOPE for this slice — the lock's own §6 phase
 * table assigns `section=` (C) and its `category` fallback partner (D) to phase 3, and phase 1's
 * gate list ("验收 A~B″/E 前半/F/G/H/I/I′/J/K") does not name them. J's ONLY backend-observable leg
 * — a multi-org member with no selected session-org gets 403 `SESSION_ORG_REQUIRED` on every new
 * endpoint — is the SAME code path as A‴(iii) (`AuthService.resolveSessionTenantId`'s LIMIT-2
 * single-org gate); the session-org-picker UI itself (the only NEW thing J would otherwise need)
 * is explicitly deferred to slice 2 per this slice's task brief, so J has no separate test here.
 *
 * Every mutation probe below is either (a) a real source-code edit — backed up with `cp`, applied,
 * the ONE affected test re-run to observe red, restored, and `cmp`-verified byte-identical, or (b)
 * where the lock's own text names a DDL-shape mutation (dropping the composite FK; a single-column
 * primary key) that would require altering shared migrated schema, a documented substitute: a
 * `TEMP TABLE` shape-probe (A′, session-scoped, `ON COMMIT DROP`, never touches the real table) or
 * a one-off manual verification against the PRIVATE `metasheet2_lock_a` database only, recorded in
 * the implementation PR's verification notes rather than encoded as a destructive step in this
 * checked-in suite (which also runs against CI's SHARED `metasheet_test` database).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip
const TS = Date.now()

async function canListen(): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

async function tok(
  base: string,
  userId: string,
  opts: { roles?: string; perms?: string; tenantId?: string } = {},
): Promise<string> {
  const params = new URLSearchParams({
    userId,
    roles: opts.roles ?? 'user',
    perms: opts.perms ?? '',
  })
  if (opts.tenantId) params.set('tenantId', opts.tenantId)
  const res = await fetch(`${base}/api/auth/dev-token?${params.toString()}`)
  return ((await res.json()) as { token: string }).token
}

async function httpReq(
  base: string,
  path: string,
  token: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
}

/**
 * Deterministic two-connection barrier (not a fixed sleep) — copied from
 * `approval-record-link.db.test.ts` (same name, same shape; NOT imported — that file is itself in
 * the gated CI list and must not gain a new export surface for this file's sake).
 */
async function waitUntilBackendBlockedByHolder(
  holderPid: number,
  opts: { queryFragment?: string; timeoutMs?: number } = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const deadline = Date.now() + timeoutMs
  const pool = poolManager.get()
  while (Date.now() < deadline) {
    const blocked = opts.queryFragment
      ? await pool.query(
          `SELECT pid FROM pg_stat_activity
            WHERE state = 'active'
              AND wait_event_type = 'Lock'
              AND $1 = ANY(pg_blocking_pids(pid))
              AND query ILIKE $2
            ORDER BY pid
            LIMIT 1`,
          [holderPid, `%${opts.queryFragment}%`],
        )
      : await pool.query(
          `SELECT pid FROM pg_stat_activity
            WHERE state = 'active'
              AND wait_event_type = 'Lock'
              AND $1 = ANY(pg_blocking_pids(pid))
            ORDER BY pid
            LIMIT 1`,
          [holderPid],
        )
    const pid = Number((blocked.rows[0] as { pid?: unknown } | undefined)?.pid ?? 0)
    if (pid > 0) return pid
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(
    `timed out waiting for backend blocked by holder pid ${holderPid}`
      + (opts.queryFragment ? ` on query ~${opts.queryFragment}` : '')
      + ' (never engaged the production lock — race golden would be vacuous)',
  )
}

/** Dedicated raw connection — never from the service pool (so its held lock is observable). */
async function withRawClient<T>(fn: (c: Client, pid: number) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  try {
    const pidRow = await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    return await fn(c, pidRow.rows[0].pid)
  } finally {
    try {
      await c.query('ROLLBACK')
    } catch {
      /* already closed/committed */
    }
    await c.end()
  }
}

/**
 * Raw-SQL stand-in for `archiveApprovalTemplateGroup`'s transaction, held open BEFORE COMMIT so a
 * concurrent request can be proven to block on it and then observe the POST-archive state.
 */
async function beginArchiveHold(c: Client, orgId: string, groupId: string): Promise<void> {
  await c.query('BEGIN')
  await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${orgId}`])
  await c.query(
    `SELECT id, archived_at FROM approval_template_groups WHERE org_id = $1 AND id = $2 FOR UPDATE`,
    [orgId, groupId],
  )
  await c.query(
    `UPDATE approval_template_group_links SET group_id = NULL, unlinked_at = now() WHERE group_id = $1`,
    [groupId],
  )
  await c.query(
    `UPDATE approval_template_groups SET archived_at = now(), sort_order = NULL, updated_at = now()
       WHERE org_id = $1 AND id = $2`,
    [orgId, groupId],
  )
}

/** Raw-SQL stand-in for `linkApprovalTemplateToGroup`'s transaction, held open before COMMIT. */
async function beginLinkHold(
  c: Client,
  orgId: string,
  templateId: string,
  groupId: string,
  linkedBy: string,
): Promise<void> {
  await c.query('BEGIN')
  await c.query(
    `SELECT archived_at FROM approval_template_groups WHERE org_id = $1 AND id = $2 FOR UPDATE`,
    [orgId, groupId],
  )
  await c.query(
    `INSERT INTO approval_template_group_links (org_id, template_id, group_id, linked_by, linked_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (org_id, template_id) DO UPDATE SET
       group_id = EXCLUDED.group_id, unlinked_at = NULL, linked_by = EXCLUDED.linked_by, linked_at = EXCLUDED.linked_at`,
    [orgId, templateId, groupId, linkedBy],
  )
}

describeIfDatabase('approval template groups — lifecycle (lock v2.13 phase 1, A/A′/A″/A‴/B/B′/B″/F/G/H/I′)', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  const templateIds: string[] = []
  const orgTags: string[] = []
  // §2(c) (design-gate A3 P2-5 回流修复) grants a REAL `user_roles(role_id='admin')` row to prove
  // the DB-side isAdmin guard-pass path — this file's shared `metasheet_test` DB context (see the
  // header note above) means that row must be torn down explicitly, the same as every other
  // fixture row this file writes. IMPORTANT (impl-gate-A-slice1-round4-20260918.md P3-4): this is
  // the ONLY fixture in this file that grants `role_id='admin'` (platform admin, not a scoped
  // dept/role like every other fixture's grant) — a process interruption between the INSERT above
  // and the `afterAll` DELETE below leaves a REAL platform-admin `user_roles` row behind in the
  // shared CI database, not merely a scoped-role row. A unique `TS`-suffixed userId avoids a PK
  // collision but does NOT by itself avoid indefinite accumulation across interrupted CI runs — so
  // `beforeAll` below ALSO does a prefix-scoped idempotent sweep (`vis3-dbadmin-%`) before this
  // run's own grant, on top of the normal `afterAll` teardown: an interrupted prior run's orphaned
  // admin row gets cleaned up the NEXT time this file runs, even if that next run also gets
  // interrupted before its own `afterAll` — pre-execution cleanup is what survives interruption,
  // post-execution cleanup only survives a completed run.
  const dbGrantedAdminUserIds: string[] = []

  itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`

    // Permission codes this file's fixtures grant (FK target for user_permissions.permission_code).
    for (const code of ['approvals:read', 'approval-templates:manage']) {
      await query(`INSERT INTO permissions (code, name) VALUES ($1, $1) ON CONFLICT (code) DO NOTHING`, [code])
    }

    // Pre-execution idempotent sweep (impl-gate-A-slice1-round4-20260918.md P3-4): a `TS`-suffixed
    // userId is unique to THIS run, so it never collides with a leftover row, but it also means a
    // leftover platform-admin row from an interrupted PRIOR run (different TS) would never match
    // this run's `dbGrantedAdminUserIds` array and would never be deleted by anyone. Sweep the
    // stable literal prefix (not the per-run suffix) before granting this run's own row, so an
    // orphan from an interrupted run gets reclaimed here even if THIS run also gets interrupted
    // before its own `afterAll`.
    await query(`DELETE FROM user_roles WHERE user_id LIKE 'vis3-dbadmin-%' AND role_id = 'admin'`)
  })

  afterAll(async () => {
    for (const org of orgTags.splice(0)) {
      await query(`DELETE FROM approval_template_group_links WHERE org_id = $1`, [org])
      await query(`DELETE FROM approval_template_groups WHERE org_id = $1`, [org])
    }
    for (const id of templateIds.splice(0)) {
      await query(`DELETE FROM approval_templates WHERE id = $1`, [id])
    }
    for (const userId of dbGrantedAdminUserIds.splice(0)) {
      await query(`DELETE FROM user_roles WHERE user_id = $1`, [userId])
    }
    await server?.stop()
  })

  async function createTemplate(key: string, visibilityScope?: Record<string, unknown>): Promise<string> {
    const row = await query<{ id: string }>(
      `INSERT INTO approval_templates (key, name, status, visibility_scope) VALUES ($1, $1, 'draft', $2) RETURNING id`,
      [key, JSON.stringify(visibilityScope ?? { type: 'all', ids: [] })],
    )
    const id = row.rows[0].id
    templateIds.push(id)
    return id
  }

  function trackOrg(org: string): string {
    orgTags.push(org)
    return org
  }

  // ── A ──────────────────────────────────────────────────────────────────────────────────────
  it('A: same-org active-name conflict is 409; a different org may reuse the name; an archived name may be reused', async () => {
    const orgA = trackOrg(`atg-a-a-${TS}`)
    const orgB = trackOrg(`atg-a-b-${TS}`)
    const adminA = await tok(base, `a-admin-a-${TS}`, { roles: 'admin', perms: '*:*', tenantId: orgA })
    const adminB = await tok(base, `a-admin-b-${TS}`, { roles: 'admin', perms: '*:*', tenantId: orgB })
    const name = `Group A ${TS}`

    const r1 = await httpReq(base, '/api/approval-template-groups', adminA, { method: 'POST', body: { name } })
    expect(r1.status).toBe(201)
    const g1 = (await r1.json()).group

    const r2 = await httpReq(base, '/api/approval-template-groups', adminA, { method: 'POST', body: { name } })
    expect(r2.status).toBe(409)
    expect((await r2.json()).error.code).toBe('GROUP_NAME_TAKEN')

    const r3 = await httpReq(base, '/api/approval-template-groups', adminB, { method: 'POST', body: { name } })
    expect(r3.status).toBe(201)

    const archived = await httpReq(base, `/api/approval-template-groups/${g1.id}/archive`, adminA, { method: 'POST' })
    expect(archived.status).toBe(200)

    // positive control: same org, same name, but the FIRST holder is now archived — 201.
    const r4 = await httpReq(base, '/api/approval-template-groups', adminA, { method: 'POST', body: { name } })
    expect(r4.status).toBe(201)
  })

  // ── A′ ─────────────────────────────────────────────────────────────────────────────────────
  it('A′: cross-org does not overlap — the SAME global template goes into DIFFERENT groups for DIFFERENT orgs', async () => {
    const orgA = trackOrg(`atg-ap-a-${TS}`)
    const orgB = trackOrg(`atg-ap-b-${TS}`)
    const adminA = await tok(base, `ap-admin-a-${TS}`, { roles: 'admin', perms: '*:*', tenantId: orgA })
    const adminB = await tok(base, `ap-admin-b-${TS}`, { roles: 'admin', perms: '*:*', tenantId: orgB })
    const gA = (await (await httpReq(base, '/api/approval-template-groups', adminA, { method: 'POST', body: { name: `ApA ${TS}` } })).json()).group
    const gB = (await (await httpReq(base, '/api/approval-template-groups', adminB, { method: 'POST', body: { name: `ApB ${TS}` } })).json()).group
    const tpl = await createTemplate(`atg-ap-tpl-${TS}`)

    const linkA = await httpReq(base, `/api/approval-templates/${tpl}/group`, adminA, { method: 'POST', body: { groupId: gA.id } })
    expect(linkA.status).toBe(201)
    const linkB = await httpReq(base, `/api/approval-templates/${tpl}/group`, adminB, { method: 'POST', body: { groupId: gB.id } })
    expect(linkB.status).toBe(201)

    const rows = await query<{ org_id: string; group_id: string }>(
      `SELECT org_id, group_id FROM approval_template_group_links WHERE template_id = $1 ORDER BY org_id`,
      [tpl],
    )
    expect(rows.rowCount).toBe(2)
    const byOrg = Object.fromEntries(rows.rows.map((r) => [r.org_id, r.group_id]))
    expect(byOrg[orgA]).toBe(gA.id)
    expect(byOrg[orgB]).toBe(gB.id)

    // Shape-proof mutation surrogate (see file header): the REJECTED v1 single-column-`template_id`
    // PK would let org B's link silently overwrite org A's row. Demonstrated on a session-scoped
    // TEMP TABLE mirroring that shape — never on the real, composite-PK table.
    await withRawClient(async (c) => {
      await c.query('BEGIN')
      await c.query(`CREATE TEMP TABLE atgl_shape_probe (template_id uuid PRIMARY KEY, org_id text, group_id text) ON COMMIT DROP`)
      await c.query(`INSERT INTO atgl_shape_probe (template_id, org_id, group_id) VALUES ($1, $2, $3)`, [tpl, orgA, gA.id])
      await c.query(
        `INSERT INTO atgl_shape_probe (template_id, org_id, group_id) VALUES ($1, $2, $3)
         ON CONFLICT (template_id) DO UPDATE SET org_id = EXCLUDED.org_id, group_id = EXCLUDED.group_id`,
        [tpl, orgB, gB.id],
      )
      const probe = await c.query<{ org_id: string; group_id: string }>(
        `SELECT org_id, group_id FROM atgl_shape_probe WHERE template_id = $1`,
        [tpl],
      )
      // RED signature of the rejected shape: only ONE row survives, and it is org B's — org A's
      // link is gone. The real table (asserted above) keeps BOTH.
      expect(probe.rowCount).toBe(1)
      expect(probe.rows[0].org_id).toBe(orgB)
      await c.query('ROLLBACK')
    })
  })

  // ── A″ ─────────────────────────────────────────────────────────────────────────────────────
  it('A″: cross-org link is 404 (org-scoped row-lock SELECT); the composite FK is the last-resort DB guard', async () => {
    const orgA = trackOrg(`atg-app-a-${TS}`)
    const orgB = trackOrg(`atg-app-b-${TS}`)
    const adminA = await tok(base, `app-admin-a-${TS}`, { roles: 'admin', perms: '*:*', tenantId: orgA })
    const adminB = await tok(base, `app-admin-b-${TS}`, { roles: 'admin', perms: '*:*', tenantId: orgB })
    const groupA = (await (await httpReq(base, '/api/approval-template-groups', adminA, { method: 'POST', body: { name: `AppA ${TS}` } })).json()).group
    const groupB = (await (await httpReq(base, '/api/approval-template-groups', adminB, { method: 'POST', body: { name: `AppB ${TS}` } })).json()).group

    // positive control: same-org link succeeds.
    const tplOk = await createTemplate(`atg-app-tpl-ok-${TS}`)
    const ok = await httpReq(base, `/api/approval-templates/${tplOk}/group`, adminA, { method: 'POST', body: { groupId: groupA.id } })
    expect(ok.status).toBe(201)

    // cross-org: org A's session tries to link into org B's group -> 404, zero rows written.
    const tplCross = await createTemplate(`atg-app-tpl-cross-${TS}`)
    const cross = await httpReq(base, `/api/approval-templates/${tplCross}/group`, adminA, { method: 'POST', body: { groupId: groupB.id } })
    expect(cross.status).toBe(404)
    expect((await cross.json()).error.code).toBe('GROUP_NOT_FOUND')
    const crossRow = await query(`SELECT 1 FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`, [orgA, tplCross])
    expect(crossRow.rowCount).toBe(0)

    // bypass the endpoint: a raw INSERT with a cross-org group_id must hit the composite FK (23503).
    await expect(
      query(
        `INSERT INTO approval_template_group_links (org_id, template_id, group_id, linked_by, linked_at)
         VALUES ($1, $2, $3, 'raw-bypass', now())`,
        [orgA, tplCross, groupB.id],
      ),
    ).rejects.toMatchObject({ code: '23503' })
  })

  // ── A‴ ─────────────────────────────────────────────────────────────────────────────────────
  it('A‴: org comes ONLY from req.authenticatedTenantId — body/query orgId rejected, forged header ignored, missing tenant fails closed', async () => {
    const orgReal = trackOrg(`atg-appp-real-${TS}`)
    const orgForged = trackOrg(`atg-appp-forged-${TS}`)

    // (i) body/query orgId -> 400 ORG_ID_NOT_ACCEPTED, zero rows.
    const withTenant = await tok(base, `appp-i-${TS}`, { roles: 'admin', perms: '*:*', tenantId: orgReal })
    const bodyOrgId = await httpReq(base, '/api/approval-template-groups', withTenant, {
      method: 'POST',
      body: { name: `AppppBody ${TS}`, orgId: orgForged },
    })
    expect(bodyOrgId.status).toBe(400)
    expect((await bodyOrgId.json()).error.code).toBe('ORG_ID_NOT_ACCEPTED')
    const queryOrgId = await httpReq(base, `/api/approval-template-groups?orgId=${encodeURIComponent(orgForged)}`, withTenant)
    expect(queryOrgId.status).toBe(400)
    expect((await queryOrgId.json()).error.code).toBe('ORG_ID_NOT_ACCEPTED')
    const countAfterI = await query(`SELECT count(*)::int AS n FROM approval_template_groups WHERE org_id = $1`, [orgForged])
    expect(countAfterI.rows[0].n).toBe(0)

    // (ii) valid token (has tenantId) + forged x-tenant-id header pointing at another org -> 201,
    // the WRITTEN row's org_id is the TOKEN's tenantId, the header is ignored.
    const forgedHeaderRes = await httpReq(base, '/api/approval-template-groups', withTenant, {
      method: 'POST',
      body: { name: `ApppHeader ${TS}` },
      headers: { 'x-tenant-id': orgForged },
    })
    expect(forgedHeaderRes.status).toBe(201)
    const created = (await forgedHeaderRes.json()).group
    expect(created.orgId).toBe(orgReal)
    const forgedOrgCount = await query(`SELECT count(*)::int AS n FROM approval_template_groups WHERE org_id = $1`, [orgForged])
    expect(forgedOrgCount.rows[0].n).toBe(0)

    // (iii) token with NO tenantId + an arbitrary header -> 403 SESSION_ORG_REQUIRED, zero rows.
    // (This is also J's only backend-observable leg — see file header.)
    const noTenant = await tok(base, `appp-iii-${TS}`, { roles: 'admin', perms: '*:*' })
    const noTenantRes = await httpReq(base, '/api/approval-template-groups', noTenant, {
      method: 'POST',
      body: { name: `ApppNoTenant ${TS}` },
      headers: { 'x-tenant-id': orgForged },
    })
    expect(noTenantRes.status).toBe(403)
    expect((await noTenantRes.json()).error.code).toBe('SESSION_ORG_REQUIRED')
    const noTenantCount = await query(`SELECT count(*)::int AS n FROM approval_template_groups WHERE name = $1`, [`ApppNoTenant ${TS}`])
    expect(noTenantCount.rows[0].n).toBe(0)
    // Unknown `section=` token -> 400 is untestable in this slice: no `section` query param exists
    // yet (phase 3). Noted, not silently dropped.
  })

  // ── B ──────────────────────────────────────────────────────────────────────────────────────
  it('B: archive is one transaction (members unlinked, never deleted); a concurrent link blocks then sees the archived state', async () => {
    const org = trackOrg(`atg-b-${TS}`)
    const admin = await tok(base, `b-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })
    const group = (await (await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `B Group ${TS}` } })).json()).group

    const preLinkedTpl = await createTemplate(`atg-b-tpl-pre-${TS}`)
    const preLink = await httpReq(base, `/api/approval-templates/${preLinkedTpl}/group`, admin, { method: 'POST', body: { groupId: group.id } })
    expect(preLink.status).toBe(201)

    await withRawClient(async (holder, holderPid) => {
      await beginArchiveHold(holder, org, group.id)

      const concurrentTpl = await createTemplate(`atg-b-tpl-concurrent-${TS}`)
      const linkPromise = httpReq(base, `/api/approval-templates/${concurrentTpl}/group`, admin, { method: 'POST', body: { groupId: group.id } })
      await waitUntilBackendBlockedByHolder(holderPid)

      await holder.query('COMMIT')

      const linkRes = await linkPromise
      expect(linkRes.status).toBe(409)
      expect((await linkRes.json()).error.code).toBe('GROUP_ARCHIVED')
    })

    // I2/I2′: the member is UNLINKED (row kept, group_id NULL, unlinked_at set) — not deleted.
    const preLinkRow = await query<{ group_id: string | null; unlinked_at: string | null }>(
      `SELECT group_id, unlinked_at FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
      [org, preLinkedTpl],
    )
    expect(preLinkRow.rowCount).toBe(1)
    expect(preLinkRow.rows[0].group_id).toBeNull()
    expect(preLinkRow.rows[0].unlinked_at).not.toBeNull()

    // No row anywhere points at the now-archived group.
    const dangling = await query(`SELECT count(*)::int AS n FROM approval_template_group_links WHERE group_id = $1`, [group.id])
    expect(dangling.rows[0].n).toBe(0)

    const groupRow = await query<{ archived_at: string | null; sort_order: number | null }>(
      `SELECT archived_at, sort_order FROM approval_template_groups WHERE id = $1`,
      [group.id],
    )
    expect(groupRow.rows[0].archived_at).not.toBeNull()
    expect(groupRow.rows[0].sort_order).toBeNull()
  })

  // ── B′ ─────────────────────────────────────────────────────────────────────────────────────
  // NOTE (gate P2-3, fix round 3): I2′'s consumer (the `section=` list endpoint whose display
  // logic would read this predicate) does not exist in phase 1 — it lands in A-4. There is no
  // application code path today for "unlinked shows as ungrouped" or "never-linked still shows
  // category" to exercise; that half of this test's name describes a future display behaviour,
  // not anything this file proves. What IS proven, DB-level only, is the paragraph below.
  it('B′ (DB-level predicate only, no display consumer until A-4): "no link row exists" — not "group_id IS NULL" — is the correct never-grouped predicate', async () => {
    const org = trackOrg(`atg-bp-${TS}`)
    const admin = await tok(base, `bp-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })
    const group = (await (await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `Bp Group ${TS}` } })).json()).group

    const unlinkedTpl = await createTemplate(`atg-bp-unlinked-${TS}`)
    await query(`UPDATE approval_templates SET category = 'Legacy Category' WHERE id = $1`, [unlinkedTpl])
    await httpReq(base, `/api/approval-templates/${unlinkedTpl}/group`, admin, { method: 'POST', body: { groupId: group.id } })
    await httpReq(base, `/api/approval-templates/${unlinkedTpl}/group`, admin, { method: 'DELETE' })

    // I2′ judgement predicate: NOT EXISTS a link row at all == "never grouped" == category fallback
    // eligible. A template that WAS linked and got unlinked DOES have a link row (group_id NULL) —
    // so it must NOT be treated as "never grouped".
    const everLinked = await query(
      `SELECT NOT EXISTS (
         SELECT 1 FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2
       ) AS never_grouped`,
      [org, unlinkedTpl],
    )
    expect(everLinked.rows[0].never_grouped).toBe(false)

    const neverLinkedTpl = await createTemplate(`atg-bp-never-${TS}`)
    await query(`UPDATE approval_templates SET category = 'Legacy Category' WHERE id = $1`, [neverLinkedTpl])
    const neverLinkedCheck = await query(
      `SELECT NOT EXISTS (
         SELECT 1 FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2
       ) AS never_grouped`,
      [org, neverLinkedTpl],
    )
    expect(neverLinkedCheck.rows[0].never_grouped).toBe(true)

    // ILLUSTRATIVE ONLY — zero mutation-discriminating power (gate P2-3, fix round 3): this
    // assertion is `expect(<the rejected predicate's own output>).toBe(true)`, so it is true by
    // construction and can never go red — it does not call, and cannot detect a change to, any
    // application code. Its only job is to make the REJECTED predicate's failure mode legible
    // for a human reader: "group_id IS NULL" (instead of "no link row at all") would incorrectly
    // mark the UNLINKED template (which DOES have a group_id-NULL row) as "never grouped" too,
    // collapsing the distinction the two `expect`s above this one actually prove. There is no
    // "unreject the predicate and mutate it" step here because no application code implements
    // either predicate yet (see the note above `it(...)` and §15.2/§17 #2-#3 of the verification
    // MD) — A-4 must replace this whole block with a real mutation-probed test once the `section=`
    // endpoint exists.
    const rejectedPredicate = await query(
      `SELECT group_id IS NULL AS looks_never_grouped
         FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
      [org, unlinkedTpl],
    )
    expect(rejectedPredicate.rows[0].looks_never_grouped).toBe(true) // always true — see note above; not a gate
  })

  // ── F ──────────────────────────────────────────────────────────────────────────────────────
  // Lock row F names three write actions — 建组/归档/挂接 (create / archive / link) — plus the
  // list read. Gate P3-6 (round 1): this test previously covered only create + list; the other
  // two actions shared the SAME literal guard constant (`approvalTemplateAdminGuard`) so the gate
  // treated the coverage gap as inert today, but asked for the per-action rows anyway since the
  // lock names them individually and a future slice could split the guard per action without any
  // test catching the split. Archive and link legs added below, same actor fixtures.
  it('F: authorization — write endpoints require approvalTemplateAdminGuard, the list endpoint requires approvals:read; denial writes zero rows', async () => {
    const org = trackOrg(`atg-f-${TS}`)
    const admin = await tok(base, `f-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })
    const nobody = await tok(base, `f-nobody-${TS}`, { roles: 'user', perms: 'multitable:read', tenantId: org })
    const reader = await tok(base, `f-reader-${TS}`, { roles: 'user', perms: 'approvals:read', tenantId: org })

    const createAsNobody = await httpReq(base, '/api/approval-template-groups', nobody, { method: 'POST', body: { name: `F ${TS}` } })
    expect(createAsNobody.status).toBe(403)
    const countAfterDenied = await query(`SELECT count(*)::int AS n FROM approval_template_groups WHERE org_id = $1`, [org])
    expect(countAfterDenied.rows[0].n).toBe(0)

    const listAsNobody = await httpReq(base, '/api/approval-template-groups', nobody)
    expect(listAsNobody.status).toBe(403)

    // positive controls: admin can write, a bare reader can list.
    const createAsAdmin = await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `F ${TS}` } })
    expect(createAsAdmin.status).toBe(201)
    const group = (await createAsAdmin.json()).group
    const listAsReader = await httpReq(base, '/api/approval-template-groups', reader)
    expect(listAsReader.status).toBe(200)

    // 归档 (archive) leg — same admin-created group above is the fixture; denial must not flip
    // archived_at.
    const archiveAsNobody = await httpReq(base, `/api/approval-template-groups/${group.id}/archive`, nobody, { method: 'POST' })
    expect(archiveAsNobody.status).toBe(403)
    const archivedAtAfterDenied = await query(`SELECT archived_at FROM approval_template_groups WHERE id = $1`, [group.id])
    expect(archivedAtAfterDenied.rows[0].archived_at).toBeNull()

    // 挂接 (link) leg — a fresh template, denial must write zero link rows.
    const tplForLink = await createTemplate(`atg-f-tpl-${TS}`)
    const linkAsNobody = await httpReq(base, `/api/approval-templates/${tplForLink}/group`, nobody, { method: 'POST', body: { groupId: group.id } })
    expect(linkAsNobody.status).toBe(403)
    const linkRowsAfterDenied = await query(
      `SELECT count(*)::int AS n FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
      [org, tplForLink],
    )
    expect(linkRowsAfterDenied.rows[0].n).toBe(0)
  })

  // ── request-shape codes (gate P2-4) ───────────────────────────────────────────────────────────
  it('request-shape codes: GROUP_NAME_REQUIRED (blank name) and APPROVAL_GROUP_ID_REQUIRED (missing groupId)', async () => {
    const org = trackOrg(`atg-shape-${TS}`)
    const admin = await tok(base, `shape-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

    const blankName = await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: '   ' } })
    expect(blankName.status).toBe(400)
    expect((await blankName.json()).error.code).toBe('GROUP_NAME_REQUIRED')

    const tpl = await createTemplate(`atg-shape-tpl-${TS}`)
    const missingGroupId = await httpReq(base, `/api/approval-templates/${tpl}/group`, admin, { method: 'POST', body: {} })
    expect(missingGroupId.status).toBe(400)
    expect((await missingGroupId.json()).error.code).toBe('APPROVAL_GROUP_ID_REQUIRED')
  })

  // ── Erratum 3 CANDIDATE, REDRAFT v2 (PROPOSED 2026-09-19/20, pending owner confirmation) ─────
  // Source of the predicate under test: `lock-errata-proposed-grouping-v2.13-20260919.md`, section
  // "勘误 3(重拟)", option (i) — `atg_name_nonblank` becomes
  //   CHECK (btrim(name, E' \t\r\n' || chr(12288) || chr(8203) || chr(8204) || chr(8205)
  //                        || chr(8288) || chr(65279)) <> '')
  // and BOTH `org_id` CHECKs keep the ratified `~ '[!-~]'`. NOT owner-ratified, NOT authorized:
  // a single standing question sits with the owner. Passing these tests is TECHNICAL VERIFICATION
  // of the candidate only — not ratification, not merge authorization, not permission to apply the
  // migration anywhere.
  //
  // Why this replaced the previous candidate's single test: gate round 8 raised two P2s against it.
  //   P2-1 — candidate v1 (`CHECK (btrim(name) <> '')`) was described as "non-blank, any
  //          character", but `btrim/2`'s DEFAULT trim set is the ASCII space ALONE, so a name made
  //          only of U+200B (or U+3000 / TAB / LF / U+FEFF) passed the CHECK. JS `.trim()` does not
  //          strip U+200B/200C/200D/2060 either, so the zero-width family slipped through BOTH
  //          layers and landed a 201 row invisible in every UI.
  //   P2-2 — the candidate's REJECT half had zero coverage: replacing the whole CHECK with
  //          `CHECK (true)` left 29/29 green.
  // The three `it()` blocks below close both: the app layer and the DB layer are asserted
  // SEPARATELY (same values, two paths), so neither can stand in for the other.
  //
  // Mutations actually run for this block (cp-backup / edit / rebuilt private DB / run / restore /
  // cmp — recorded in the verification MD §28, not automated here, matching this suite's existing
  // convention):
  //   M-A  migration predicate → bare `btrim(name) <> ''` (candidate v1, i.e. "run the old
  //        implementation"): the DIRECT-SQL zero-width rows go green-insert, reddening the
  //        `23514` block. The API block stays green — which is exactly why both exist.
  //   M-B  migration predicate → `CHECK (true)`: same, reddens the `23514` block (round 8's own
  //        refutation probe, re-run verbatim so P2-2 closes against the probe that opened it).
  //   M-C  `requireName` → plain `.trim()`: the API block goes red on the two zero-width rows —
  //        and it goes red on the ERROR CODE, not the status, because with plain `.trim()` those
  //        values reach the DB, raise 23514, and `mapGroupConstraintError` maps them to 400
  //        `GROUP_NAME_UNSUPPORTED`. A status-only assertion would have ZERO discriminating power
  //        here, so every row below pins `error.code`.
  const INVISIBLE_ONLY_NAMES: Array<{ label: string; value: string }> = [
    { label: 'empty string', value: '' },
    { label: 'one ASCII space', value: ' ' },
    { label: 'U+3000 IDEOGRAPHIC SPACE', value: '\u3000' },
    { label: 'two U+200B ZERO WIDTH SPACE', value: '\u200B\u200B' },
    { label: 'U+FEFF BYTE ORDER MARK', value: '\uFEFF' },
    { label: 'TAB + LF', value: '\t\n' },
  ]

  // ── Round-2 fixtures (gate round 1, impl-gate-A-slice1-name-rule-candidate-round1-20260920.md)
  //
  // P2-1: seven codepoints that are in NEITHER layer's set went through the REAL HTTP endpoint
  // with status 201 and came back out of the LIST endpoint — a group whose name renders as
  // nothing. Three of them (U+2800 `So`, U+3164 and U+115F `Lo`) carry a VISIBLE general
  // category, so a plain `/[\p{L}\p{N}\p{P}\p{S}]/u` rule does NOT reject them; that is why
  // `requireName` also excludes `\p{Default_Ignorable_Code_Point}` and U+2800.
  //
  // Every one of them is asserted TWICE below, and the two halves say DIFFERENT things:
  //   - `…NEITHER-SET…400…` — the APPLICATION layer rejects it through the production route.
  //   - `…RESIDUE…`        — the DB CHECK does NOT: a direct INSERT SUCCEEDS and the row reads
  //                          back. The candidate does not extend the owner's ten-codepoint set,
  //                          so this is a disclosed residue and the test says so in its own name
  //                          rather than pretending the value is rejected at both layers.
  const NEITHER_SET_INVISIBLES: Array<{ label: string; value: string }> = [
    { label: 'U+00AD SOFT HYPHEN', value: '\u00AD' },
    { label: 'U+180E MONGOLIAN VOWEL SEPARATOR', value: '\u180E' },
    { label: 'U+2800 BRAILLE PATTERN BLANK', value: '\u2800' },
    { label: 'U+3164 HANGUL FILLER', value: '\u3164' },
    { label: 'U+034F COMBINING GRAPHEME JOINER', value: '\u034F' },
    { label: 'U+FE0F VARIATION SELECTOR-16', value: '\uFE0F' },
    { label: 'U+115F HANGUL CHOSEONG FILLER', value: '\u115F' },
    { label: 'U+2800 x3 (repeat — a longer all-invisible name is still invisible)', value: '\u2800\u2800\u2800' },
    { label: 'U+3164 + U+00AD (mixed, both invisible)', value: '\u3164\u00AD' },
  ]

  // The migration's trim set, spelled out ONE MEMBER PER ROW. Gate round 1 P3-7: only U+200B had
  // been shown to be load-bearing (by an isolated mutation); the other nine were covered solely
  // by a loop whose assertion is a disjunction at the `it()` level. Each row below is asserted
  // ALONE (⇒ 23514) and SANDWICHED between two CJK characters (⇒ 201, stored byte-for-byte), so
  // removing any single member from the DDL reddens exactly that row's own labelled assertion.
  const DB_TRIM_SET_MEMBERS: Array<{ label: string; value: string }> = [
    { label: 'U+0020 SPACE', value: ' ' },
    { label: 'U+0009 TAB', value: '\t' },
    { label: 'U+000D CR', value: '\r' },
    { label: 'U+000A LF', value: '\n' },
    { label: 'U+3000 IDEOGRAPHIC SPACE', value: '\u3000' },
    { label: 'U+200B ZERO WIDTH SPACE', value: '\u200B' },
    { label: 'U+200C ZERO WIDTH NON-JOINER', value: '\u200C' },
    { label: 'U+200D ZERO WIDTH JOINER', value: '\u200D' },
    { label: 'U+2060 WORD JOINER', value: '\u2060' },
    { label: 'U+FEFF BYTE ORDER MARK', value: '\uFEFF' },
  ]

  /** Random CJK — pglz cannot compress it, so the btree index tuple really does grow. */
  function incompressibleName(chars: number): string {
    let out = ''
    for (let i = 0; i < chars; i += 1) out += String.fromCodePoint(0x4e00 + Math.floor(Math.random() * 0x5000))
    return out
  }

  it('Erratum 3 candidate v2 (pending owner confirmation): names with at least one visible character — CJK / Japanese / emoji / internal zero-width — create 201 and read back byte-for-byte', async () => {
    const org = trackOrg(`atg-nr-pos-${TS}`)
    const admin = await tok(base, `nr-pos-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

    // 'a' + U+200B + 'b' — an INTERNAL zero-width. The predicate only trims the EDGES, so this is
    // a legal name and is stored verbatim. Disclosed consequence (not a defect of this test): it
    // is a DIFFERENT name from 'ab' under `uq_atg_org_name_active` while rendering identically.
    const internalZeroWidth = 'a\u200Bb'
    const positives: Array<{ label: string; value: string }> = [
      { label: 'pure CJK (this product OWN placeholder text, TemplateAuthoringView.vue:221)', value: `请假` },
      { label: 'Japanese', value: `休暇申請` },
      { label: 'emoji + CJK', value: `🎉庆祝` },
      { label: 'ASCII around an internal U+200B', value: internalZeroWidth },
      { label: 'plain ASCII (positive control — the candidate widens, it never narrows)', value: `HR ${TS}` },
    ]

    for (const { label, value } of positives) {
      const res = await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: value } })
      expect(res.status, `create ${label}`).toBe(201)
      const body = (await res.json()) as { group: { id: string; name: string } }
      expect(body.group.name, `response name ${label}`).toBe(value)
      const row = await query<{ name: string }>(
        `SELECT name FROM approval_template_groups WHERE org_id = $1 AND id = $2`,
        [org, body.group.id],
      )
      expect(row.rowCount, `row count ${label}`).toBe(1)
      // Byte-for-byte, not "looks the same": an internal U+200B silently dropped somewhere in the
      // round-trip would pass a normalizing comparison and fail this one.
      expect(row.rows[0].name, `stored name ${label}`).toBe(value)
    }

    // Rename from one pure-CJK name to a DIFFERENT pure-CJK name — 200, and the NEW name is what
    // comes back and what is stored (not the old one, not a truncated/mangled one).
    const renameTarget = await query<{ id: string }>(
      `SELECT id FROM approval_template_groups WHERE org_id = $1 AND name = $2`,
      [org, `请假`],
    )
    const renameRes = await httpReq(base, `/api/approval-template-groups/${renameTarget.rows[0].id}`, admin, {
      method: 'PATCH',
      body: { name: `培训` },
    })
    expect(renameRes.status).toBe(200)
    expect(((await renameRes.json()) as { group: { name: string } }).group.name).toBe(`培训`)
    const renamedRow = await query<{ name: string }>(
      `SELECT name FROM approval_template_groups WHERE org_id = $1 AND id = $2`,
      [org, renameTarget.rows[0].id],
    )
    expect(renamedRow.rows[0].name).toBe(`培训`)

    // `requireName` MIRRORS btrim — it TRIMS, it does not reject. This is the case that tells the
    // two designs apart: a reject-shaped mirror would 400 here.
    const paddedRes = await httpReq(base, '/api/approval-template-groups', admin, {
      method: 'POST',
      body: { name: `\u200B\u3000HR-padded-${TS}\uFEFF\u2060` },
    })
    expect(paddedRes.status).toBe(201)
    const paddedBody = (await paddedRes.json()) as { group: { id: string; name: string } }
    expect(paddedBody.group.name).toBe(`HR-padded-${TS}`)
    const paddedRow = await query<{ name: string }>(
      `SELECT name FROM approval_template_groups WHERE org_id = $1 AND id = $2`,
      [org, paddedBody.group.id],
    )
    expect(paddedRow.rows[0].name).toBe(`HR-padded-${TS}`)
  })

  it('Erratum 3 candidate v2: each of the ENUMERATED blank/invisible names (INVISIBLE_ONLY_NAMES) is 400 GROUP_NAME_REQUIRED through the production route, and writes zero rows', async () => {
    const org = trackOrg(`atg-nr-api-${TS}`)
    const admin = await tok(base, `nr-api-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

    for (const { label, value } of INVISIBLE_ONLY_NAMES) {
      const res = await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: value } })
      expect(res.status, `status for ${label}`).toBe(400)
      const body = (await res.json()) as { error: { code: string } }
      // `error.code` — NOT the status — is the load-bearing assertion (mutation M-C above): with a
      // plain `.trim()` mirror the two zero-width rows are ALSO 400, but 400
      // `GROUP_NAME_UNSUPPORTED` from the DB's 23514, which is precisely the app-layer hole this
      // candidate's mirror closes.
      expect(body.error.code, `error code for ${label}`).toBe('GROUP_NAME_REQUIRED')
    }

    const written = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM approval_template_groups WHERE org_id = $1`,
      [org],
    )
    expect(written.rows[0].n).toBe(0)

    // The RENAME path calls the same `requireName`, so its behaviour is identical by construction
    // — asserted anyway rather than argued, on one representative zero-width value, because "same
    // helper" is a source-text claim and this is the endpoint a user actually reaches second.
    const live = await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `Rename Probe ${TS}` } })
    expect(live.status).toBe(201)
    const liveId = ((await live.json()) as { group: { id: string } }).group.id
    const renameBlank = await httpReq(base, `/api/approval-template-groups/${liveId}`, admin, {
      method: 'PATCH',
      body: { name: '\u200B\u200B' },
    })
    expect(renameBlank.status).toBe(400)
    expect(((await renameBlank.json()) as { error: { code: string } }).error.code).toBe('GROUP_NAME_REQUIRED')
    const unchanged = await query<{ name: string }>(
      `SELECT name FROM approval_template_groups WHERE org_id = $1 AND id = $2`,
      [org, liveId],
    )
    expect(unchanged.rows[0].name).toBe(`Rename Probe ${TS}`)
  })

  it('Erratum 3 candidate v2: the DB CHECK itself rejects each member of its OWN ten-codepoint trim set — direct INSERT raises 23514 atg_name_nonblank, not merely an app-layer 400 (bounded to that set; see the RESIDUE case below)', async () => {
    const org = trackOrg(`atg-nr-ddl-${TS}`)

    // Bypasses the route and `requireName` entirely — this is the ONLY thing that can show the
    // CHECK is load-bearing rather than decorative (gate round 8 P2-2: with `CHECK (true)` the
    // whole suite stayed green because no assertion ever touched the reject half).
    for (const { label, value } of INVISIBLE_ONLY_NAMES) {
      await expect(
        query(
          `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by)
           VALUES ($1, $2, $3, 1, 'probe')`,
          [`atg_nr_${label.replace(/[^a-z0-9]+/gi, '_')}_${TS}`, org, value],
        ),
        `direct insert of ${label}`,
      ).rejects.toMatchObject({ code: '23514', constraint: 'atg_name_nonblank' })
    }

    // Positive control on the SAME statement shape: a pure-CJK name goes in. Without this, an
    // insert failing for an unrelated reason (wrong column list, NOT NULL, the paired sort CHECK)
    // would read as a passing test — "not this error" is not an outcome assertion.
    await expect(
      query(
        `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by)
         VALUES ($1, $2, $3, 1, 'probe')`,
        [`atg_nr_ok_${TS}`, org, `报销`],
      ),
    ).resolves.toBeDefined()

    // DISCLOSED GAP, asserted as behaviour so it cannot rot into stale prose: the trim set is the
    // owner's proposal verbatim, and U+00A0 NBSP is NOT in it. A direct insert of an NBSP-only
    // name therefore SUCCEEDS at the DB layer — the CHECK alone is not a complete "non-blank"
    // guarantee. Production is still safe because `requireName` strips a superset (JS \s contains
    // U+00A0), which the second half of this assertion pair measures rather than assumes.
    await expect(
      query(
        `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by)
         VALUES ($1, $2, $3, 2, 'probe')`,
        [`atg_nr_nbsp_${TS}`, org, '\u00A0'],
      ),
    ).resolves.toBeDefined()
    const nbspAdmin = await tok(base, `nr-nbsp-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: `${org}-route` })
    trackOrg(`${org}-route`)
    const nbspRes = await httpReq(base, '/api/approval-template-groups', nbspAdmin, {
      method: 'POST',
      body: { name: '\u00A0' },
    })
    expect(nbspRes.status).toBe(400)
    expect(((await nbspRes.json()) as { error: { code: string } }).error.code).toBe('GROUP_NAME_REQUIRED')
  })

  it('Erratum 3 candidate v2 ROUND-2 FIX (gate round 1 P2-1): each NEITHER-SET invisible codepoint is 400 GROUP_NAME_REQUIRED through the production route, and the LIST endpoint stays empty', async () => {
    const org = trackOrg(`atg-nr-nset-${TS}`)
    const admin = await tok(base, `nr-nset-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

    // Collected into an ARRAY and compared in ONE assertion on purpose. A per-iteration
    // `expect` aborts the loop at the first failure and names only that value, so a mutation
    // that changes SEVERAL of these rows would be reported as if it changed one. The array form
    // prints the whole matrix in the diff, which is what makes "which codepoints regressed" a
    // readable fact rather than an inference.
    const observed: string[] = []
    for (const { label, value } of NEITHER_SET_INVISIBLES) {
      const res = await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: value } })
      const body = (await res.json()) as { error?: { code?: string } }
      // The CODE, not just the status: with the pre-round-2 mirror these values were 201, and with
      // a `/[\p{L}\p{N}\p{P}\p{S}]/u`-only rule three of them (U+2800 `So`, U+3164 / U+115F
      // `Lo`) would STILL be 201 — which is why this fixture exists as its own list.
      observed.push(`${label} -> ${res.status} ${body.error?.code ?? 'CREATED'}`)
    }
    expect(observed).toEqual(NEITHER_SET_INVISIBLES.map(({ label }) => `${label} -> 400 GROUP_NAME_REQUIRED`))

    // The gate's judgement had TWO halves — POST 201 *and* the LIST endpoint handing the
    // invisible row back to the admin console. Assert the second half too, not only the first.
    const list = await httpReq(base, '/api/approval-template-groups', admin)
    expect(list.status).toBe(200)
    expect(((await list.json()) as { groups: unknown[] }).groups, 'no invisible-named group may be listed').toHaveLength(0)
    const written = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM approval_template_groups WHERE org_id = $1`,
      [org],
    )
    expect(written.rows[0].n, 'zero rows written').toBe(0)

    // Positive control on the SAME org and token: the endpoint is reachable and does create, so
    // the 400s above are not "the request never got there".
    const ok = await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `报销 ${TS}` } })
    expect(ok.status, 'positive control must create').toBe(201)
    const okId = ((await ok.json()) as { group: { id: string } }).group.id
    const listAfter = await httpReq(base, '/api/approval-template-groups', admin)
    expect(((await listAfter.json()) as { groups: unknown[] }).groups, 'positive control must be listed').toHaveLength(1)

    // RENAME leg on one representative value — "the two paths share `requireName`" is a
    // source-text claim; this turns it into a behaviour.
    const renamed = await httpReq(base, `/api/approval-template-groups/${okId}`, admin, {
      method: 'PATCH',
      body: { name: '\u3164' },
    })
    expect(renamed.status, 'rename to U+3164 HANGUL FILLER').toBe(400)
    expect(((await renamed.json()) as { error: { code: string } }).error.code).toBe('GROUP_NAME_REQUIRED')
    const unchanged = await query<{ name: string }>(
      `SELECT name FROM approval_template_groups WHERE org_id = $1 AND id = $2`,
      [org, okId],
    )
    expect(unchanged.rows[0].name).toBe(`报销 ${TS}`)
  })

  it('Erratum 3 candidate v2 RESIDUE, asserted as a residue and not as a rejection: the DB CHECK does NOT reject the NEITHER-SET codepoints — a direct INSERT of each one SUCCEEDS and the row reads back byte-for-byte', async () => {
    const org = trackOrg(`atg-nr-residue-${TS}`)

    // This case exists so the disclosure in the migration comment is a MACHINE-CHECKABLE fact
    // rather than prose that can rot. The candidate does NOT extend the owner's ten-codepoint
    // trim set (that set is the proposal verbatim), so a direct SQL writer — anything bypassing
    // the route — can still land these rows. What closes them for production is the APPLICATION
    // layer, asserted in the case directly above. If a future round DOES extend the DB set, this
    // case is the one that must be rewritten, deliberately, rather than quietly staying green.
    let sortOrder = 1
    for (const { label, value } of NEITHER_SET_INVISIBLES) {
      const id = `atg_nr_res_${sortOrder}_${TS}`
      await expect(
        query(
          `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by)
           VALUES ($1, $2, $3, $4, 'probe')`,
          [id, org, value, sortOrder],
        ),
        `RESIDUE: direct insert of ${label} SUCCEEDS at the DB layer (not extended by this candidate)`,
      ).resolves.toBeDefined()
      const row = await query<{ name: string }>(
        `SELECT name FROM approval_template_groups WHERE org_id = $1 AND id = $2`,
        [org, id],
      )
      expect(row.rows[0].name, `RESIDUE: stored name for ${label}`).toBe(value)
      sortOrder += 1
    }

    // Negative control on the IDENTICAL statement shape: a member that IS in the ten-codepoint
    // set is still rejected, so the successes above are not "the CHECK has gone missing".
    await expect(
      query(
        `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by)
         VALUES ($1, $2, $3, $4, 'probe')`,
        [`atg_nr_res_ctl_${TS}`, org, '\u200B', 900],
      ),
      'negative control: U+200B is in the DB set and must still be rejected',
    ).rejects.toMatchObject({ code: '23514', constraint: 'atg_name_nonblank' })
  })

  it('Erratum 3 candidate v2 (gate round 1 P3-7): EACH of the ten trim-set members is load-bearing IN ISOLATION — alone it is 23514, sandwiched between two CJK characters it is 201 and stored byte-for-byte', async () => {
    const org = trackOrg(`atg-nr-member-${TS}`)
    const admin = await tok(base, `nr-member-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

    // Round 1 closed only U+200B by an isolated mutation (its M-D); the other nine members were
    // covered by a loop whose `it()`-level verdict is a DISJUNCTION — one rejecting value keeps
    // the whole case green. Here every member carries its OWN labelled assertion in BOTH
    // directions, so deleting any single `chr(...)` from the DDL reddens exactly one named row.
    // Both halves are COLLECTED and compared as arrays, for the same reason as the NEITHER-SET
    // case above: a per-iteration `expect` stops at the first bad row, and "which members stopped
    // being load-bearing" is exactly the question this case exists to answer.
    const aloneObserved: string[] = []
    const sandwichObserved: string[] = []
    let sortOrder = 1
    for (const { label, value } of DB_TRIM_SET_MEMBERS) {
      try {
        await query(
          `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by)
           VALUES ($1, $2, $3, $4, 'probe')`,
          [`atg_nr_mem_${sortOrder}_${TS}`, org, value, sortOrder],
        )
        aloneObserved.push(`${label} -> ACCEPTED`)
      } catch (error) {
        const pgErr = error as { code?: string; constraint?: string }
        aloneObserved.push(`${label} -> ${pgErr.code} ${pgErr.constraint}`)
      }

      // Same member, same org, this time INTERNAL. btrim only touches the edges, so it must be
      // accepted AND stored verbatim — the pair (alone ⇒ reject, internal ⇒ keep) is what
      // separates "this member is in the trim set" from "this member is banned outright".
      const sandwiched = `中${value}文${sortOrder}`
      const res = await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: sandwiched } })
      const created = (await res.json()) as { group?: { id: string; name: string }; error?: { code?: string } }
      if (res.status !== 201 || !created.group) {
        sandwichObserved.push(`${label} -> ${res.status} ${created.error?.code ?? 'NO-GROUP'}`)
      } else {
        const row = await query<{ name: string }>(
          `SELECT name FROM approval_template_groups WHERE org_id = $1 AND id = $2`,
          [org, created.group.id],
        )
        const verbatim = created.group.name === sandwiched && row.rows[0]?.name === sandwiched
        sandwichObserved.push(`${label} -> 201 ${verbatim ? 'STORED-VERBATIM' : 'MANGLED'}`)
      }
      sortOrder += 1
    }

    expect(aloneObserved, 'each member ALONE must violate atg_name_nonblank').toEqual(
      DB_TRIM_SET_MEMBERS.map(({ label }) => `${label} -> 23514 atg_name_nonblank`),
    )
    expect(sandwichObserved, 'each member BETWEEN two CJK characters must create and be stored verbatim').toEqual(
      DB_TRIM_SET_MEMBERS.map(({ label }) => `${label} -> 201 STORED-VERBATIM`),
    )
  })

  it('Erratum 3 candidate v2 (gate round 1 P3-1): an over-long name is a typed 400 GROUP_NAME_TOO_LONG at the application layer, never the opaque 500 that a btree 54000 used to produce', async () => {
    const org = trackOrg(`atg-nr-len-${TS}`)
    const admin = await tok(base, `nr-len-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

    // 255 code points — the cap itself. Boundary ON the limit must still create.
    const atCap = `L${TS}`.padEnd(255, '龍').slice(0, 255)
    expect([...atCap].length).toBe(255)
    const atCapRes = await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: atCap } })
    expect(atCapRes.status, '255 code points is AT the cap and must create').toBe(201)
    const atCapId = ((await atCapRes.json()) as { group: { id: string } }).group.id
    const atCapRow = await query<{ n: number }>(
      `SELECT char_length(name)::int AS n FROM approval_template_groups WHERE org_id = $1 AND id = $2`,
      [org, atCapId],
    )
    // PostgreSQL counts char_length in code points too — the JS-side cap and the stored length
    // are the same number, not merely "about the same".
    expect(atCapRow.rows[0].n, 'stored char_length').toBe(255)

    // 256 — one past the cap.
    const overCap = `${atCap}龍`
    expect([...overCap].length).toBe(256)
    const overRes = await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: overCap } })
    expect(overRes.status, '256 code points is OVER the cap').toBe(400)
    const overBody = (await overRes.json()) as { error: { code: string; details?: { maxLength?: number; actualLength?: number } } }
    expect(overBody.error.code).toBe('GROUP_NAME_TOO_LONG')
    expect(overBody.error.details?.maxLength).toBe(255)
    expect(overBody.error.details?.actualLength).toBe(256)

    // The value round 1 measured as an opaque 500: an incompressible name long enough to blow the
    // btree index-tuple limit. It must now be the SAME typed 400 — the assertion is 400
    // GROUP_NAME_TOO_LONG, not "not a 500", because "not this error" is not an outcome assertion.
    const huge = incompressibleName(2000)
    const hugeRes = await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: huge } })
    expect(hugeRes.status, 'btree-overflowing name must be a typed 400, not an opaque 500').toBe(400)
    expect(((await hugeRes.json()) as { error: { code: string } }).error.code).toBe('GROUP_NAME_TOO_LONG')

    // RENAME shares `requireName`, asserted rather than argued.
    const renameRes = await httpReq(base, `/api/approval-template-groups/${atCapId}`, admin, {
      method: 'PATCH',
      body: { name: overCap },
    })
    expect(renameRes.status).toBe(400)
    expect(((await renameRes.json()) as { error: { code: string } }).error.code).toBe('GROUP_NAME_TOO_LONG')

    // The cap is measured AFTER trimming — padding does not eat into it.
    const padded = `\u200B\u3000${atCap}\uFEFF\u2060`
    const paddedRes = await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: padded } })
    // Same trimmed value as `atCap`, which already exists in this org ⇒ 409, NOT 400: the length
    // check saw 255, not 259. A 400 GROUP_NAME_TOO_LONG here would mean the cap runs before trim.
    expect(paddedRes.status, 'cap is applied to the TRIMMED name').toBe(409)
    expect(((await paddedRes.json()) as { error: { code: string } }).error.code).toBe('GROUP_NAME_TAKEN')

    // RESIDUE, disclosed: the btree limit itself has not moved. A DIRECT SQL writer can still
    // reach 54000 — the application cap is what keeps the route away from it, and `org_id` (the
    // other index column) is `req.authenticatedTenantId`, never caller-supplied.
    await expect(
      query(
        `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by)
         VALUES ($1, $2, $3, 5000, 'probe')`,
        [`atg_nr_len_res_${TS}`, org, incompressibleName(2000)],
      ),
      'RESIDUE: direct insert of a btree-overflowing name still raises 54000',
    ).rejects.toMatchObject({ code: '54000' })
  })

  it('Erratum 3 candidate v2 leaves both org_id CHECKs exactly as ratified: atg_org_nonblank and atgl_org_nonblank still reject a pure-CJK org_id and still accept an ASCII one', async () => {
    const org = trackOrg(`atg-nr-org-${TS}`)
    const cjkOrg = `组织`
    const tpl = await createTemplate(`atg-nr-org-tpl-${TS}`)

    // atg_org_nonblank — negative, then the positive control on the identical statement shape.
    await expect(
      query(
        `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by)
         VALUES ($1, $2, $3, 1, 'probe')`,
        [`atg_nr_orgneg_${TS}`, cjkOrg, `Org Check ${TS}`],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'atg_org_nonblank' })
    const groupRow = await query<{ id: string }>(
      `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by)
       VALUES ($1, $2, $3, 1, 'probe') RETURNING id`,
      [`atg_nr_orgpos_${TS}`, org, `Org Check ${TS}`],
    )
    expect(groupRow.rowCount).toBe(1)

    // atgl_org_nonblank — the link row is written with group_id NULL / unlinked_at set so the
    // composite FK (MATCH SIMPLE) does not participate and the org_id CHECK is unambiguously the
    // constraint under test.
    await expect(
      query(
        `INSERT INTO approval_template_group_links (org_id, template_id, group_id, linked_by, linked_at, unlinked_at)
         VALUES ($1, $2, NULL, 'probe', now(), now())`,
        [cjkOrg, tpl],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'atgl_org_nonblank' })
    await expect(
      query(
        `INSERT INTO approval_template_group_links (org_id, template_id, group_id, linked_by, linked_at, unlinked_at)
         VALUES ($1, $2, NULL, 'probe', now(), now())`,
        [org, tpl],
      ),
    ).resolves.toBeDefined()

    // And the constraint TEXT for both is still the ratified regex — the candidate touches one
    // predicate, and this reads the live catalog rather than trusting the migration source.
    const defs = await query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname IN ('atg_org_nonblank', 'atgl_org_nonblank')`,
    )
    // Sorted in JS (UTF-16 code-unit order), NOT by SQL `ORDER BY conname`: a text ORDER BY is
    // COLLATION-dependent and these two names differ at an underscore. Under macOS Homebrew's
    // en_US.UTF-8 (effectively byte order) '_' (0x5F) < 'l', so atg_ sorts first; under glibc's
    // en_US.utf8 (ISO 14651 demotes punctuation below the primary level) the keys compare as
    // "atgorgnonblank" vs "atglorgnonblank", 'l' < 'o', and the rows come back the OTHER way
    // round. CI runs ankane/setup-postgres (glibc, PG 14) while this was authored on Homebrew PG
    // 15, so an ORDER BY here would have been a green-locally / red-in-CI assertion — the exact
    // blind spot finding_prod_pg15_never_tested names.
    expect(defs.rows.map((r) => r.conname).sort()).toEqual(['atg_org_nonblank', 'atgl_org_nonblank'])
    for (const row of defs.rows) {
      expect(row.def, `${row.conname} predicate`).toContain(`~ '[!-~]'`)
      expect(row.def, `${row.conname} must not have picked up the name rule`).not.toContain('btrim')
    }
  })

  // ── §2 link-time visibility (ratified, gate P2-1; CORRECTED design-gate A3 §2 Q2/P2-5, 2026-09-18) ─
  // Leg (a) calls the exported predicate directly with a hand-built NON-manager actor (real
  // judgement: mutating `isApprovalTemplateVisibleForGroupLink` to drop the
  // `applyTemplateVisibilityFilter` call turns the "hidden" assertion red). Leg (b) goes through the
  // real HTTP endpoint to prove the call SITE is wired (mutating the route handler to remove the call
  // turns this red too — a nonexistent template's INSERT falls through to a raw 23503, which
  // `mapGroupConstraintError` does not map, landing on the generic 500 fallback instead of 404).
  //
  // This block used to justify leg (a)'s existence with "`approvalTemplateAdminGuard`'s permission
  // codes are a SUBSET of `isTemplateManager`'s derivation... every actor able to reach the link
  // ENDPOINT today is a manager" — that claim is FALSE, and this round's first fix (see the block
  // comment above `isApprovalTemplateVisibleForGroupLink` in `routes/approvals.ts`, CORRECTED AGAIN
  // impl-gate-A-slice1-round4-20260918.md §2 P2-1) replaced it with a SECOND false claim: that a
  // wildcard `approval-templates:*` permission code, by itself, passes the guard. It does not —
  // `rbacGuardAny`'s permission leg is a conjunction (`requestUserHasResolvedPermission(...) &&
  // isPermissionAllowedByNamespaceAdmission(...)`, `rbac/rbac.ts:134-142`), `approval-templates` is
  // an admission-controlled resource, and absent an extra namespace-admission grant both
  // `approval-templates:*` and the guard's own literal `approval-templates:manage` get 403 —
  // real-DB falsified twice now (round 2's gate, and this round's gate re-testing this very
  // comment). The ONLY actor shape actually demonstrated end-to-end this round is a DB-side-only
  // `isAdmin(userId)` grant, which does pass the guard without `isTemplateManager` recognizing it.
  // Leg (a) therefore does NOT rest on "no real actor could ever be both guard-passing and
  // non-manager" — it rests on leg (c) below ("§2(c): a DB-side-admin actor") being a REAL,
  // guard-passing, non-manager HTTP case that proves the same filtering leg (a) exercises directly.
  // Leg (a) remains useful on its own merits (it can probe the predicate with actor shapes — e.g. a
  // non-existent template id — that are awkward to reach purely through HTTP), it is just no longer
  // the ONLY thing standing between "the guard admits only managers" and reality. None of this
  // changes any runtime behavior — only what these comments claim about existing behavior.
  it('§2(a): the exported visibility predicate — visible to a non-manager in its own scope, hidden outside it, and false for a nonexistent id', async () => {
    const deptId = `vis-dept-${TS}`
    const visibleTpl = await createTemplate(`atg-vis-visible-${TS}`, { type: 'dept', ids: [deptId] })
    const hiddenTpl = await createTemplate(`atg-vis-hidden-${TS}`, { type: 'dept', ids: [`${deptId}-other`] })
    const nonManagerActor: ApprovalTemplateVisibilityActor = {
      userId: `vis-user-${TS}`,
      departmentIds: [deptId],
      roles: [],
      permissions: [],
      isTemplateManager: false,
    }
    expect(await isApprovalTemplateVisibleForGroupLink(visibleTpl, nonManagerActor)).toBe(true)
    expect(await isApprovalTemplateVisibleForGroupLink(hiddenTpl, nonManagerActor)).toBe(false)
    expect(await isApprovalTemplateVisibleForGroupLink(randomUUID(), nonManagerActor)).toBe(false)

    // Manager short-circuit (documents WHY leg (b) below can only probe existence, not scope):
    // `applyTemplateVisibilityFilter` adds no conditions for a manager, so the otherwise-hidden
    // template becomes visible — this IS the guard-population fact the block comment names.
    const managerActor: ApprovalTemplateVisibilityActor = { ...nonManagerActor, isTemplateManager: true }
    expect(await isApprovalTemplateVisibleForGroupLink(hiddenTpl, managerActor)).toBe(true)
  })

  it('§2(b): the link endpoint 404s APPROVAL_TEMPLATE_NOT_FOUND (zero rows written) for a template id that does not exist', async () => {
    const org = trackOrg(`atg-vis2-${TS}`)
    const admin = await tok(base, `vis2-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })
    const group = (await (await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `Vis2 ${TS}` } })).json()).group
    const missingId = randomUUID()

    const res = await httpReq(base, `/api/approval-templates/${missingId}/group`, admin, { method: 'POST', body: { groupId: group.id } })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')
    const row = await query(
      `SELECT 1 FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
      [org, missingId],
    )
    expect(row.rowCount).toBe(0)
  })

  // ── §2(c): guard-passing NON-manager, real HTTP + real DB (design-gate A3 §2 Q2/P2-5 回流修复) ──
  // Corrects the block comment above `isApprovalTemplateVisibleForGroupLink`: it used to assert
  // "guard population ⊆ manager population", which is false. This actor is constructed to be a
  // COUNTEREXAMPLE to that retracted claim: it reaches `approvalTemplateAdminGuard` ONLY through
  // `rbacGuardAny`'s DB-side `isAdmin(userId)` fallback (`rbac/service.ts`: a `user_roles` row with
  // `role_id = 'admin'`) — its dev-token carries `roles=user, perms=` (no admin/manager claim at
  // all), so `resolveApprovalTemplateVisibilityActor` (which reads ONLY `req.user`, never the DB)
  // computes `isTemplateManager: false` for it. If the retracted comment's claim had been true,
  // no such actor could exist. Positive control (the dept-scoped template) proves the guard
  // genuinely let this actor through (a failed guard would 403 on EVERY sub-case, including this
  // one) rather than the endpoint being unreachable for some other reason.
  it('§2(c): a DB-side-admin actor (guard passes; NOT isTemplateManager) still has its LINK request visibility-filtered', async () => {
    const org = trackOrg(`atg-vis3-${TS}`)
    const dbAdminUserId = `vis3-dbadmin-${TS}`
    // No `roles`/`perms` claim of any kind — the ONLY thing that will let this actor through
    // `approvalTemplateAdminGuard` is the `user_roles` row inserted below.
    const dbAdmin = await tok(base, dbAdminUserId, { roles: 'user', perms: '', tenantId: org })
    await query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [dbAdminUserId])
    dbGrantedAdminUserIds.push(dbAdminUserId) // torn down in afterAll — see the array's doc comment

    // Guard-pass proof #1: this actor can perform approvalTemplateAdminGuard-gated WRITES
    // (create) despite carrying zero admin/manager claim on the token itself.
    const groupRes = await httpReq(base, '/api/approval-template-groups', dbAdmin, { method: 'POST', body: { name: `Vis3 ${TS}` } })
    expect(groupRes.status).toBe(201)
    const group = (await groupRes.json()).group

    const otherDept = `vis3-dept-other-${TS}`
    const hiddenTpl = await createTemplate(`atg-vis3-hidden-${TS}`, { type: 'dept', ids: [otherDept] })
    const visibleTpl = await createTemplate(`atg-vis3-visible-${TS}`) // default visibility_scope: {type:'all', ids:[]}

    // Guard-pass proof #2 + the actual finding: NOT a 403 (guard genuinely passed) but a 404 — the
    // link REQUEST is still narrowed by `applyTemplateVisibilityFilter` exactly as it would be for
    // any other non-manager actor, because guard admission and `isTemplateManager` are two
    // independent judgements, not a subset relation.
    const hiddenRes = await httpReq(base, `/api/approval-templates/${hiddenTpl}/group`, dbAdmin, { method: 'POST', body: { groupId: group.id } })
    expect(hiddenRes.status).toBe(404)
    expect((await hiddenRes.json()).error.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')
    const hiddenRow = await query(`SELECT 1 FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`, [org, hiddenTpl])
    expect(hiddenRow.rowCount).toBe(0)

    // Positive control: the SAME actor, SAME guard, an `'all'`-scoped template — 201. Mutation
    // (recorded in the verification MD, cp-backup/edit/run/restore/cmp, not automated here):
    // hard-coding `isTemplateManager: true` inside `resolveApprovalTemplateVisibilityActor` turns
    // the hidden-template assertion above red (200/201 instead of 404) while leaving this one
    // green — it is the hidden-template leg, not this one, that carries this test's discriminating
    // power.
    const visibleRes = await httpReq(base, `/api/approval-templates/${visibleTpl}/group`, dbAdmin, { method: 'POST', body: { groupId: group.id } })
    expect(visibleRes.status).toBe(201)
  })

  // ── §2(d): the OTHER non-containment direction — manager, guard-fail (impl-gate-A-slice1-round6-
  // 20260918.md §2 P2-1) ──
  // §2(c) above witnesses one direction: an actor `approvalTemplateAdminGuard` ADMITS (DB-side
  // `isAdmin`) that `isTemplateManager` does NOT recognize. This case witnesses the OTHER
  // direction: a permission claim `isTemplateManager` DOES recognize, that the guard does NOT
  // admit — so the two populations are mutually non-inclusive, neither one a subset of the other.
  // Both arms below use the IDENTICAL claim shape (`MGR_PERMS`), not two hand-written shapes that
  // merely look alike, so they are provably about the same principal.
  it('§2(d): a permission code that satisfies isTemplateManager does not, by itself, satisfy approvalTemplateAdminGuard — pins the direction §2(c) does not cover', async () => {
    const org = trackOrg(`atg-vis4-${TS}`)
    const mgrUserId = `vis4-mgr-${TS}`
    const MGR_PERMS = ['approvals:read', 'approval-templates:manage']

    // Arm A (HTTP, real DB): a token carrying ONLY these permission claims — no `roles=admin`, no
    // `user_roles` DB grant, no namespace-admission grant. `approval-templates:manage` is the
    // guard's OWN literal permission code, yet this principal is refused.
    const mgrToken = await tok(base, mgrUserId, { roles: 'user', perms: MGR_PERMS.join(','), tenantId: org })
    const groupRes = await httpReq(base, '/api/approval-template-groups', mgrToken, { method: 'POST', body: { name: `Vis4 ${TS}` } })
    expect(groupRes.status).toBe(403)
    // Discriminates "the guard itself denied this" from "the guard passed and something else
    // downstream returned 403" (e.g. `SESSION_ORG_REQUIRED`, shaped `{ok:false,error:{code,...}}`)
    // — `rbacGuardAny`'s own denial body is the bare string `{ error: 'Insufficient permissions' }`
    // (`rbac/rbac.ts`), with no `code` field.
    expect((await groupRes.json()).error).toBe('Insufficient permissions')

    // Arm B (direct call to the exported resolver, the IDENTICAL claim shape as Arm A):
    // `isTemplateManager` is true for this permission set — one of its derivation legs is exactly
    // `permissions.includes('approval-templates:manage')`, with no admission requirement on this
    // leg at all.
    const mgrReq = {
      user: { id: mgrUserId, role: 'user', roles: ['user'], permissions: MGR_PERMS },
    } as unknown as Request
    const mgrActor = resolveApprovalTemplateVisibilityActor(mgrReq)
    expect(mgrActor?.isTemplateManager).toBe(true)

    // Negative control: drop the ONE permission code that satisfies a derivation leg — isolates
    // WHICH claim does the work, rather than resting on "no plain user is ever a manager".
    const plainReq = {
      user: { id: `${mgrUserId}-plain`, role: 'user', roles: ['user'], permissions: ['approvals:read'] },
    } as unknown as Request
    const plainActor = resolveApprovalTemplateVisibilityActor(plainReq)
    expect(plainActor?.isTemplateManager).toBe(false)
  })

  // ── G ──────────────────────────────────────────────────────────────────────────────────────
  // FINDING (verified by actual mutation probe on `src/services/ApprovalTemplateGroupService.ts`
  // unarchiveApprovalTemplateGroup, cp-backup → edit → run this file → cp-restore → cmp — not
  // just read from the source comment): unarchive's name-conflict path is defense-in-depth, TWO
  // independent layers, and this black-box endpoint test cannot discriminate which layer is
  // load-bearing because either one alone reproduces the same 409 GROUP_NAME_TAKEN:
  //   (1) an explicit pre-check SELECT before the UPDATE, throwing a typed ServiceError directly
  //       (this is the check the lock's G row names as "去掉同名复核" — removing ONLY this,
  //       confirmed by probe, does NOT turn the test red: the ensuing UPDATE hits the raw
  //       `uq_atg_org_name_active` 23505, which `mapGroupConstraintError` remaps to the SAME 409
  //       — matching the source's own comment at unarchiveApprovalTemplateGroup's docblock);
  //   (2) `mapGroupConstraintError`'s `uq_atg_org_name_active` branch (shared with A's own
  //       mutation proof) — removing ONLY this branch, confirmed by probe just now, ALSO does
  //       NOT turn G red, because layer (1)'s pre-check throws a `ServiceError` that short-
  //       circuits `mapGroupConstraintError` entirely (`if (error instanceof ServiceError) return
  //       error` is the first line) before the UPDATE — and hence before the removed branch —
  //       is ever reached. A's own create path has no such pre-check, so A DOES red on this one.
  // Net: this it() block is a correct ACCEPTANCE test for the "same-name blocks unarchive"
  // behaviour (§2/G), but it has ZERO discriminating power for EITHER of the two named
  // candidate mutations individually — a true single-line mutation gate for G would require
  // removing BOTH layers at once, which neither this test nor the taskbook's per-row mutation
  // column contemplates. CORRECTED (fix round 2, gate `impl-gate-A-slice1-round1-20260918.md`
  // P2-2): this is NOT a lock-vs-implementation contract gap — the lock's G row only requires
  // the observable behaviour ("same-name blocks unarchive"), it does not require two independent
  // layers, and does not need a new mutation invented to discriminate it; layer (1) (the
  // pre-check in unarchiveApprovalTemplateGroup) is this implementation's own addition on top of
  // layer (2) (the shared mapGroupConstraintError branch A already depends on), so removing
  // layer (1) alone would restore single-mutation discriminating power without touching anything
  // the lock text names. That removal is an implementation choice, not made in this fix round —
  // see verification MD §15.1/§17 item 10 for the reasoning kept for keeping both layers and the
  // ask for owner to accept or reject it.
  it('G: unarchive — clean case; blocked by another ACTIVE group with the same name; blocked by a group renamed into that name', async () => {
    const org = trackOrg(`atg-g-${TS}`)
    const admin = await tok(base, `g-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })

    const g1 = (await (await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `G1 ${TS}` } })).json()).group
    // I8 (gate P2-4): unarchiving a group that is still ACTIVE is rejected with 409
    // GROUP_NOT_ARCHIVED — the lock's ratified code for this branch had zero coverage.
    const unarchiveActive = await httpReq(base, `/api/approval-template-groups/${g1.id}/unarchive`, admin, { method: 'POST' })
    expect(unarchiveActive.status).toBe(409)
    expect((await unarchiveActive.json()).error.code).toBe('GROUP_NOT_ARCHIVED')

    const arch1 = await httpReq(base, `/api/approval-template-groups/${g1.id}/archive`, admin, { method: 'POST' })
    expect(arch1.status).toBe(200)
    const unarch1 = await httpReq(base, `/api/approval-template-groups/${g1.id}/unarchive`, admin, { method: 'POST' })
    expect(unarch1.status).toBe(200)
    const unarchived = (await unarch1.json()).group
    expect(unarchived.archivedAt).toBeNull()
    expect(typeof unarchived.sortOrder).toBe('number')
    // I8: members do not come back.
    const memberCount = await query(`SELECT count(*)::int AS n FROM approval_template_group_links WHERE group_id = $1`, [g1.id])
    expect(memberCount.rows[0].n).toBe(0)

    const arch1b = await httpReq(base, `/api/approval-template-groups/${g1.id}/archive`, admin, { method: 'POST' })
    expect(arch1b.status).toBe(200)
    const g2 = (await (await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `G1 ${TS}` } })).json()).group
    const unarch1c = await httpReq(base, `/api/approval-template-groups/${g1.id}/unarchive`, admin, { method: 'POST' })
    expect(unarch1c.status).toBe(409)
    expect((await unarch1c.json()).error.code).toBe('GROUP_NAME_TAKEN')
    const g1StillArchived = await query(`SELECT archived_at FROM approval_template_groups WHERE id = $1`, [g1.id])
    expect(g1StillArchived.rows[0].archived_at).not.toBeNull()

    const archG2 = await httpReq(base, `/api/approval-template-groups/${g2.id}/archive`, admin, { method: 'POST' })
    expect(archG2.status).toBe(200)
    const g3 = (await (await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `G3 ${TS}` } })).json()).group
    const renameG3 = await httpReq(base, `/api/approval-template-groups/${g3.id}`, admin, { method: 'PATCH', body: { name: `G1 ${TS}` } })
    expect(renameG3.status).toBe(200)
    const unarch1d = await httpReq(base, `/api/approval-template-groups/${g1.id}/unarchive`, admin, { method: 'POST' })
    expect(unarch1d.status).toBe(409)
    expect((await unarch1d.json()).error.code).toBe('GROUP_NAME_TAKEN')
  })

  // ── H ──────────────────────────────────────────────────────────────────────────────────────
  it('H: unlink is idempotent — never-linked, already-unlinked, and active-link cases', async () => {
    const org = trackOrg(`atg-h-${TS}`)
    const admin = await tok(base, `h-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })
    const group = (await (await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `H ${TS}` } })).json()).group

    const neverLinked = await createTemplate(`atg-h-never-${TS}`)
    const unlink1 = await httpReq(base, `/api/approval-templates/${neverLinked}/group`, admin, { method: 'DELETE' })
    expect(unlink1.status).toBe(204)
    const row1 = await query(`SELECT 1 FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`, [org, neverLinked])
    expect(row1.rowCount).toBe(0)

    const activeTpl = await createTemplate(`atg-h-active-${TS}`)
    await httpReq(base, `/api/approval-templates/${activeTpl}/group`, admin, { method: 'POST', body: { groupId: group.id } })
    const unlink2 = await httpReq(base, `/api/approval-templates/${activeTpl}/group`, admin, { method: 'DELETE' })
    expect(unlink2.status).toBe(204)
    const row2 = await query<{ group_id: string | null; unlinked_at: string }>(
      `SELECT group_id, unlinked_at FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
      [org, activeTpl],
    )
    expect(row2.rows[0].group_id).toBeNull()
    const firstUnlinkedAt = new Date(row2.rows[0].unlinked_at).getTime()

    await new Promise((r) => setTimeout(r, 20))
    const unlink3 = await httpReq(base, `/api/approval-templates/${activeTpl}/group`, admin, { method: 'DELETE' })
    expect(unlink3.status).toBe(204)
    const row3 = await query<{ unlinked_at: string }>(
      `SELECT unlinked_at FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
      [org, activeTpl],
    )
    expect(new Date(row3.rows[0].unlinked_at).getTime()).toBe(firstUnlinkedAt)
  })

  // ── B″ ─────────────────────────────────────────────────────────────────────────────────────
  it('B″: first-link and re-link share ONE atomic upsert; two concurrent FIRST links to different groups both succeed, later commit wins', async () => {
    const org = trackOrg(`atg-bpp-${TS}`)
    const admin = await tok(base, `bpp-admin-${TS}`, { roles: 'admin', perms: '*:*', tenantId: org })
    const gA = (await (await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `Bpp A ${TS}` } })).json()).group
    const gB = (await (await httpReq(base, '/api/approval-template-groups', admin, { method: 'POST', body: { name: `Bpp B ${TS}` } })).json()).group
    const tpl = await createTemplate(`atg-bpp-tpl-${TS}`)

    await withRawClient(async (holder, holderPid) => {
      await beginLinkHold(holder, org, tpl, gA.id, 'holder-actor')

      const linkPromise = httpReq(base, `/api/approval-templates/${tpl}/group`, admin, { method: 'POST', body: { groupId: gB.id } })
      await waitUntilBackendBlockedByHolder(holderPid)

      await holder.query('COMMIT')

      const res = await linkPromise
      expect(res.status).toBe(201)
      const link = (await res.json()).link
      expect(link.groupId).toBe(gB.id)
    })

    const rows = await query<{ group_id: string }>(
      `SELECT group_id FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
      [org, tpl],
    )
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0].group_id).toBe(gB.id)

    // Re-link (sequential, no concurrency needed) — SAME upsert path handles it too.
    const relink = await httpReq(base, `/api/approval-templates/${tpl}/group`, admin, { method: 'POST', body: { groupId: gA.id } })
    expect(relink.status).toBe(201)
    const relinkRow = await query<{ group_id: string; unlinked_at: string | null }>(
      `SELECT group_id, unlinked_at FROM approval_template_group_links WHERE org_id = $1 AND template_id = $2`,
      [org, tpl],
    )
    expect(relinkRow.rows[0].group_id).toBe(gA.id)
    expect(relinkRow.rows[0].unlinked_at).toBeNull()
  })

  // ── I′ ─────────────────────────────────────────────────────────────────────────────────────
  describe('I′: I6 explosion-radius behavioural gate — automation template-visibility actor is UNCHANGED by this slice', () => {
    const org = trackOrg(`atg-ip-${TS}`)
    const mainUserId = `ip-main-${TS}`
    const controlUserId = `ip-control-${TS}`
    const managerUserId = `ip-manager-${TS}`
    const deptId = `ip-dept-${TS}`
    const roleId = `ip-role-${TS}`
    let deptTemplateId = ''
    let roleTemplateId = ''
    let unseenTemplateId = ''

    beforeAll(async () => {
      // Roles table row the role-scoped fixture references (roles.name feeds the actor's `roles`
      // set too — automation-approval-template-access.ts's "roles come from THREE sources").
      await query(`INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [roleId, `IP Role ${TS}`])

      for (const [uid, department] of [[mainUserId, deptId], [controlUserId, `${deptId}-other`], [managerUserId, deptId]] as const) {
        await query(
          `INSERT INTO users (id, email, password_hash, role, is_active, is_admin, department)
           VALUES ($1, $1, 'x', 'user', true, false, $2)
           ON CONFLICT (id) DO UPDATE SET department = EXCLUDED.department, is_active = true`,
          [uid, department],
        )
        // Fixture requirement (I′(a)): both MAIN and CONTROL actors hold approvals:read and are
        // NOT template managers — no wildcard codes (`*:*` / `approval-templates:*`), which would
        // ALSO short-circuit `isTemplateManager` (automation-approval-bridge-service.ts hasPermissionCode).
        await query(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`, [uid])
      }
      // MAIN holds the ROLE-scoped role via user_roles (a role membership row) — CONTROL does not.
      await query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [mainUserId, roleId])
      // MANAGER actor: template-manager via approval-templates:manage (one of the three derivation
      // paths — the OTHER two are `users.is_admin` and a role literally named 'admin', neither used
      // here so this fixture isolates the PERMISSION-CODE path).
      await query(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approval-templates:manage') ON CONFLICT DO NOTHING`, [managerUserId])
      await query(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`, [managerUserId])

      deptTemplateId = await createTemplate(`atg-ip-dept-${TS}`, { type: 'dept', ids: [deptId] })
      roleTemplateId = await createTemplate(`atg-ip-role-${TS}`, { type: 'role', ids: [roleId] })
      // The "should NOT be visible to either MAIN or CONTROL" fixture (11th-round finding): makes
      // "non-empty and EQUAL TO the should-see set" a real assertion rather than "list got bigger".
      unseenTemplateId = await createTemplate(`atg-ip-unseen-${TS}`, { type: 'dept', ids: [`${deptId}-nobody`] })
    })

    it('(a) MAIN sees exactly {dept-scoped, role-scoped}, never the unseen template; CONTROL sees nothing (positive control)', async () => {
      const q: QueryFn = (sql, params) => query(sql, params)
      const ids = [deptTemplateId, roleTemplateId, unseenTemplateId]

      const mainNames = await loadReadableApprovalTemplateNames(q, ids, mainUserId)
      expect(mainNames.size).toBe(2)
      expect(new Set(mainNames.keys())).toEqual(new Set([deptTemplateId, roleTemplateId].map((id) => id.toLowerCase())))

      const controlNames = await loadReadableApprovalTemplateNames(q, ids, controlUserId)
      expect(controlNames.size).toBe(0)

      // Manager mutation (fixture-level, not a source edit): granting the manager permission code
      // makes the "should-not-see" template visible too — proving `isTemplateManager` is
      // load-bearing (lock's own named mutation: "给主 actor 加 admin 角色 ⇒ 不该看的模板出现,红"
      // — this fixture uses the PERMISSION-CODE derivation path of the same short-circuit).
      const managerNames = await loadReadableApprovalTemplateNames(q, ids, managerUserId)
      expect(managerNames.size).toBe(3)
      expect(managerNames.has(unseenTemplateId.toLowerCase())).toBe(true)

      // loadApprovalTemplateReader — the underlying actor builder — matches on the same fixture.
      const mainReader = await loadApprovalTemplateReader(q, mainUserId)
      expect(mainReader).not.toBeNull()
      expect(mainReader!.actor.isTemplateManager).toBe(false)
      expect(mainReader!.actor.departmentIds).toEqual([deptId])
      expect(mainReader!.actor.roles).toContain(roleId)
      expect(mainReader!.hasApprovalRead).toBe(true)
    })

    it('(b) all three actor constructors return EXACTLY the ApprovalTemplateVisibilityActor key set at runtime (no stray optional field)', async () => {
      const expectedKeys = ['userId', 'departmentIds', 'roles', 'permissions', 'isTemplateManager'].sort()

      const fakeReq = {
        user: {
          id: mainUserId,
          role: 'user',
          roles: ['user'],
          permissions: ['approvals:read'],
          department: deptId,
        },
      } as unknown as Request
      const routeActor = resolveApprovalTemplateVisibilityActor(fakeReq)
      expect(routeActor).toBeDefined()
      expect(Object.keys(routeActor!).sort()).toEqual(expectedKeys)

      const q: QueryFn = (sql, params) => query(sql, params)
      const txnAuthActor = await loadApprovalTemplateVisibilityActorOnQuery(q, mainUserId)
      expect(txnAuthActor).not.toBeNull()
      expect(Object.keys(txnAuthActor!).sort()).toEqual(expectedKeys)

      const automationReader = await loadApprovalTemplateReader(q, mainUserId)
      expect(automationReader).not.toBeNull()
      expect(Object.keys(automationReader!.actor).sort()).toEqual(expectedKeys)
    })
  })
})
