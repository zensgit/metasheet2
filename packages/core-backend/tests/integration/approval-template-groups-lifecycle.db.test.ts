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
  })

  afterAll(async () => {
    for (const org of orgTags.splice(0)) {
      await query(`DELETE FROM approval_template_group_links WHERE org_id = $1`, [org])
      await query(`DELETE FROM approval_template_groups WHERE org_id = $1`, [org])
    }
    for (const id of templateIds.splice(0)) {
      await query(`DELETE FROM approval_templates WHERE id = $1`, [id])
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
    const listAsReader = await httpReq(base, '/api/approval-template-groups', reader)
    expect(listAsReader.status).toBe(200)
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

  // ── §2 link-time visibility (ratified, gate P2-1) ─────────────────────────────────────────────
  // Two legs, per the finding this closes: `approvalTemplateAdminGuard`'s permission codes are a
  // SUBSET of `isTemplateManager`'s derivation (`resolveApprovalTemplateVisibilityActor` above), so
  // every actor able to reach the link ENDPOINT today is a manager and `applyTemplateVisibilityFilter`
  // short-circuits for them — an HTTP-only test could never turn red on the visibility half of the
  // predicate. Leg (a) therefore calls the exported predicate directly with a hand-built NON-manager
  // actor (real judgement: mutating `isApprovalTemplateVisibleForGroupLink` to drop the
  // `applyTemplateVisibilityFilter` call turns the "hidden" assertion red). Leg (b) goes through the
  // real HTTP endpoint to prove the call SITE is wired (mutating the route handler to remove the call
  // turns this red too — a nonexistent template's INSERT falls through to a raw 23503, which
  // `mapGroupConstraintError` does not map, landing on the generic 500 fallback instead of 404).
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
