import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { loadDeniedRecordIds } from '../../src/multitable/permission-service'
import { lockRecordLinkActorAuthorityRowsOnQuery } from '../../src/services/approval-record-link-txn-auth'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

/**
 * FWB-0 Layer 2 — record-link form field real-DB contract.
 *
 * Covers:
 *   - publish-time props.baseId/sheetId resolve + creator sheet read auth
 *     via the REAL DB capability source (user_roles / user_permissions /
 *     resolveSheetCapabilitiesForUser) — JWT admin alone is not enough;
 *   - submit-time filler read auth with one values-free no-oracle error for
 *     missing vs record-level-denied (same pinned sheet, non-admin filler);
 *   - dry-run identity: assembleCreationContext authorizes record-links as
 *     requesterOverride?.userId ?? actor.userId (B3-06 sample requester);
 *   - create/route-preview shared substrate.
 *
 * Does NOT wire FWB-2 automation execution or change flags.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const ACTOR = `rl-actor-${TS}`
const FILLER = `rl-filler-${TS}`
/** Second non-admin used only as a dry-run sample requester (readable path). */
const SAMPLE_OK = `rl-sample-ok-${TS}`

async function canListen(): Promise<boolean> {
  return await new Promise((r) => {
    const s = net.createServer()
    s.once('error', () => r(false))
    s.listen(0, '127.0.0.1', () => s.close(() => r(true)))
  })
}

async function tok(base: string, userId: string, roles = 'admin', perms = '*:*'): Promise<string> {
  const res = await fetch(
    `${base}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
  )
  return ((await res.json()) as { token: string }).token
}

async function req(
  base: string,
  path: string,
  token: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
}

function publicValidationShape(body: unknown): { code: string | undefined; errors: string[]; text: string } {
  const b = body as {
    code?: string
    error?: { code?: string; details?: { errors?: string[] }; message?: string }
    details?: { errors?: string[] }
    message?: string
  }
  return {
    code: b.code ?? b.error?.code,
    errors: b.details?.errors ?? b.error?.details?.errors ?? [],
    text: JSON.stringify(b),
  }
}

/**
 * Deterministic two-connection barrier (not a fixed sleep).
 * Polls until a backend is active with wait_event_type='Lock' and blocked by holderPid,
 * optionally matching the waiter query text (e.g. role_permissions / spreadsheet_permissions).
 * Proves the HTTP create path reached and parked on the production FOR UPDATE lock.
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
      + ' (create never engaged the production FOR UPDATE lock — race golden would be vacuous)',
  )
}

describeIfDatabase('record-link form field (FWB-0 Layer 2) — real-DB publish + submit', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let adminTok = ''
  let fillerTok = ''
  let baseId = ''
  let sheetId = ''
  let readableRecordId = ''
  let deniedRecordId = ''
  let tid = ''

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    adminTok = await tok(base, ACTOR)
    // Non-admin filler: sheet-level multitable read + approvals write, NOT admin (admin
    // bypasses record-level deny and would make the unreadable leg vacuous).
    fillerTok = await tok(
      base,
      FILLER,
      'user',
      'multitable:read,approvals:write,approvals:read,approvals:act',
    )

    const pool = poolManager.get()
    baseId = `rl-base-${TS}`
    sheetId = `rl-sheet-${TS}`
    readableRecordId = `rl-rec-ok-${TS}`
    deniedRecordId = `rl-rec-deny-${TS}`

    // Publisher identity must be readable through the REAL capability source used by
    // resolveSheetCapabilitiesForUser / isAdmin — JWT `roles=admin` alone is NOT enough
    // (isAdmin SELECTs user_roles). Do not weaken the product gate; grant the fixture instead.
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
      [ACTOR],
    )

    // FILLER owns the base → txn-local resolveBaseReadableForUserOnQuery grants base-read without
    // needing multitable:base:read (not seeded by full migrations). Admin ACTOR still base-reads via role.
    await pool.query(
      'INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [baseId, `RL Base ${TS}`, FILLER],
    )
    await pool.query(
      'INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [sheetId, baseId, `RL Sheet ${TS}`],
    )
    // Row-level read-deny opt-in on the pinned sheet (required for access_level=none to bite).
    await pool.query(
      'UPDATE meta_sheets SET row_level_read_permissions_enabled = true WHERE id = $1',
      [sheetId],
    )
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3), ($4, $2, '{}'::jsonb, 1, $3)
       ON CONFLICT (id) DO NOTHING`,
      [readableRecordId, sheetId, ACTOR, deniedRecordId],
    )
    // Final create recheck is DB/admin-only for approvals:write (no JWT/request grants).
    // Seed permission codes + user_permissions so fillers pass the txn-local write gate.
    // multitable:read is always present in migrations; approvals:write may need a permissions row.
    await pool.query(
      `INSERT INTO permissions (code, name, description)
       VALUES ('approvals:write', 'Approvals Write', 'record-link fixture')
       ON CONFLICT (code) DO NOTHING`,
    ).catch(async () => {
      await pool.query(
        `INSERT INTO permissions (code) VALUES ('approvals:write') ON CONFLICT DO NOTHING`,
      ).catch(() => {})
    })
    for (const uid of [FILLER, SAMPLE_OK] as const) {
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:read')
         ON CONFLICT DO NOTHING`,
        [uid],
      )
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:write')
         ON CONFLICT DO NOTHING`,
        [uid],
      )
    }
    // Sheet-scoped read grant for non-admin fillers (belt-and-suspenders with global multitable:read).
    for (const uid of [FILLER, SAMPLE_OK] as const) {
      try {
        await pool.query(
          `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code)
           VALUES ($1, 'user', $2, 'spreadsheet:read')`,
          [sheetId, uid],
        )
      } catch {
        await pool.query(
          `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
           VALUES ($1, $2, 'user', $2, 'spreadsheet:read')`,
          [sheetId, uid],
        )
      }
    }
    // Genuine record-level deny for FILLER on an EXISTING same-pinned-sheet record.
    // SAMPLE_OK is deliberately NOT denied → dry-run positive control as sample requester.
    await pool.query(
      `INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level)
       VALUES ($1, $2, 'user', $3, 'none')`,
      [sheetId, deniedRecordId, FILLER],
    )

    const graph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'a',
          config: {
            assigneeSources: [{ kind: 'static_user', userIds: [FILLER] }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'end' },
      ],
    }
    const key = `rl-tpl-${TS}`
    const created = await req(base, '/api/approval-templates', adminTok, {
      method: 'POST',
      body: {
        key,
        name: key,
        formSchema: {
          fields: [{
            id: 'linked',
            type: 'record-link',
            label: '关联记录',
            required: true,
            props: { baseId, sheetId },
          }],
        },
        approvalGraph: graph,
      },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    tid = ((await created.json()) as { id: string }).id
  }, 120_000)

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const tids = (await pool.query(
        `SELECT id FROM approval_templates WHERE key LIKE $1`,
        [`%-${TS}`],
      )).rows.map((r) => r.id as string)
      if (tids.length > 0) {
        const iids = (await pool.query(
          `SELECT id FROM approval_instances WHERE template_id = ANY($1)`,
          [tids],
        )).rows.map((r) => r.id as string)
        if (iids.length > 0) {
          await pool.query(`DELETE FROM approval_records WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_instances WHERE id = ANY($1)`, [iids])
        }
        await pool.query(`DELETE FROM approval_published_definitions WHERE template_id = ANY($1)`, [tids])
        await pool.query(`DELETE FROM approval_template_versions WHERE template_id = ANY($1)`, [tids])
        await pool.query(`DELETE FROM approval_templates WHERE id = ANY($1)`, [tids])
      }
      await pool.query(`DELETE FROM record_permissions WHERE sheet_id = $1`, [sheetId]).catch(() => {})
      await pool.query(`DELETE FROM spreadsheet_permissions WHERE sheet_id = $1`, [sheetId]).catch(() => {})
      await pool.query(
        `DELETE FROM user_permissions WHERE user_id = ANY($1::text[]) AND permission_code = 'multitable:read'`,
        [[FILLER, SAMPLE_OK]],
      ).catch(() => {})
      await pool.query(`DELETE FROM user_roles WHERE user_id = $1`, [ACTOR]).catch(() => {})
      await pool.query(`DELETE FROM meta_records WHERE id = ANY($1::text[])`, [[readableRecordId, deniedRecordId]]).catch(() => {})
      await pool.query(`DELETE FROM meta_sheets WHERE id = $1`, [sheetId]).catch(() => {})
      await pool.query(`DELETE FROM meta_bases WHERE id = $1`, [baseId]).catch(() => {})
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('authority readers use compatible shared locks instead of serializing peer creates', async () => {
    const pool = poolManager.get()
    let second: Promise<void> | undefined
    let secondFinishedWhileFirstHeld = false

    await pool.transaction(async ({ query }) => {
      await lockRecordLinkActorAuthorityRowsOnQuery(query, FILLER)
      second = pool.transaction(async ({ query: secondQuery }) => {
        await lockRecordLinkActorAuthorityRowsOnQuery(secondQuery, FILLER)
      })

      secondFinishedWhileFirstHeld = await Promise.race([
        second.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ])
    })
    await second

    expect(secondFinishedWhileFirstHeld).toBe(true)
  })

  it('publish succeeds when publisher can read the pinned sheet (admin actor)', async () => {
    const published = await req(base, `/api/approval-templates/${tid}/publish`, adminTok, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(published.status, await published.clone().text()).toBe(200)
  })

  it('templates without record-link fields still require DB approvals:write at the final boundary', async () => {
    const pool = poolManager.get()
    const key = `rl-no-link-${TS}`
    const graph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'a',
          config: {
            assigneeSources: [{ kind: 'static_user', userIds: [FILLER] }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'end' },
      ],
    }
    const created = await req(base, '/api/approval-templates', adminTok, {
      method: 'POST',
      body: {
        key,
        name: key,
        formSchema: { fields: [{ id: 'note', type: 'text', label: 'Note' }] },
        approvalGraph: graph,
      },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const templateId = ((await created.json()) as { id: string }).id
    const published = await req(base, `/api/approval-templates/${templateId}/publish`, adminTok, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(published.status, await published.clone().text()).toBe(200)

    await pool.query(
      `DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'approvals:write'`,
      [FILLER],
    )
    try {
      const before = Number((await pool.query(
        'SELECT count(*)::int AS count FROM approval_instances WHERE template_id = $1',
        [templateId],
      )).rows[0]?.count ?? 0)
      const denied = await req(base, '/api/approvals', fillerTok, {
        method: 'POST',
        body: { templateId, formData: { note: 'must not persist' } },
      })
      expect(denied.status).toBe(403)
      const after = Number((await pool.query(
        'SELECT count(*)::int AS count FROM approval_instances WHERE template_id = $1',
        [templateId],
      )).rows[0]?.count ?? 0)
      expect(after).toBe(before)
    } finally {
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:write')
         ON CONFLICT DO NOTHING`,
        [FILLER],
      )
    }
  })

  it('templates without record-link fields accept a DB users.is_admin actor at the final boundary', async () => {
    const pool = poolManager.get()
    const key = `rl-no-link-admin-${TS}`
    const graph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'a',
          config: {
            assigneeSources: [{ kind: 'static_user', userIds: [FILLER] }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'end' },
      ],
    }
    const created = await req(base, '/api/approval-templates', adminTok, {
      method: 'POST',
      body: {
        key,
        name: key,
        formSchema: { fields: [{ id: 'note', type: 'text', label: 'Note' }] },
        approvalGraph: graph,
      },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const templateId = ((await created.json()) as { id: string }).id
    const published = await req(base, `/api/approval-templates/${templateId}/publish`, adminTok, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(published.status, await published.clone().text()).toBe(200)

    const previousUser = (await pool.query(
      `SELECT role, is_admin FROM users WHERE id = $1`,
      [FILLER],
    )).rows[0] as { role: string; is_admin: boolean } | undefined
    const hadAdminRole = Number((await pool.query(
      `SELECT count(*)::int AS count FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`,
      [FILLER],
    )).rows[0]?.count ?? 0) > 0
    try {
      await pool.query(
        `DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'approvals:write'`,
        [FILLER],
      )
      await pool.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`, [FILLER])
      if (previousUser) {
        await pool.query(`UPDATE users SET is_admin = true, role = 'user' WHERE id = $1`, [FILLER])
      } else {
        await pool.query(
          `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
           VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, true, true)`,
          [FILLER, `${FILLER}@test.local`],
        )
      }
      const allowed = await req(base, '/api/approvals', fillerTok, {
        method: 'POST',
        body: { templateId, formData: { note: 'db admin is authoritative' } },
      })
      expect(allowed.status, await allowed.clone().text()).toBe(201)
    } finally {
      if (previousUser) {
        await pool.query(
          `UPDATE users SET is_admin = $2, role = $3 WHERE id = $1`,
          [FILLER, previousUser.is_admin, previousUser.role],
        )
      } else {
        await pool.query(`DELETE FROM users WHERE id = $1`, [FILLER])
      }
      if (hadAdminRole) {
        await pool.query(
          `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
          [FILLER],
        )
      }
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:write')
         ON CONFLICT DO NOTHING`,
        [FILLER],
      )
    }
  })

  it('record-permission PUT observes an in-flight actor revoke before writing', async () => {
    const pool = poolManager.get()
    // Make canManageSheetAccess depend only on the sheet-scoped row. This catches a partial fix
    // that locks actor-wide role/user rows but forgets spreadsheet_permissions.
    await pool.query(
      `DELETE FROM user_permissions
       WHERE user_id = $1 AND permission_code = 'multitable:share'`,
      [FILLER],
    )
    const promoted = await pool.query(
      `UPDATE spreadsheet_permissions
       SET perm_code = 'spreadsheet:admin'
       WHERE sheet_id = $1 AND subject_type = 'user' AND subject_id = $2`,
      [sheetId, FILLER],
    )
    expect(promoted.rowCount).toBeGreaterThan(0)
    await pool.query(
      `DELETE FROM record_permissions
       WHERE sheet_id = $1 AND record_id = $2 AND subject_type = 'user' AND subject_id = $3`,
      [sheetId, readableRecordId, ACTOR],
    )

    let putPromise: Promise<Response> | undefined
    await pool.transaction(async ({ query }) => {
      const pidResult = await query('SELECT pg_backend_pid() AS pid')
      const holderPid = Number((pidResult.rows[0] as { pid: number }).pid)
      await query(
        `SELECT sheet_id FROM spreadsheet_permissions
         WHERE sheet_id = $1 AND subject_type = 'user' AND subject_id = $2 FOR UPDATE`,
        [sheetId, FILLER],
      )
      putPromise = req(
        base,
        `/api/multitable/sheets/${sheetId}/records/${readableRecordId}/permissions`,
        fillerTok,
        {
          method: 'PUT',
          body: { subjectType: 'user', subjectId: ACTOR, accessLevel: 'read' },
        },
      )
      await waitUntilBackendBlockedByHolder(holderPid, { queryFragment: 'spreadsheet_permissions' })
      await query(
        `DELETE FROM spreadsheet_permissions
         WHERE sheet_id = $1 AND subject_type = 'user' AND subject_id = $2`,
        [sheetId, FILLER],
      )
    })

    try {
      const denied = await putPromise!
      expect(denied.status).toBe(403)
      const persisted = await pool.query(
        `SELECT id FROM record_permissions
         WHERE sheet_id = $1 AND record_id = $2 AND subject_type = 'user' AND subject_id = $3`,
        [sheetId, readableRecordId, ACTOR],
      )
      expect(persisted.rows).toHaveLength(0)
    } finally {
      try {
        await pool.query(
          `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code)
           VALUES ($1, 'user', $2, 'spreadsheet:read')`,
          [sheetId, FILLER],
        )
      } catch {
        await pool.query(
          `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
           VALUES ($1, $2, 'user', $2, 'spreadsheet:read')`,
          [sheetId, FILLER],
        )
      }
    }
  })

  it('final create ignores a stale request template-manager grant and rechecks visibility from DB', async () => {
    const pool = poolManager.get()
    await pool.query(
      `UPDATE approval_templates
       SET visibility_scope = $2::jsonb
       WHERE id = $1`,
      [tid, JSON.stringify({ type: 'user', ids: ['someone-else'] })],
    )
    const staleManagerToken = await tok(
      base,
      FILLER,
      'user',
      'multitable:read,approvals:write,approvals:read,approval-templates:manage',
    )
    const before = Number((await pool.query(
      'SELECT count(*)::int AS count FROM approval_instances WHERE template_id = $1',
      [tid],
    )).rows[0]?.count ?? 0)
    try {
      const response = await req(base, '/api/approvals', staleManagerToken, {
        method: 'POST',
        body: {
          templateId: tid,
          formData: { linked: { recordId: readableRecordId } },
        },
      })
      expect(response.status).toBe(404)
      expect((await response.json()) as unknown).toMatchObject({
        error: { code: 'APPROVAL_TEMPLATE_NOT_FOUND' },
      })
      const after = Number((await pool.query(
        'SELECT count(*)::int AS count FROM approval_instances WHERE template_id = $1',
        [tid],
      )).rows[0]?.count ?? 0)
      expect(after).toBe(before)
    } finally {
      await pool.query(
        `UPDATE approval_templates
         SET visibility_scope = '{"type":"all","ids":[]}'::jsonb
         WHERE id = $1`,
        [tid],
      )
    }
  })

  it('create freezes a readable { recordId } into form_snapshot (non-admin filler, non-denied row)', async () => {
    const started = await req(base, '/api/approvals', fillerTok, {
      method: 'POST',
      body: {
        templateId: tid,
        formData: { linked: { recordId: readableRecordId } },
      },
    })
    expect(started.status, await started.clone().text()).toBeLessThan(300)
    const body = (await started.json()) as { id?: string; data?: { id: string } }
    const aid = body.id ?? body.data?.id
    expect(aid).toBeTruthy()

    const pool = poolManager.get()
    const snapshot = (await pool.query<{ form_snapshot: { linked?: unknown } }>(
      `SELECT form_snapshot FROM approval_instances WHERE id = $1`,
      [aid],
    )).rows[0].form_snapshot
    expect(snapshot.linked).toEqual({ recordId: readableRecordId })
  })

  it('missing and same-sheet record-level-denied share byte-identical public error (no existence oracle)', async () => {
    const missingRes = await req(base, '/api/approvals', fillerTok, {
      method: 'POST',
      body: {
        templateId: tid,
        formData: { linked: { recordId: `missing-${TS}` } },
      },
    })
    expect(missingRes.status).toBe(400)
    const missingBody = await missingRes.json()
    const missing = publicValidationShape(missingBody)
    expect(missing.code).toBe('VALIDATION_ERROR')
    expect(missing.errors).toContain('linked record is not readable')
    expect(missing.text).not.toContain(`missing-${TS}`)

    // Unreadable: EXISTING record on the SAME pinned sheet, denied by record_permissions access_level=none
    // for this non-admin filler. Must not be confusable with "missing" via a different public shape.
    const deniedRes = await req(base, '/api/approvals', fillerTok, {
      method: 'POST',
      body: {
        templateId: tid,
        formData: { linked: { recordId: deniedRecordId } },
      },
    })
    expect(deniedRes.status).toBe(400)
    const deniedBody = await deniedRes.json()
    const denied = publicValidationShape(deniedBody)
    expect(denied.code).toBe(missing.code)
    expect(denied.errors).toEqual(missing.errors)
    // Public payloads must be byte-identical modulo any non-deterministic envelope keys we don't use.
    // Normalize to the security-relevant public shape.
    expect({
      status: deniedRes.status,
      code: denied.code,
      errors: denied.errors,
    }).toEqual({
      status: missingRes.status,
      code: missing.code,
      errors: missing.errors,
    })
    expect(denied.text).not.toContain(deniedRecordId)
    expect(denied.text).not.toContain(readableRecordId)
  })

  it('route-preview rejects a missing link under the session actor (shared assembleCreationContext)', async () => {
    const preview = await req(base, `/api/approval-templates/${tid}/route-preview`, adminTok, {
      method: 'POST',
      body: {
        sampleFormData: { linked: { recordId: `preview-missing-${TS}` } },
      },
    })
    expect(preview.status).toBe(400)
    const body = await preview.json()
    const shape = publicValidationShape(body)
    expect(shape.code).toBe('VALIDATION_ERROR')
    expect(shape.errors).toContain('linked record is not readable')
  })

  it('dry-run identity: admin author + sample requester denied an existing row → values-free refusal (not author privilege)', async () => {
    // Admin can read the denied row themselves; if record-link auth used actor.userId, this would
    // incorrectly PASS. It must authorize as sampleRequesterId (= FILLER, who has access_level=none).
    const preview = await req(base, `/api/approval-templates/${tid}/route-preview`, adminTok, {
      method: 'POST',
      body: {
        sampleFormData: { linked: { recordId: deniedRecordId } },
        sampleRequesterId: FILLER,
      },
    })
    expect(preview.status).toBe(400)
    const body = await preview.json()
    const shape = publicValidationShape(body)
    expect(shape.code).toBe('VALIDATION_ERROR')
    expect(shape.errors).toContain('linked record is not readable')
    expect(shape.text).not.toContain(deniedRecordId)
    // Same public shape as a missing record under the same sample requester.
    const missing = await req(base, `/api/approval-templates/${tid}/route-preview`, adminTok, {
      method: 'POST',
      body: {
        sampleFormData: { linked: { recordId: `sample-missing-${TS}` } },
        sampleRequesterId: FILLER,
      },
    })
    expect(missing.status).toBe(400)
    const missingShape = publicValidationShape(await missing.json())
    expect({ code: shape.code, errors: shape.errors }).toEqual({
      code: missingShape.code,
      errors: missingShape.errors,
    })
  })

  it('dry-run identity positive control: sample requester who CAN read the row succeeds', async () => {
    // FILLER is base owner (base-read) + sheet-read, and is not denied on readableRecordId.
    const preview = await req(base, `/api/approval-templates/${tid}/route-preview`, adminTok, {
      method: 'POST',
      body: {
        sampleFormData: { linked: { recordId: readableRecordId } },
        sampleRequesterId: FILLER,
      },
    })
    expect(preview.status, await preview.clone().text()).toBe(200)
    const body = (await preview.json()) as { route?: unknown }
    expect(body.route).toBeTruthy()
  })

  it('publish rejects a record-link pinned to a non-existent sheet (creator auth fail-closed)', async () => {
    const key = `rl-bad-publish-${TS}`
    const created = await req(base, '/api/approval-templates', adminTok, {
      method: 'POST',
      body: {
        key,
        name: key,
        formSchema: {
          fields: [{
            id: 'linked',
            type: 'record-link',
            label: '关联记录',
            props: { baseId: 'no-such-base', sheetId: 'no-such-sheet' },
          }],
        },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            {
              key: 'approval_1',
              type: 'approval',
              config: {
                assigneeSources: [{ kind: 'static_user', userIds: [ACTOR] }],
                approvalMode: 'single',
                emptyAssigneePolicy: 'error',
              },
            },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'e1', source: 'start', target: 'approval_1' },
            { key: 'e2', source: 'approval_1', target: 'end' },
          ],
        },
      },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const badTid = ((await created.json()) as { id: string }).id
    const published = await req(base, `/api/approval-templates/${badTid}/publish`, adminTok, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(published.status).toBe(400)
    const body = (await published.json()) as { code?: string; error?: { code?: string; message?: string }; message?: string }
    const code = body.code ?? body.error?.code
    const message = body.message ?? body.error?.message ?? ''
    expect(code).toBe('VALIDATION_ERROR')
    expect(message).toMatch(/record-link target is not readable/)
  })

  it('publish rejects when publisher has sheet-read but lacks base-read (values-free)', async () => {
    // LIMITED: multitable:read → sheet canRead, but NOT admin / base:read / base owner.
    const LIMITED = `rl-limited-pub-${TS}`
    const limitedTok = await tok(
      base,
      LIMITED,
      'user',
      'approval-templates:manage,approvals:admin-templates,multitable:read',
    )
    const pool = poolManager.get()
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:read') ON CONFLICT DO NOTHING`,
      [LIMITED],
    )
    // Explicitly NOT admin and NOT base owner / base:read.
    await pool.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`, [LIMITED]).catch(() => {})
    await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [ACTOR, baseId])

    const key = `rl-sheet-only-pub-${TS}`
    const created = await req(base, '/api/approval-templates', limitedTok, {
      method: 'POST',
      body: {
        key,
        name: key,
        formSchema: {
          fields: [{
            id: 'linked',
            type: 'record-link',
            label: '关联记录',
            props: { baseId, sheetId },
          }],
        },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            {
              key: 'approval_1',
              type: 'approval',
              config: {
                assigneeSources: [{ kind: 'static_user', userIds: [LIMITED] }],
                approvalMode: 'single',
                emptyAssigneePolicy: 'error',
              },
            },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'e1', source: 'start', target: 'approval_1' },
            { key: 'e2', source: 'approval_1', target: 'end' },
          ],
        },
      },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const limitedTid = ((await created.json()) as { id: string }).id
    const published = await req(base, `/api/approval-templates/${limitedTid}/publish`, limitedTok, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(published.status).toBe(400)
    const body = (await published.json()) as {
      code?: string
      error?: { code?: string; message?: string }
      message?: string
    }
    expect(body.code ?? body.error?.code).toBe('VALIDATION_ERROR')
    expect(body.message ?? body.error?.message ?? '').toMatch(/record-link target is not readable/)
    // Values-free: no base/sheet id echo.
    const text = JSON.stringify(body)
    expect(text).not.toContain(baseId)
    expect(text).not.toContain(sheetId)

    // Restore FILLER ownership for subsequent submit legs that require filler base-read.
    await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [FILLER, baseId])
    await pool.query(`DELETE FROM user_permissions WHERE user_id = $1`, [LIMITED]).catch(() => {})
  })

  it('submit rejects pinned baseId/sheetId membership mismatch (values-free; before record read)', async () => {
    // Publish rejects mismatched pins, so simulate draft/version drift by corrupting form_schema
    // after publish: same sheetId, wrong baseId. Submit must refuse values-free before record read.
    const pool = poolManager.get()
    const otherBase = `rl-other-base-${TS}`
    await pool.query(
      `INSERT INTO meta_bases (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [otherBase, `Other ${TS}`],
    )
    await pool.query(
      `UPDATE approval_template_versions
       SET form_schema = jsonb_set(form_schema, '{fields,0,props,baseId}', to_jsonb($2::text), true)
       WHERE template_id = $1`,
      [tid, otherBase],
    )

    const bad = await req(base, '/api/approvals', fillerTok, {
      method: 'POST',
      body: {
        templateId: tid,
        formData: { linked: { recordId: readableRecordId } },
      },
    })
    expect(bad.status).toBe(400)
    const shape = publicValidationShape(await bad.json())
    expect(shape.code).toBe('VALIDATION_ERROR')
    expect(shape.errors).toContain('linked record is not readable')
    expect(shape.text).not.toContain(readableRecordId)
    expect(shape.text).not.toContain(otherBase)

    // Restore correct baseId pin for the positive-control leg that follows.
    await pool.query(
      `UPDATE approval_template_versions
       SET form_schema = jsonb_set(form_schema, '{fields,0,props,baseId}', to_jsonb($2::text), true)
       WHERE template_id = $1`,
      [tid, baseId],
    )
    await pool.query(`DELETE FROM meta_bases WHERE id = $1`, [otherBase]).catch(() => {})
  })

  it('submit positive control: valid pinned baseId+sheetId membership still freezes', async () => {
    const started = await req(base, '/api/approvals', fillerTok, {
      method: 'POST',
      body: {
        templateId: tid,
        formData: { linked: { recordId: readableRecordId } },
      },
    })
    expect(started.status, await started.clone().text()).toBeLessThan(300)
  })

  it('submit and picker reject when only base-read is absent, then accept when only base-read is granted', async () => {
    const NO_BASE = `rl-nobase-${TS}`
    const noBaseTok = await tok(
      base,
      NO_BASE,
      'user',
      'multitable:read,approvals:write,approvals:read,approvals:act',
    )
    const pool = poolManager.get()
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:read') ON CONFLICT DO NOTHING`,
      [NO_BASE],
    )
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:write') ON CONFLICT DO NOTHING`,
      [NO_BASE],
    )
    try {
      await pool.query(
        `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code)
         VALUES ($1, 'user', $2, 'spreadsheet:read')`,
        [sheetId, NO_BASE],
      )
    } catch {
      await pool.query(
        `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
         VALUES ($1, $2, 'user', $2, 'spreadsheet:read')`,
        [sheetId, NO_BASE],
      )
    }
    // Ensure base is owned by FILLER (not NO_BASE) and NO_BASE is not admin.
    await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [FILLER, baseId])
    await pool.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`, [NO_BASE]).catch(() => {})
    await pool.query(
      `UPDATE users SET permissions = '[]'::jsonb, is_admin = false WHERE id = $1`,
      [NO_BASE],
    ).catch(() => {})
    await pool.query(
      `DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'multitable:base:read'`,
      [NO_BASE],
    ).catch(() => {})

    const badSubmit = await req(base, '/api/approvals', noBaseTok, {
      method: 'POST',
      body: {
        templateId: tid,
        formData: { linked: { recordId: readableRecordId } },
      },
    })
    expect(badSubmit.status).toBe(400)
    const shape = publicValidationShape(await badSubmit.json())
    expect(shape.code).toBe('VALIDATION_ERROR')
    expect(shape.errors).toContain('linked record is not readable')
    expect(shape.text).not.toContain(readableRecordId)
    expect(shape.text).not.toContain(baseId)

    const badPicker = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=5`,
      noBaseTok,
    )
    expect(badPicker.status).toBe(404)
    const pickerBody = await badPicker.text()
    expect(pickerBody).not.toContain(readableRecordId)
    expect(pickerBody).not.toContain(baseId)
    expect(pickerBody).not.toContain(sheetId)

    // Positive control: change exactly one authority dimension. Sheet-read, row-read,
    // approvals:write, template, and record stay unchanged.
    await pool.query(
      `INSERT INTO permissions (code, name, description)
       VALUES ('multitable:base:read', 'Base Read', 'record-link base-read discriminator')
       ON CONFLICT (code) DO NOTHING`,
    ).catch(() => {})
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES ($1, 'multitable:base:read') ON CONFLICT DO NOTHING`,
      [NO_BASE],
    )

    const okSubmit = await req(base, '/api/approvals', noBaseTok, {
      method: 'POST',
      body: {
        templateId: tid,
        formData: { linked: { recordId: readableRecordId } },
      },
    })
    expect(okSubmit.status, await okSubmit.clone().text()).toBeLessThan(300)

    const okPicker = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=5`,
      noBaseTok,
    )
    expect(okPicker.status, await okPicker.clone().text()).toBe(200)
    const okPickerBody = await okPicker.json() as { records: Array<{ id: string }> }
    expect(okPickerBody.records.some((record) => record.id === readableRecordId)).toBe(true)

    await pool.query(`DELETE FROM user_permissions WHERE user_id = $1`, [NO_BASE]).catch(() => {})
    await pool.query(`DELETE FROM spreadsheet_permissions WHERE subject_id = $1`, [NO_BASE]).catch(() => {})
  })

  it('record-link-options: hidden/denied field value never leaks into display (generic label)', async () => {
    const pool = poolManager.get()
    const titleField = `fld_title_${TS}`
    const secretField = `fld_secret_${TS}`
    const secretOnlyRec = `rl-rec-secret-only-${TS}`
    const titledRec = `rl-rec-titled-${TS}`
    await pool.query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES
         ($1, $3, 'Title', 'string', '{}'::jsonb, 1),
         ($2, $3, 'Secret', 'string', '{}'::jsonb, 2)
       ON CONFLICT (id) DO NOTHING`,
      [titleField, secretField, sheetId],
    )
    await pool.query(
      `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
       VALUES ($1, $2, 'user', $3, false, false)`,
      [sheetId, secretField, FILLER],
    )
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES
         ($1, $3, $4::jsonb, 1, $5),
         ($2, $3, $6::jsonb, 1, $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        secretOnlyRec,
        titledRec,
        sheetId,
        JSON.stringify({ [secretField]: 'TOP_SECRET_VALUE', [titleField]: '' }),
        ACTOR,
        JSON.stringify({ [titleField]: '可见标题', [secretField]: 'also-secret' }),
      ],
    )

    const fillerOptionsTok = await tok(
      base,
      FILLER,
      'user',
      'multitable:read,approvals:read,approvals:write',
    )
    const res = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=50`,
      fillerOptionsTok,
    )
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as { records: Array<{ id: string; display: string }> }
    const secretRow = body.records.find((r) => r.id === secretOnlyRec)
    const titledRow = body.records.find((r) => r.id === titledRec)
    expect(secretRow, 'secret-only row should still be listed when row is readable').toBeTruthy()
    // Mutation must redden: secret value must never appear; label is values-free generic.
    expect(secretRow!.display).toBe('未命名记录')
    expect(JSON.stringify(body)).not.toContain('TOP_SECRET_VALUE')
    expect(titledRow?.display).toBe('可见标题')
    expect(JSON.stringify(body)).not.toContain('also-secret')

    await pool.query(`DELETE FROM field_permissions WHERE sheet_id = $1 AND field_id = $2`, [sheetId, secretField]).catch(() => {})
    await pool.query(`DELETE FROM meta_records WHERE id = ANY($1::text[])`, [[secretOnlyRec, titledRec]]).catch(() => {})
    await pool.query(`DELETE FROM meta_fields WHERE id = ANY($1::text[])`, [[titleField, secretField]]).catch(() => {})
  })

  it('record-link-options: exact total/hasMore beyond 300 + search past old boundary', async () => {
    const pool = poolManager.get()
    const titleField = `fld_page_title_${TS}`
    await pool.query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1, $2, 'Title', 'string', '{}'::jsonb, 0)
       ON CONFLICT (id) DO NOTHING`,
      [titleField, sheetId],
    )
    // 305 candidates with searchable titles (beyond the old in-memory 300 cap).
    const ids: string[] = []
    for (let i = 0; i < 305; i += 1) {
      const id = `rl-page-${TS}-${String(i).padStart(3, '0')}`
      ids.push(id)
      await pool.query(
        `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
         VALUES ($1, $2, $3::jsonb, 1, $4)
         ON CONFLICT (id) DO NOTHING`,
        [id, sheetId, JSON.stringify({ [titleField]: `row-label-${i}` }), ACTOR],
      )
    }

    const fillerOptionsTok = await tok(
      base,
      FILLER,
      'user',
      'multitable:read,approvals:read,approvals:write',
    )
    // Page that starts past the old 300 boundary.
    const pageRes = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=20&offset=300`,
      fillerOptionsTok,
    )
    expect(pageRes.status, await pageRes.clone().text()).toBe(200)
    const pageBody = (await pageRes.json()) as {
      records: Array<{ id: string; display: string }>
      page: { total: number; hasMore: boolean; offset: number; limit: number }
    }
    // total includes the 305 page rows + the two fixture rows (readable + denied is denied so not counted)
    // denied is excluded; readable + 305 = at least 306.
    expect(pageBody.page.total).toBeGreaterThanOrEqual(305)
    expect(pageBody.records.length).toBeGreaterThan(0)
    expect(pageBody.page.hasMore).toBe(pageBody.page.offset + pageBody.records.length < pageBody.page.total)
    // Search for a high-index label that would have been past the old 300-scan boundary.
    const searchRes = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=10&search=${encodeURIComponent('row-label-304')}`,
      fillerOptionsTok,
    )
    expect(searchRes.status, await searchRes.clone().text()).toBe(200)
    const searchBody = (await searchRes.json()) as {
      records: Array<{ id: string; display: string }>
      page: { total: number }
    }
    expect(searchBody.page.total).toBeGreaterThanOrEqual(1)
    expect(searchBody.records.some((r) => r.display === 'row-label-304')).toBe(true)
    // Explicit: no record id used as display label.
    for (const r of searchBody.records) {
      expect(r.display).not.toBe(r.id)
    }

    await pool.query(`DELETE FROM meta_records WHERE id = ANY($1::text[])`, [ids]).catch(() => {})
    await pool.query(`DELETE FROM meta_fields WHERE id = $1`, [titleField]).catch(() => {})
  })

  it('record-link-options: admin still respects explicit field_permissions hide (no admin bypass)', async () => {
    const pool = poolManager.get()
    const secretField = `fld_admin_secret_${TS}`
    const secretOnlyRec = `rl-rec-admin-secret-${TS}`
    await pool.query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1, $2, 'Secret', 'string', '{}'::jsonb, 1)
       ON CONFLICT (id) DO NOTHING`,
      [secretField, sheetId],
    )
    // Explicit hide for the admin actor (ACTOR) — layer-3 must still apply.
    await pool.query(
      `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
       VALUES ($1, $2, 'user', $3, false, false)`,
      [sheetId, secretField, ACTOR],
    )
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, $3::jsonb, 1, $4)
       ON CONFLICT (id) DO NOTHING`,
      [secretOnlyRec, sheetId, JSON.stringify({ [secretField]: 'ADMIN_MUST_NOT_SEE' }), ACTOR],
    )

    const res = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=50`,
      adminTok,
    )
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as { records: Array<{ id: string; display: string }> }
    const row = body.records.find((r) => r.id === secretOnlyRec)
    expect(row).toBeTruthy()
    expect(row!.display).toBe('未命名记录')
    expect(JSON.stringify(body)).not.toContain('ADMIN_MUST_NOT_SEE')

    await pool.query(`DELETE FROM field_permissions WHERE sheet_id = $1 AND field_id = $2`, [sheetId, secretField]).catch(() => {})
    await pool.query(`DELETE FROM meta_records WHERE id = $1`, [secretOnlyRec]).catch(() => {})
    await pool.query(`DELETE FROM meta_fields WHERE id = $1`, [secretField]).catch(() => {})
  })

  it('record-link-options: search matches COALESCE display (first blank, second field) past old 300 boundary', async () => {
    const pool = poolManager.get()
    const f1 = `fld_coalesce_a_${TS}`
    const f2 = `fld_coalesce_b_${TS}`
    await pool.query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES
         ($1, $3, 'First', 'string', '{}'::jsonb, 1),
         ($2, $3, 'Second', 'string', '{}'::jsonb, 2)
       ON CONFLICT (id) DO NOTHING`,
      [f1, f2, sheetId],
    )
    // 305 rows: first field blank, second field holds the searchable label (would miss if search
    // only used preferredFieldIds[0]).
    const ids: string[] = []
    for (let i = 0; i < 305; i += 1) {
      const id = `rl-coalesce-${TS}-${String(i).padStart(3, '0')}`
      ids.push(id)
      await pool.query(
        `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
         VALUES ($1, $2, $3::jsonb, 1, $4)
         ON CONFLICT (id) DO NOTHING`,
        [id, sheetId, JSON.stringify({ [f1]: '', [f2]: `second-only-${i}` }), ACTOR],
      )
    }

    const fillerOptionsTok = await tok(
      base,
      FILLER,
      'user',
      'multitable:read,approvals:read,approvals:write',
    )
    const searchRes = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=10&search=${encodeURIComponent('second-only-304')}`,
      fillerOptionsTok,
    )
    expect(searchRes.status, await searchRes.clone().text()).toBe(200)
    const searchBody = (await searchRes.json()) as {
      records: Array<{ id: string; display: string }>
      page: { total: number }
    }
    expect(searchBody.page.total).toBeGreaterThanOrEqual(1)
    const hit = searchBody.records.find((r) => r.display === 'second-only-304')
    expect(hit, 'search must find a row whose label comes from the second allowed field').toBeTruthy()
    expect(hit!.display).not.toBe(hit!.id)

    await pool.query(`DELETE FROM meta_records WHERE id = ANY($1::text[])`, [ids]).catch(() => {})
    await pool.query(`DELETE FROM meta_fields WHERE id = ANY($1::text[])`, [[f1, f2]]).catch(() => {})
  })

  it('create freezes canonical trimmed recordId into form_snapshot (spaces authorized but not stored)', async () => {
    // Value authorized as readableRecordId after trim, must persist as exactly { recordId: trimmed }.
    const started = await req(base, '/api/approvals', fillerTok, {
      method: 'POST',
      body: {
        templateId: tid,
        formData: { linked: { recordId: `  ${readableRecordId}  ` } },
      },
    })
    expect(started.status, await started.clone().text()).toBeLessThan(300)
    const body = (await started.json()) as { id?: string; data?: { id: string } }
    const aid = body.id ?? body.data?.id
    expect(aid).toBeTruthy()

    const pool = poolManager.get()
    const snapshot = (await pool.query<{ form_snapshot: { linked?: unknown } }>(
      `SELECT form_snapshot FROM approval_instances WHERE id = $1`,
      [aid],
    )).rows[0].form_snapshot
    expect(snapshot.linked).toEqual({ recordId: readableRecordId })
    expect(snapshot.linked).not.toEqual({ recordId: `  ${readableRecordId}  ` })
    expect(JSON.stringify(snapshot.linked)).not.toContain('  ')
  })

  it('record-link-options: generic label rows are searchable by 未命名记录 (display/search parity)', async () => {
    const pool = poolManager.get()
    const blankRec = `rl-rec-blank-label-${TS}`
    // Empty data → formatter/SQL both fall through to the generic label (never the record id).
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3)
       ON CONFLICT (id) DO NOTHING`,
      [blankRec, sheetId, ACTOR],
    )

    const fillerOptionsTok = await tok(
      base,
      FILLER,
      'user',
      'multitable:read,approvals:read,approvals:write',
    )
    const searchRes = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=50&search=${encodeURIComponent('未命名记录')}`,
      fillerOptionsTok,
    )
    expect(searchRes.status, await searchRes.clone().text()).toBe(200)
    const searchBody = (await searchRes.json()) as {
      records: Array<{ id: string; display: string }>
      page: { total: number }
    }
    expect(searchBody.page.total).toBeGreaterThanOrEqual(1)
    const hit = searchBody.records.find((r) => r.id === blankRec)
    expect(hit, 'a row displayed as 未命名记录 must be findable by that exact visible text').toBeTruthy()
    expect(hit!.display).toBe('未命名记录')
    expect(hit!.display).not.toBe(blankRec)
    // No raw-id fallback in any returned row for this search.
    for (const r of searchBody.records) {
      expect(r.display).not.toBe(r.id)
    }

    await pool.query(`DELETE FROM meta_records WHERE id = $1`, [blankRec]).catch(() => {})
  })

  it('record-link-options: denied record is absent and exact total excludes it', async () => {
    const pool = poolManager.get()
    const queryFn = (sql: string, params?: unknown[]) => pool.query(sql, params)
    // Derive exact expected total from the SAME deny-set loader the picker uses so shared
    // fixtures cannot make a constant brittle (and rule/projection deny unions stay in sync).
    const allIds = (
      await pool.query<{ id: string }>(`SELECT id FROM meta_records WHERE sheet_id = $1`, [sheetId])
    ).rows.map((r) => r.id)
    const denied = await loadDeniedRecordIds(queryFn, sheetId, FILLER)
    expect(denied.has(deniedRecordId), 'fixture denied row must still be in the deny set').toBe(true)
    expect(allIds.includes(deniedRecordId), 'fixture denied row must still exist on the sheet').toBe(true)
    const expectedTotal = allIds.filter((id) => !denied.has(id)).length
    expect(expectedTotal).toBe(allIds.length - [...denied].filter((id) => allIds.includes(id)).length)
    expect(expectedTotal).toBeGreaterThanOrEqual(1)
    expect(expectedTotal).toBeLessThan(allIds.length)

    const fillerOptionsTok = await tok(
      base,
      FILLER,
      'user',
      'multitable:read,approvals:read,approvals:write',
    )
    // Page large enough to cover the authorized set; if total is huge, still check every page later.
    const pageLimit = Math.min(100, Math.max(expectedTotal, 1))
    const res = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=${pageLimit}&offset=0`,
      fillerOptionsTok,
    )
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as {
      records: Array<{ id: string; display: string }>
      page: { total: number; hasMore: boolean }
    }
    expect(body.page.total).toBe(expectedTotal)
    expect(body.records.some((r) => r.id === deniedRecordId)).toBe(false)
    expect(JSON.stringify(body)).not.toContain(deniedRecordId)

    // Walk remaining pages so a denied row buried past the first page still fails the test.
    let offset = body.records.length
    while (offset < body.page.total) {
      const pageRes = await req(
        base,
        `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=${pageLimit}&offset=${offset}`,
        fillerOptionsTok,
      )
      expect(pageRes.status, await pageRes.clone().text()).toBe(200)
      const pageBody = (await pageRes.json()) as {
        records: Array<{ id: string }>
        page: { total: number }
      }
      expect(pageBody.page.total).toBe(expectedTotal)
      expect(pageBody.records.some((r) => r.id === deniedRecordId)).toBe(false)
      if (pageBody.records.length === 0) break
      offset += pageBody.records.length
    }

    // Positive control for the total formula: adding one authorized row increments total by 1,
    // while the known denied row remains excluded (a regression that includes denied would make
    // total === allCount and go red above / here).
    const extraId = `rl-rec-deny-proof-extra-${TS}`
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3)
       ON CONFLICT (id) DO NOTHING`,
      [extraId, sheetId, ACTOR],
    )
    const afterRes = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=5&offset=0`,
      fillerOptionsTok,
    )
    expect(afterRes.status, await afterRes.clone().text()).toBe(200)
    const afterBody = (await afterRes.json()) as { page: { total: number }; records: Array<{ id: string }> }
    expect(afterBody.page.total).toBe(expectedTotal + 1)
    expect(afterBody.records.some((r) => r.id === deniedRecordId)).toBe(false)
    await pool.query(`DELETE FROM meta_records WHERE id = $1`, [extraId]).catch(() => {})
  })

  it('record-link-options: visible field value === record id → 未命名记录; search parity + no raw-id leak', async () => {
    const pool = poolManager.get()
    const titleField = `fld_id_eq_${TS}`
    // Use a stable record id and put that exact string in the only visible field.
    const recId = `rl-rec-id-eq-value-${TS}`
    await pool.query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1, $2, 'Title', 'string', '{}'::jsonb, 0)
       ON CONFLICT (id) DO NOTHING`,
      [titleField, sheetId],
    )
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, $3::jsonb, 1, $4)
       ON CONFLICT (id) DO NOTHING`,
      [recId, sheetId, JSON.stringify({ [titleField]: recId }), ACTOR],
    )

    const fillerOptionsTok = await tok(
      base,
      FILLER,
      'user',
      'multitable:read,approvals:read,approvals:write',
    )

    // List: display must be the generic label, never the raw id (even though the field holds it).
    const listRes = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=100`,
      fillerOptionsTok,
    )
    expect(listRes.status, await listRes.clone().text()).toBe(200)
    const listBody = (await listRes.json()) as { records: Array<{ id: string; display: string }> }
    const row = listBody.records.find((r) => r.id === recId)
    expect(row, 'row must be listed').toBeTruthy()
    expect(row!.display).toBe('未命名记录')
    expect(row!.display).not.toBe(recId)

    // Positive: search by the effective visible label finds the row + exact total.
    const posRes = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=50&search=${encodeURIComponent('未命名记录')}`,
      fillerOptionsTok,
    )
    expect(posRes.status, await posRes.clone().text()).toBe(200)
    const posBody = (await posRes.json()) as {
      records: Array<{ id: string; display: string }>
      page: { total: number }
    }
    expect(posBody.page.total).toBeGreaterThanOrEqual(1)
    expect(posBody.records.some((r) => r.id === recId && r.display === '未命名记录')).toBe(true)

    // Negative control: search=raw id must NOT surface this counterexample (no raw-id leak).
    const negRes = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=50&search=${encodeURIComponent(recId)}`,
      fillerOptionsTok,
    )
    expect(negRes.status, await negRes.clone().text()).toBe(200)
    const negBody = (await negRes.json()) as {
      records: Array<{ id: string; display: string }>
      page: { total: number }
    }
    expect(negBody.records.some((r) => r.id === recId)).toBe(false)
    // COUNT/total for the raw-id search must also exclude the collapsed-label row.
    // (Other fixtures might coincidentally contain the substring; the id-eq row itself must be out.)
    expect(JSON.stringify(negBody.records)).not.toContain(`"id":"${recId}"`)

    await pool.query(`DELETE FROM meta_records WHERE id = $1`, [recId]).catch(() => {})
    await pool.query(`DELETE FROM meta_fields WHERE id = $1`, [titleField]).catch(() => {})
  })

  it('record-link-options: missing / base-mismatch / existing-unreadable share byte-equivalent public body', async () => {
    const pool = poolManager.get()
    // Existing sheet the filler cannot base-read: temporary owner swap + strip grants.
    const UNREAD = `rl-unread-opts-${TS}`
    const unreadTok = await tok(
      base,
      UNREAD,
      'user',
      'approvals:read,approvals:write',
    )
    // No multitable:read / base-read / ownership for UNREAD.
    await pool.query(`DELETE FROM user_permissions WHERE user_id = $1`, [UNREAD]).catch(() => {})
    await pool.query(`DELETE FROM user_roles WHERE user_id = $1`, [UNREAD]).catch(() => {})
    await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [FILLER, baseId])

    const missingPath =
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(`no-sheet-${TS}`)}`
    const mismatchPath =
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(`other-base-${TS}`)}&sheetId=${encodeURIComponent(sheetId)}`
    const unreadablePath =
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}`

    // Missing + mismatch use FILLER (who can auth otherwise); unreadable uses UNREAD.
    const missingRes = await req(base, missingPath, fillerTok)
    const mismatchRes = await req(base, mismatchPath, fillerTok)
    const unreadableRes = await req(base, unreadablePath, unreadTok)

    expect(missingRes.status).toBe(404)
    expect(mismatchRes.status).toBe(404)
    expect(unreadableRes.status).toBe(404)

    const missingText = await missingRes.text()
    const mismatchText = await mismatchRes.text()
    const unreadableText = await unreadableRes.text()
    // Byte-equivalent public body (golden) across the three refuse legs.
    expect(mismatchText).toBe(missingText)
    expect(unreadableText).toBe(missingText)
    const parsed = JSON.parse(missingText) as {
      ok?: boolean
      error?: { code?: string; message?: string }
      code?: string
      message?: string
    }
    expect(parsed.error?.code ?? parsed.code).toBe('NOT_FOUND')
    expect(parsed.error?.message ?? parsed.message).toBe('Target sheet not found')
    // Values-free: no base/sheet id echo.
    expect(missingText).not.toContain(baseId)
    expect(missingText).not.toContain(sheetId)
    expect(missingText).not.toContain(`no-sheet-${TS}`)
  })

  it('base-read authority three-leg parity: legacy-only / normalized-table-only / base-owner (picker+submit)', async () => {
    const pool = poolManager.get()
    // Ensure multitable:base:read is an admitted permission code (FK / namespace).
    await pool.query(
      `INSERT INTO permissions (code, name, description)
       VALUES ('multitable:base:read', 'Base Read', 'record-link base-read parity')
       ON CONFLICT (code) DO NOTHING`,
    ).catch(() => {})

    const LEGACY = `rl-legacy-base-${TS}`
    const TABLE = `rl-table-base-${TS}`
    const OWNER = `rl-owner-base-${TS}`

    // Shared sheet-read via multitable:read for all three (base-read is the variable under test).
    for (const uid of [LEGACY, TABLE, OWNER]) {
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:read') ON CONFLICT DO NOTHING`,
        [uid],
      )
      try {
        await pool.query(
          `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code)
           VALUES ($1, 'user', $2, 'spreadsheet:read')`,
          [sheetId, uid],
        )
      } catch {
        await pool.query(
          `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
           VALUES ($1, $2, 'user', $2, 'spreadsheet:read')`,
          [sheetId, uid],
        )
      }
    }

    // Ensure users rows exist for legacy permissions column.
    // Final create write gate is DB-only — seed approvals:write for each leg actor.
    for (const uid of [LEGACY, TABLE, OWNER]) {
      await pool.query(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, true, false)
         ON CONFLICT (id) DO NOTHING`,
        [uid, `${uid}@test.local`],
      )
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:write')
         ON CONFLICT DO NOTHING`,
        [uid],
      )
    }

    // Leg 1: legacy-only — base-read only on users.permissions, NOT user_permissions.
    await pool.query(
      `UPDATE users SET permissions = $2::jsonb WHERE id = $1`,
      [LEGACY, JSON.stringify(['multitable:base:read'])],
    )
    await pool.query(
      `DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'multitable:base:read'`,
      [LEGACY],
    ).catch(() => {})

    // Leg 2: normalized-table-only — base-read only on user_permissions; legacy empty.
    await pool.query(
      `UPDATE users SET permissions = '[]'::jsonb WHERE id = $1`,
      [TABLE],
    ).catch(() => {})
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES ($1, 'multitable:base:read') ON CONFLICT DO NOTHING`,
      [TABLE],
    )

    // Leg 3: base-owner — no base-read codes; temporary ownership of the fixture base.
    await pool.query(
      `UPDATE users SET permissions = '[]'::jsonb WHERE id = $1`,
      [OWNER],
    ).catch(() => {})
    await pool.query(
      `DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'multitable:base:read'`,
      [OWNER],
    ).catch(() => {})

    const prevOwner = (
      await pool.query<{ owner_id: string }>(`SELECT owner_id FROM meta_bases WHERE id = $1`, [baseId])
    ).rows[0]?.owner_id

    const leg = async (userId: string, asOwner: boolean) => {
      if (asOwner) {
        await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [userId, baseId])
      } else {
        await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [FILLER, baseId])
      }
      const token = await tok(
        base,
        userId,
        'user',
        'multitable:read,approvals:read,approvals:write,approvals:act',
      )
      const opts = await req(
        base,
        `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=5`,
        token,
      )
      const submit = await req(base, '/api/approvals', token, {
        method: 'POST',
        body: {
          templateId: tid,
          formData: { linked: { recordId: readableRecordId } },
        },
      })
      return { optsStatus: opts.status, submitStatus: submit.status }
    }

    const legacyResult = await leg(LEGACY, false)
    const tableResult = await leg(TABLE, false)
    const ownerResult = await leg(OWNER, true)

    // All three authority surfaces must allow picker + submit (parity).
    expect(legacyResult.optsStatus, 'legacy-only picker').toBe(200)
    expect(tableResult.optsStatus, 'normalized-table-only picker').toBe(200)
    expect(ownerResult.optsStatus, 'base-owner picker').toBe(200)
    expect(legacyResult.submitStatus, 'legacy-only submit').toBeLessThan(300)
    expect(tableResult.submitStatus, 'normalized-table-only submit').toBeLessThan(300)
    expect(ownerResult.submitStatus, 'base-owner submit').toBeLessThan(300)

    // Restore owner for remaining suite fixtures.
    if (prevOwner) {
      await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [prevOwner, baseId])
    } else {
      await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [FILLER, baseId])
    }
    for (const uid of [LEGACY, TABLE, OWNER]) {
      await pool.query(`DELETE FROM user_permissions WHERE user_id = $1`, [uid]).catch(() => {})
      await pool.query(`DELETE FROM spreadsheet_permissions WHERE subject_id = $1`, [uid]).catch(() => {})
      await pool.query(`UPDATE users SET permissions = '[]'::jsonb WHERE id = $1`, [uid]).catch(() => {})
    }
  })

  it('P1-3 real-DB discriminator: canonical meta_fields type string drives display (not fake text-only)', async () => {
    const pool = poolManager.get()
    const stringField = `fld_string_${TS}`
    const rec = `rl-rec-string-${TS}`
    await pool.query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1, $2, 'Canonical Title', 'string', '{}'::jsonb, 0)
       ON CONFLICT (id) DO NOTHING`,
      [stringField, sheetId],
    )
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, $3::jsonb, 1, $4)
       ON CONFLICT (id) DO NOTHING`,
      [rec, sheetId, JSON.stringify({ [stringField]: '字符串标题' }), ACTOR],
    )
    const fillerOptionsTok = await tok(
      base,
      FILLER,
      'user',
      'multitable:read,approvals:write',
    )
    const res = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=50`,
      fillerOptionsTok,
    )
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as { records: Array<{ id: string; display: string }> }
    const row = body.records.find((r) => r.id === rec)
    expect(row?.display).toBe('字符串标题')

    await pool.query(`DELETE FROM meta_records WHERE id = $1`, [rec]).catch(() => {})
    await pool.query(`DELETE FROM meta_fields WHERE id = $1`, [stringField]).catch(() => {})
  })

  it('P1-1 detail GET: unauthorized viewer never sees raw recordId; authorized positive control does', async () => {
    // Create as FILLER (can read the linked row).
    const started = await req(base, '/api/approvals', fillerTok, {
      method: 'POST',
      body: {
        templateId: tid,
        formData: { linked: { recordId: readableRecordId } },
      },
    })
    expect(started.status, await started.clone().text()).toBeLessThan(300)
    const body = (await started.json()) as { id?: string; data?: { id: string }; formSnapshot?: unknown }
    const aid = body.id ?? body.data?.id
    expect(aid).toBeTruthy()

    // Positive control: filler (target-readable) GET must include the raw recordId.
    const okDetail = await req(base, `/api/approvals/${aid}`, fillerTok)
    expect(okDetail.status, await okDetail.clone().text()).toBe(200)
    const okJson = await okDetail.json()
    const okRaw = JSON.stringify(okJson)
    expect(okRaw).toContain(readableRecordId)
    expect(okJson.formSnapshot?.linked ?? okJson.data?.formSnapshot?.linked).toEqual({
      recordId: readableRecordId,
    })

    // Unauthorized viewer: approvals:read only, no multitable sheet/base/row read on the target.
    const STRANGER = `rl-stranger-${TS}`
    const strangerTok = await tok(base, STRANGER, 'user', 'approvals:read')
    const deniedDetail = await req(base, `/api/approvals/${aid}`, strangerTok)
    expect(deniedDetail.status, await deniedDetail.clone().text()).toBe(200)
    const deniedJson = await deniedDetail.json()
    const deniedRaw = JSON.stringify(deniedJson)
    expect(deniedRaw).not.toContain(readableRecordId)
    const linked = deniedJson.formSnapshot?.linked ?? deniedJson.data?.formSnapshot?.linked
    expect(linked).toEqual({ inaccessible: true })
  })

  it('P1-4 two-connection interleaving: delete under FOR UPDATE cannot freeze a stale create target', async () => {
    // Deterministic race: hold the target row FOR UPDATE, then start createApproval HTTP which
    // must re-lock the same row inside its create transaction. Wait until pg_stat_activity shows
    // the create backend parked on wait_event_type='Lock' blocked by this holder, THEN DELETE.
    // Fixed sleeps are vacuous — mutation of lockTargetRow would still pass a sleep-only barrier.
    const pool = poolManager.get()
    const target = `rl-race-rec-${TS}`
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3)
       ON CONFLICT (id) DO NOTHING`,
      [target, sheetId, ACTOR],
    )

    let createPromise: Promise<Response> | undefined
    await pool.transaction(async ({ query }) => {
      const pidRes = await query('SELECT pg_backend_pid() AS pid')
      const holderPid = Number((pidRes.rows[0] as { pid: number }).pid)
      await query(
        `SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE`,
        [target, sheetId],
      )
      createPromise = req(base, '/api/approvals', fillerTok, {
        method: 'POST',
        body: {
          templateId: tid,
          formData: { linked: { recordId: target } },
        },
      })
      await waitUntilBackendBlockedByHolder(holderPid, { queryFragment: 'meta_records' })
      await query(`DELETE FROM meta_records WHERE id = $1`, [target])
    })

    const createRes = await createPromise!
    expect(createRes.status).toBe(400)
    const shape = publicValidationShape(await createRes.json())
    expect(shape.code).toBe('VALIDATION_ERROR')
    expect(shape.errors).toContain('linked record is not readable')
    expect(shape.text).not.toContain(target)

    // No instance was frozen against the deleted target.
    const leftover = await pool.query(
      `SELECT id FROM approval_instances WHERE form_snapshot::text LIKE $1`,
      [`%${target}%`],
    )
    expect(leftover.rows.length).toBe(0)
  })

  it('P1-4 two-connection: concurrent authz revoke is observed by final txn-local check (never freeze stale precheck)', async () => {
    // Production revoke writer: DELETE FROM user_permissions / spreadsheet_permissions.
    // Create final path locks those grant rows FOR SHARE before re-reading auth. We hold the
    // grant rows FOR UPDATE, dispatch create, wait until its shared read is parked on wait_event_type=
    // 'Lock' (blocked by this holder), THEN DELETE and commit — never a fixed sleep.
    const pool = poolManager.get()
    const target = `rl-revoke-rec-${TS}`
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3)
       ON CONFLICT (id) DO NOTHING`,
      [target, sheetId, ACTOR],
    )

    // Positive control first: with grants intact, create still works.
    const positive = await req(base, '/api/approvals', fillerTok, {
      method: 'POST',
      body: {
        templateId: tid,
        formData: { linked: { recordId: target } },
      },
    })
    expect(positive.status, await positive.clone().text()).toBeLessThan(300)

    const raceTarget = `rl-revoke-race-${TS}`
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3)
       ON CONFLICT (id) DO NOTHING`,
      [raceTarget, sheetId, ACTOR],
    )

    let createPromise: Promise<Response> | undefined
    await pool.transaction(async ({ query }) => {
      const pidRes = await query('SELECT pg_backend_pid() AS pid')
      const holderPid = Number((pidRes.rows[0] as { pid: number }).pid)
      // Hold the same authority rows the create final path locks (production revoke surface).
      await query(
        `SELECT permission_code FROM user_permissions WHERE user_id = $1 FOR UPDATE`,
        [FILLER],
      )
      try {
        await query(
          `SELECT sheet_id FROM spreadsheet_permissions
           WHERE sheet_id = $1 AND subject_type = 'user' AND subject_id = $2 FOR UPDATE`,
          [sheetId, FILLER],
        )
      } catch { /* column shape variance */ }

      createPromise = req(base, '/api/approvals', fillerTok, {
        method: 'POST',
        body: {
          templateId: tid,
          formData: { linked: { recordId: raceTarget } },
        },
      })
      // Prove create engaged the production shared authority lock (not a vacuous sleep).
      await waitUntilBackendBlockedByHolder(holderPid, { queryFragment: 'user_permissions' })
      // Real production revoke writers (same rows/SQL the admin revoke path uses).
      await query(
        `DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'multitable:read'`,
        [FILLER],
      )
      await query(
        `DELETE FROM spreadsheet_permissions WHERE sheet_id = $1 AND subject_id = $2`,
        [sheetId, FILLER],
      )
    })

    const createRes = await createPromise!
    expect(createRes.status).toBe(400)
    const shape = publicValidationShape(await createRes.json())
    expect(shape.code).toBe('VALIDATION_ERROR')
    expect(shape.errors).toContain('linked record is not readable')
    expect(shape.text).not.toContain(raceTarget)

    const leftover = await pool.query(
      `SELECT id FROM approval_instances WHERE form_snapshot::text LIKE $1`,
      [`%${raceTarget}%`],
    )
    expect(leftover.rows.length).toBe(0)

    // Restore FILLER grants.
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:read') ON CONFLICT DO NOTHING`,
      [FILLER],
    )
    try {
      await pool.query(
        `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code)
         VALUES ($1, 'user', $2, 'spreadsheet:read')`,
        [sheetId, FILLER],
      )
    } catch {
      await pool.query(
        `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
         VALUES ($1, $2, 'user', $2, 'spreadsheet:read')`,
        [sheetId, FILLER],
      )
    }
  })

  it('P1 approvals:write: deleting last DB write before final txn leaves zero instances; DB grant positive control', async () => {
    // Negative: DB-only write grant deleted while create is blocked on authority locks → deny.
    // JWT omits approvals:write so route may still pass via DB; final gate is DB-only.
    // Positive: create succeeds only with a real DB approvals:write grant (not JWT alone).
    const pool = poolManager.get()
    const DB_WRITER = `rl-db-writer-${TS}`
    const raceRec = `rl-write-revoke-${TS}`

    await pool.query(
      `INSERT INTO permissions (code, name, description)
       VALUES ('approvals:write', 'Approvals Write', 'record-link final-write test')
       ON CONFLICT (code) DO NOTHING`,
    ).catch(async () => {
      await pool.query(
        `INSERT INTO permissions (code) VALUES ('approvals:write') ON CONFLICT DO NOTHING`,
      ).catch(() => {})
    })
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES ($1, 'multitable:read'), ($1, 'approvals:write')
       ON CONFLICT DO NOTHING`,
      [DB_WRITER],
    )
    try {
      await pool.query(
        `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code)
         VALUES ($1, 'user', $2, 'spreadsheet:read')`,
        [sheetId, DB_WRITER],
      )
    } catch {
      await pool.query(
        `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
         VALUES ($1, $2, 'user', $2, 'spreadsheet:read')`,
        [sheetId, DB_WRITER],
      )
    }
    await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [DB_WRITER, baseId])

    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3) ON CONFLICT (id) DO NOTHING`,
      [raceRec, sheetId, ACTOR],
    )

    // JWT omits write — DB user_permissions supplies approvals:write for route + final gate.
    const dbWriterTok = await tok(
      base,
      DB_WRITER,
      'user',
      'multitable:read,approvals:read',
    )

    const okBefore = await req(base, '/api/approvals', dbWriterTok, {
      method: 'POST',
      body: { templateId: tid, formData: { linked: { recordId: raceRec } } },
    })
    expect(okBefore.status, await okBefore.clone().text()).toBeLessThan(300)

    const raceRec2 = `rl-write-revoke-2-${TS}`
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3) ON CONFLICT (id) DO NOTHING`,
      [raceRec2, sheetId, ACTOR],
    )

    let createPromise: Promise<Response> | undefined
    await pool.transaction(async ({ query }) => {
      const pidRes = await query('SELECT pg_backend_pid() AS pid')
      const holderPid = Number((pidRes.rows[0] as { pid: number }).pid)
      await query(
        `SELECT permission_code FROM user_permissions WHERE user_id = $1 FOR UPDATE`,
        [DB_WRITER],
      )
      createPromise = req(base, '/api/approvals', dbWriterTok, {
        method: 'POST',
        body: { templateId: tid, formData: { linked: { recordId: raceRec2 } } },
      })
      await waitUntilBackendBlockedByHolder(holderPid, { queryFragment: 'user_permissions' })
      await query(
        `DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'approvals:write'`,
        [DB_WRITER],
      )
    })

    const createRes = await createPromise!
    expect(createRes.status).toBe(400)
    const shape = publicValidationShape(await createRes.json())
    expect(shape.code).toBe('VALIDATION_ERROR')
    expect(shape.errors).toContain('linked record is not readable')

    const leftover = await pool.query(
      `SELECT id FROM approval_instances WHERE form_snapshot::text LIKE $1`,
      [`%${raceRec2}%`],
    )
    expect(leftover.rows.length).toBe(0)

    // JWT-only write is NOT final authority: user with JWT write but no DB write is refused.
    const jwtOnlyUser = `rl-jwt-only-${TS}`
    const jwtOnlyRec = `rl-jwt-only-rec-${TS}`
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:read')
       ON CONFLICT DO NOTHING`,
      [jwtOnlyUser],
    )
    try {
      await pool.query(
        `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code)
         VALUES ($1, 'user', $2, 'spreadsheet:read')`,
        [sheetId, jwtOnlyUser],
      )
    } catch {
      await pool.query(
        `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
         VALUES ($1, $2, 'user', $2, 'spreadsheet:read')`,
        [sheetId, jwtOnlyUser],
      )
    }
    await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [jwtOnlyUser, baseId])
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3) ON CONFLICT (id) DO NOTHING`,
      [jwtOnlyRec, sheetId, ACTOR],
    )
    const jwtOnlyTok = await tok(
      base,
      jwtOnlyUser,
      'user',
      'multitable:read,approvals:write,approvals:read',
    )
    const jwtOnlyRes = await req(base, '/api/approvals', jwtOnlyTok, {
      method: 'POST',
      body: { templateId: tid, formData: { linked: { recordId: jwtOnlyRec } } },
    })
    // Route may 403 if JWT path is strict, or 400 from final DB-only gate — either refuse is OK.
    expect(jwtOnlyRes.status).toBeGreaterThanOrEqual(400)
    const jwtLeftover = await pool.query(
      `SELECT id FROM approval_instances WHERE form_snapshot::text LIKE $1`,
      [`%${jwtOnlyRec}%`],
    )
    expect(jwtLeftover.rows.length).toBe(0)

    // Positive control: FILLER has real DB approvals:write (seeded in beforeAll).
    await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [FILLER, baseId])
    const dbPosRec = `rl-db-write-pos-${TS}`
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3) ON CONFLICT (id) DO NOTHING`,
      [dbPosRec, sheetId, ACTOR],
    )
    const dbPos = await req(base, '/api/approvals', fillerTok, {
      method: 'POST',
      body: { templateId: tid, formData: { linked: { recordId: dbPosRec } } },
    })
    expect(dbPos.status, await dbPos.clone().text()).toBeLessThan(300)

    await pool.query(`DELETE FROM user_permissions WHERE user_id = ANY($1::text[])`, [[DB_WRITER, jwtOnlyUser]]).catch(() => {})
    await pool.query(`DELETE FROM spreadsheet_permissions WHERE subject_id = ANY($1::text[])`, [[DB_WRITER, jwtOnlyUser]]).catch(() => {})
    await pool.query(`DELETE FROM meta_records WHERE id = ANY($1::text[])`, [[raceRec, raceRec2, jwtOnlyRec, dbPosRec]]).catch(() => {})
  })

  it('P1-4 two-connection: role_permissions approvals:write revoke is serialized (request grants do not mask)', async () => {
    // DB-only write via role_permissions (NOT user_permissions, NOT JWT). Concurrent DELETE of
    // that role_permissions row while create is parked on the production role_permissions
    // shared lock must be observed. JWT omits approvals:write so requestGrantedPermissions
    // cannot mask the DB-role revoke fixture. Mutation of lockAuthorityRows:false must time out
    // waitUntilBackendBlockedByHolder (create never engages the lock).
    const pool = poolManager.get()
    const ROLE_WRITER = `rl-role-writer-${TS}`
    const ROLE_ID = `rl-write-role-${TS}`
    const raceRec = `rl-role-write-rec-${TS}`
    const raceRec2 = `rl-role-write-race-${TS}`

    await pool.query(
      `INSERT INTO permissions (code, name, description)
       VALUES ('approvals:write', 'Approvals Write', 'role_permissions revoke fixture')
       ON CONFLICT (code) DO NOTHING`,
    ).catch(async () => {
      await pool.query(
        `INSERT INTO permissions (code) VALUES ('approvals:write') ON CONFLICT DO NOTHING`,
      ).catch(() => {})
    })
    await pool.query(
      `INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [ROLE_ID, `RL Write Role ${TS}`],
    ).catch(async () => {
      await pool.query(
        `INSERT INTO roles (id, name, approval_usable) VALUES ($1, $2, true) ON CONFLICT (id) DO NOTHING`,
        [ROLE_ID, `RL Write Role ${TS}`],
      )
    })
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [ROLE_WRITER, ROLE_ID],
    )
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'approvals:write')
       ON CONFLICT DO NOTHING`,
      [ROLE_ID],
    )
    // Sheet/base readability via ownership + multitable:read only — write is solely role-scoped.
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:read')
       ON CONFLICT DO NOTHING`,
      [ROLE_WRITER],
    )
    try {
      await pool.query(
        `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code)
         VALUES ($1, 'user', $2, 'spreadsheet:read')`,
        [sheetId, ROLE_WRITER],
      )
    } catch {
      await pool.query(
        `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
         VALUES ($1, $2, 'user', $2, 'spreadsheet:read')`,
        [sheetId, ROLE_WRITER],
      )
    }
    await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [ROLE_WRITER, baseId])

    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3) ON CONFLICT (id) DO NOTHING`,
      [raceRec, sheetId, ACTOR],
    )

    // JWT deliberately omits approvals:write — route + final path must use DB role_permissions.
    const roleWriterTok = await tok(
      base,
      ROLE_WRITER,
      'user',
      'multitable:read,approvals:read',
    )

    const okBefore = await req(base, '/api/approvals', roleWriterTok, {
      method: 'POST',
      body: { templateId: tid, formData: { linked: { recordId: raceRec } } },
    })
    expect(okBefore.status, await okBefore.clone().text()).toBeLessThan(300)

    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3) ON CONFLICT (id) DO NOTHING`,
      [raceRec2, sheetId, ACTOR],
    )

    let createPromise: Promise<Response> | undefined
    await pool.transaction(async ({ query }) => {
      const pidRes = await query('SELECT pg_backend_pid() AS pid')
      const holderPid = Number((pidRes.rows[0] as { pid: number }).pid)
      // Hold the same role_permissions rows the create final path locks.
      await query(
        `SELECT role_id, permission_code FROM role_permissions
         WHERE role_id = $1 FOR UPDATE`,
        [ROLE_ID],
      )
      createPromise = req(base, '/api/approvals', roleWriterTok, {
        method: 'POST',
        body: { templateId: tid, formData: { linked: { recordId: raceRec2 } } },
      })
      await waitUntilBackendBlockedByHolder(holderPid, { queryFragment: 'role_permissions' })
      // Production-shaped revoke: DELETE the role-scoped approvals:write grant.
      await query(
        `DELETE FROM role_permissions
         WHERE role_id = $1 AND permission_code = 'approvals:write'`,
        [ROLE_ID],
      )
    })

    const createRes = await createPromise!
    expect(createRes.status).toBe(400)
    const shape = publicValidationShape(await createRes.json())
    expect(shape.code).toBe('VALIDATION_ERROR')
    expect(shape.errors).toContain('linked record is not readable')

    const leftover = await pool.query(
      `SELECT id FROM approval_instances WHERE form_snapshot::text LIKE $1`,
      [`%${raceRec2}%`],
    )
    expect(leftover.rows.length).toBe(0)

    // Restore FILLER ownership; cleanup role-writer fixture.
    await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [FILLER, baseId])
    await pool.query(`DELETE FROM role_permissions WHERE role_id = $1`, [ROLE_ID]).catch(() => {})
    await pool.query(`DELETE FROM user_roles WHERE user_id = $1`, [ROLE_WRITER]).catch(() => {})
    await pool.query(`DELETE FROM user_permissions WHERE user_id = $1`, [ROLE_WRITER]).catch(() => {})
    await pool.query(`DELETE FROM spreadsheet_permissions WHERE subject_id = $1`, [ROLE_WRITER]).catch(() => {})
    await pool.query(`DELETE FROM roles WHERE id = $1`, [ROLE_ID]).catch(() => {})
    await pool.query(
      `DELETE FROM meta_records WHERE id = ANY($1::text[])`,
      [[raceRec, raceRec2]],
    ).catch(() => {})
  })

  it('P1-4 two-connection: member-group sheet-read revoke is serialized by authority locks', async () => {
    // Sheet canRead comes ONLY from member-group spreadsheet_permissions (no multitable:read,
    // no direct user sheet grant). Wait until create is parked on the production membership /
    // sheet-grant shared lock (wait_event_type='Lock'), THEN DELETE. Mutation of
    // lockAuthorityRows:false must fail the barrier (create never parks).
    const pool = poolManager.get()
    const GROUP_READER = `rl-group-reader-${TS}`
    const raceRec = `rl-group-read-rec-${TS}`
    const raceRec2 = `rl-group-read-race-${TS}`

    // platform_member_group_members.user_id FK → users(id); seed the actor row first.
    await pool.query(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [GROUP_READER, `${GROUP_READER}@t.local`, GROUP_READER],
    )

    // platform_member_groups.id is uuid — insert by name and capture returned id.
    const groupIns = await pool.query(
      `INSERT INTO platform_member_groups (name) VALUES ($1) RETURNING id`,
      [`RL Sheet Group ${TS}`],
    )
    const groupIdRaw = (groupIns.rows[0] as { id?: unknown } | undefined)?.id
    if (groupIdRaw == null) throw new Error('platform_member_groups insert returned no id')
    const groupId = String(groupIdRaw)

    await pool.query(
      `INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [groupId, GROUP_READER],
    )
    try {
      await pool.query(
        `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code)
         VALUES ($1, 'member-group', $2, 'spreadsheet:read')`,
        [sheetId, groupId],
      )
    } catch {
      await pool.query(
        `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
         VALUES ($1, $2, 'member-group', $3, 'spreadsheet:read')`,
        [sheetId, GROUP_READER, groupId],
      )
    }
    // Base-read via ownership only — no global multitable:read so sheet scope is the sole canRead.
    await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [GROUP_READER, baseId])

    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3) ON CONFLICT (id) DO NOTHING`,
      [raceRec, sheetId, ACTOR],
    )

    // Final create needs DB approvals:write (JWT alone is not final authority).
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:write')
       ON CONFLICT DO NOTHING`,
      [GROUP_READER],
    )
    const groupReaderTok = await tok(
      base,
      GROUP_READER,
      'user',
      'approvals:write,approvals:read',
    )

    const okBefore = await req(base, '/api/approvals', groupReaderTok, {
      method: 'POST',
      body: { templateId: tid, formData: { linked: { recordId: raceRec } } },
    })
    expect(okBefore.status, await okBefore.clone().text()).toBeLessThan(300)

    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3) ON CONFLICT (id) DO NOTHING`,
      [raceRec2, sheetId, ACTOR],
    )

    let createPromise: Promise<Response> | undefined
    await pool.transaction(async ({ query }) => {
      const pidRes = await query('SELECT pg_backend_pid() AS pid')
      const holderPid = Number((pidRes.rows[0] as { pid: number }).pid)
      // Hold membership + member-group sheet grant rows the create final path locks.
      // Create locks membership BEFORE spreadsheet_permissions, so parking is on membership.
      await query(
        `SELECT group_id FROM platform_member_group_members
         WHERE user_id = $1 FOR UPDATE`,
        [GROUP_READER],
      )
      await query(
        `SELECT sheet_id FROM spreadsheet_permissions
         WHERE sheet_id = $1 AND subject_type = 'member-group' AND subject_id = $2
         FOR UPDATE`,
        [sheetId, groupId],
      )
      createPromise = req(base, '/api/approvals', groupReaderTok, {
        method: 'POST',
        body: { templateId: tid, formData: { linked: { recordId: raceRec2 } } },
      })
      await waitUntilBackendBlockedByHolder(holderPid, {
        queryFragment: 'platform_member_group_members',
      })
      // Production-shaped revoke: drop the member-group sheet-read grant.
      await query(
        `DELETE FROM spreadsheet_permissions
         WHERE sheet_id = $1 AND subject_type = 'member-group' AND subject_id = $2`,
        [sheetId, groupId],
      )
    })

    const createRes = await createPromise!
    expect(createRes.status).toBe(400)
    const shape = publicValidationShape(await createRes.json())
    expect(shape.code).toBe('VALIDATION_ERROR')
    expect(shape.errors).toContain('linked record is not readable')

    const leftover = await pool.query(
      `SELECT id FROM approval_instances WHERE form_snapshot::text LIKE $1`,
      [`%${raceRec2}%`],
    )
    expect(leftover.rows.length).toBe(0)

    // Restore FILLER ownership; cleanup group-reader fixture.
    await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [FILLER, baseId])
    await pool.query(
      `DELETE FROM spreadsheet_permissions WHERE subject_type = 'member-group' AND subject_id = $1`,
      [groupId],
    ).catch(() => {})
    await pool.query(
      `DELETE FROM platform_member_group_members WHERE user_id = $1`,
      [GROUP_READER],
    ).catch(() => {})
    await pool.query(
      `DELETE FROM platform_member_groups WHERE id::text = $1`,
      [groupId],
    ).catch(() => {})
    await pool.query(`DELETE FROM users WHERE id = $1`, [GROUP_READER]).catch(() => {})
    await pool.query(
      `DELETE FROM meta_records WHERE id = ANY($1::text[])`,
      [[raceRec, raceRec2]],
    ).catch(() => {})
  })

  it('P1-4 two-connection: record_permissions deny INSERT is serialized by row-auth advisory lock', async () => {
    // Phantom INSERT of access_level=none races final create deny re-read unless both sides take
    // the same sheet+record pg_advisory_xact_lock. Wait until create is parked on that advisory
    // (wait_event_type='Lock'), THEN insert deny and commit — create must refuse with zero instances.
    // Mutation of lockRowAuth off → waitUntilBackendBlockedByHolder times out (RED).
    const pool = poolManager.get()
    const raceRec = `rl-deny-insert-${TS}`
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3) ON CONFLICT (id) DO NOTHING`,
      [raceRec, sheetId, ACTOR],
    )
    // Ensure no prior deny for FILLER on this fresh row.
    await pool.query(
      `DELETE FROM record_permissions WHERE sheet_id = $1 AND record_id = $2 AND subject_id = $3`,
      [sheetId, raceRec, FILLER],
    ).catch(() => {})

    let createPromise: Promise<Response> | undefined
    await pool.transaction(async ({ query }) => {
      const pidRes = await query('SELECT pg_backend_pid() AS pid')
      const holderPid = Number((pidRes.rows[0] as { pid: number }).pid)
      // Same key the create final path acquires (see acquireRecordLinkRowAuthLockOnQuery).
      await query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `record-link:row-auth:${sheetId}:${raceRec}`,
      ])
      createPromise = req(base, '/api/approvals', fillerTok, {
        method: 'POST',
        body: { templateId: tid, formData: { linked: { recordId: raceRec } } },
      })
      await waitUntilBackendBlockedByHolder(holderPid, { queryFragment: 'pg_advisory_xact_lock' })
      // Production-shaped deny grant (same INSERT surface as PUT record_permissions).
      await query(
        `INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level)
         VALUES ($1, $2, 'user', $3, 'none')
         ON CONFLICT (record_id, subject_type, subject_id)
         DO UPDATE SET access_level = EXCLUDED.access_level`,
        [sheetId, raceRec, FILLER],
      )
    })

    const createRes = await createPromise!
    expect(createRes.status).toBe(400)
    const shape = publicValidationShape(await createRes.json())
    expect(shape.code).toBe('VALIDATION_ERROR')
    expect(shape.errors).toContain('linked record is not readable')
    expect(shape.text).not.toContain(raceRec)

    const leftover = await pool.query(
      `SELECT id FROM approval_instances WHERE form_snapshot::text LIKE $1`,
      [`%${raceRec}%`],
    )
    expect(leftover.rows.length).toBe(0)

    await pool.query(
      `DELETE FROM record_permissions WHERE sheet_id = $1 AND record_id = $2`,
      [sheetId, raceRec],
    ).catch(() => {})
    await pool.query(`DELETE FROM meta_records WHERE id = $1`, [raceRec]).catch(() => {})
  })

  it('P2 publish: concurrent grant revoke is observed by txn-local constant-shape target auth', async () => {
    // Admin ACTOR publishes via the same txn-local path. Hold user_roles (admin source) FOR UPDATE,
    // dispatch publish, wait for Lock park, strip admin role, commit — publish refuses values-free.
    // (Admin is the only actor that can always reach publish RBAC; target auth still re-checks DB.)
    const pool = poolManager.get()
    const key = `rl-pub-revoke-${TS}`
    const created = await req(base, '/api/approval-templates', adminTok, {
      method: 'POST',
      body: {
        key,
        name: key,
        formSchema: {
          fields: [{
            id: 'linked',
            type: 'record-link',
            label: 'L',
            props: { baseId, sheetId },
          }],
        },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', name: 's', config: {} },
            {
              key: 'approval_1',
              type: 'approval',
              name: 'a',
              config: {
                assigneeSources: [{ kind: 'static_user', userIds: [FILLER] }],
                approvalMode: 'single',
                emptyAssigneePolicy: 'error',
              },
            },
            { key: 'end', type: 'end', name: 'e', config: {} },
          ],
          edges: [
            { key: 'e1', source: 'start', target: 'approval_1' },
            { key: 'e2', source: 'approval_1', target: 'end' },
          ],
        },
      },
    })
    expect(created.status, await created.clone().text()).toBeLessThan(300)
    const body = await created.json() as { data?: { id?: string }; id?: string }
    const templateId = body.data?.id ?? body.id
    expect(templateId).toBeTruthy()

    // Positive: admin can publish while role intact.
    const okPub = await req(base, `/api/approval-templates/${templateId}/publish`, adminTok, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(okPub.status, await okPub.clone().text()).toBeLessThan(300)

    // Race template (still draft).
    const key2 = `rl-pub-revoke-2-${TS}`
    const created2 = await req(base, '/api/approval-templates', adminTok, {
      method: 'POST',
      body: {
        key: key2,
        name: key2,
        formSchema: {
          fields: [{
            id: 'linked',
            type: 'record-link',
            label: 'L',
            props: { baseId, sheetId },
          }],
        },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', name: 's', config: {} },
            {
              key: 'approval_1',
              type: 'approval',
              name: 'a',
              config: {
                assigneeSources: [{ kind: 'static_user', userIds: [FILLER] }],
                approvalMode: 'single',
                emptyAssigneePolicy: 'error',
              },
            },
            { key: 'end', type: 'end', name: 'e', config: {} },
          ],
          edges: [
            { key: 'e1', source: 'start', target: 'approval_1' },
            { key: 'e2', source: 'approval_1', target: 'end' },
          ],
        },
      },
    })
    expect(created2.status, await created2.clone().text()).toBeLessThan(300)
    const body2 = await created2.json() as { data?: { id?: string }; id?: string }
    const templateId2 = body2.data?.id ?? body2.id

    // Demote base ownership away from ACTOR so admin role is the sole base/sheet authority path.
    await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [FILLER, baseId])

    let publishPromise: Promise<Response> | undefined
    await pool.transaction(async ({ query }) => {
      const pidRes = await query('SELECT pg_backend_pid() AS pid')
      const holderPid = Number((pidRes.rows[0] as { pid: number }).pid)
      // Publish locks user_roles before re-read (lockRecordLinkAuthorityRowsOnQuery order).
      await query(
        `SELECT role_id FROM user_roles WHERE user_id = $1 FOR UPDATE`,
        [ACTOR],
      )
      publishPromise = req(base, `/api/approval-templates/${templateId2}/publish`, adminTok, {
        method: 'POST',
        body: { policy: { allowRevoke: true } },
      })
      await waitUntilBackendBlockedByHolder(holderPid, { queryFragment: 'user_roles' })
      await query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`, [ACTOR])
    })

    const pubRes = await publishPromise!
    expect(pubRes.status).toBeGreaterThanOrEqual(400)
    const pubText = await pubRes.text()
    expect(pubText.toLowerCase()).toMatch(/not readable|validation|forbidden|denied/)

    // Restore admin role for any later tests (none after this, but keep suite hygiene).
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
      [ACTOR],
    )
    await pool.query(`UPDATE meta_bases SET owner_id = $1 WHERE id = $2`, [FILLER, baseId])
  })

  it('P2 picker no-oracle: missing sheet / base mismatch / missing base / unreadable share stage count', async () => {
    // Discriminating: not only equal public bodies — ordered dual-gate SQL kinds (membership +
    // base_lookup + admin_role + permission_codes + sheet_scope) run for every refuse outcome,
    // including missing base (which used to early-return before admin/permission probes).
    const pool = poolManager.get()
    const ghostSheet = `rl-ghost-sheet-${TS}`
    const ghostBase = `rl-ghost-base-${TS}`
    // A real sheet under a different base (membership mismatch vs requested baseId).
    const otherBase = `rl-other-base-${TS}`
    const otherSheet = `rl-other-sheet-${TS}`
    await pool.query(
      'INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [otherBase, `Other ${TS}`, ACTOR],
    )
    await pool.query(
      'INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [otherSheet, otherBase, `Other Sheet ${TS}`],
    )

    const fillerOptionsTok = await tok(
      base,
      FILLER,
      'user',
      'multitable:read,approvals:write',
    )
    const cases = [
      {
        label: 'missing-sheet',
        url: `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(ghostSheet)}`,
      },
      {
        label: 'base-mismatch',
        url: `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(otherSheet)}`,
      },
      {
        label: 'missing-base',
        // Sheet does not exist either when base is ghost — still exercises missing-base branch of dual gate
        // when membership fails first; pair with an explicit missing-base via wrong baseId on real sheet.
        url: `/api/approvals/record-link-options?baseId=${encodeURIComponent(ghostBase)}&sheetId=${encodeURIComponent(sheetId)}`,
      },
    ] as const

    const bodies: string[] = []
    for (const c of cases) {
      const res = await req(base, c.url, fillerOptionsTok)
      expect(res.status, c.label).toBe(404)
      const body = await res.json()
      bodies.push(JSON.stringify(body))
      // Values-free: no target ids leaked.
      expect(bodies[bodies.length - 1], c.label).not.toContain(ghostSheet)
      expect(bodies[bodies.length - 1], c.label).not.toContain(ghostBase)
    }
    // Public refuse bodies byte-identical across outcomes.
    expect(bodies[1]).toBe(bodies[0])
    expect(bodies[2]).toBe(bodies[0])

    // Unit-level stage transcript parity is covered in approval-record-link-txn-auth /
    // approval-record-link-options unit tests (ordered RECORD_LINK_TARGET_AUTH_STAGES + SQL kind counts).

    await pool.query(`DELETE FROM meta_sheets WHERE id = $1`, [otherSheet]).catch(() => {})
    await pool.query(`DELETE FROM meta_bases WHERE id = $1`, [otherBase]).catch(() => {})
  })

  it('P2-2 record-link-options requires approvals:write (read-only actor denied)', async () => {
    // Dedicated actor with NO DB approvals:write — FILLER has DB write for create fixtures, so
    // a JWT-only read-only token for FILLER can still pass if actor.permissions is DB-hydrated.
    const pool = poolManager.get()
    const READ_ONLY = `rl-ro-opts-${TS}`
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:read')
       ON CONFLICT DO NOTHING`,
      [READ_ONLY],
    )
    const readOnlyTok = await tok(base, READ_ONLY, 'user', 'approvals:read,multitable:read')
    const res = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}`,
      readOnlyTok,
    )
    expect(res.status).toBe(403)

    // Positive: actor with DB write (FILLER) is not 403'd by the write guard.
    const writeTok = await tok(base, FILLER, 'user', 'approvals:write,multitable:read')
    const ok = await req(
      base,
      `/api/approvals/record-link-options?baseId=${encodeURIComponent(baseId)}&sheetId=${encodeURIComponent(sheetId)}&limit=5`,
      writeTok,
    )
    expect(ok.status).not.toBe(403)
    await pool.query(`DELETE FROM user_permissions WHERE user_id = $1`, [READ_ONLY]).catch(() => {})
  })

  it('P2 multi-link: production multi-target phased locks let overlapping peer creates complete', async () => {
    // Same-actor T1=[A,B] and T2=[B]. Production acquires authority in global phases and uses
    // compatible shared locks for read-only authority rows; both creates must complete without
    // serializing on those rows or producing 40P01. Structural phase order is pinned separately
    // by the unit suite; the shared-lock compatibility test above is the real-DB discriminator.
    const { Client } = await import('pg')
    const { lockRecordLinkMultiTargetCreatePathOnQuery } = await import(
      '../../src/services/approval-record-link-txn-auth'
    )

    const pool = poolManager.get()
    const baseA = `rl-dl-base-a-${TS}`
    const baseB = `rl-dl-base-b-${TS}`
    expect(baseA < baseB).toBe(true)
    const sheetA = `rl-dl-sheet-a-${TS}`
    const sheetB = `rl-dl-sheet-b-${TS}`
    const recA = `rl-dl-rec-a-${TS}`
    const recB = `rl-dl-rec-b-${TS}`
    const USER = FILLER

    await pool.query(
      'INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3), ($4, $5, $3) ON CONFLICT (id) DO NOTHING',
      [baseA, `DL A ${TS}`, USER, baseB, `DL B ${TS}`],
    )
    await pool.query(
      'INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3), ($4, $5, $6) ON CONFLICT (id) DO NOTHING',
      [sheetA, baseA, 'A', sheetB, baseB, 'B'],
    )
    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3), ($4, $5, '{}'::jsonb, 1, $3)
       ON CONFLICT (id) DO NOTHING`,
      [recA, sheetA, USER, recB, sheetB],
    )
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:write')
       ON CONFLICT DO NOTHING`,
      [USER],
    ).catch(() => {})

    type Target = { baseId: string; sheetId: string; recordId: string }
    const setAB: Target[] = [
      { baseId: baseA, sheetId: sheetA, recordId: recA },
      { baseId: baseB, sheetId: sheetB, recordId: recB },
    ]
    const setB: Target[] = [
      { baseId: baseB, sheetId: sheetB, recordId: recB },
    ]

    async function withClient<T>(fn: (c: InstanceType<typeof Client>) => Promise<T>): Promise<T> {
      const c = new Client({ connectionString: process.env.DATABASE_URL })
      await c.connect()
      try {
        return await fn(c)
      } finally {
        await c.end().catch(() => {})
      }
    }

    async function waitFlag(get: () => boolean, timeoutMs = 8_000): Promise<void> {
      const deadline = Date.now() + timeoutMs
      while (!get() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(get()).toBe(true)
    }

    // ── GOLDEN: production phased helper — concurrent [A,B] and [B] complete without 40P01.
    let t1HoldsBaseA = false
    let t1Release = false
    const golden = Promise.all([
      withClient(async (c1) => {
        const q = (sql: string, params?: unknown[]) => c1.query(sql, params)
        await c1.query('BEGIN')
        // Hold first phase-1 lock for setAB so T2 can enter and contend on later locks.
        await c1.query(`SELECT id FROM meta_bases WHERE id = $1 FOR UPDATE`, [baseA])
        t1HoldsBaseA = true
        await waitFlag(() => t1Release, 6_000)
        await lockRecordLinkMultiTargetCreatePathOnQuery(q, {
          userId: USER,
          targets: setAB,
        })
        await c1.query('COMMIT')
      }),
      withClient(async (c2) => {
        const q = (sql: string, params?: unknown[]) => c2.query(sql, params)
        await waitFlag(() => t1HoldsBaseA, 6_000)
        await c2.query('BEGIN')
        await lockRecordLinkMultiTargetCreatePathOnQuery(q, {
          userId: USER,
          targets: setB,
        })
        await c2.query('COMMIT')
      }),
    ])
    await waitFlag(() => t1HoldsBaseA, 6_000)
    await new Promise((r) => setTimeout(r, 150))
    t1Release = true
    await expect(golden).resolves.toBeDefined()

    // Cleanup
    await pool.query(`DELETE FROM meta_records WHERE id = ANY($1::text[])`, [[recA, recB]]).catch(() => {})
    await pool.query(`DELETE FROM meta_sheets WHERE id = ANY($1::text[])`, [[sheetA, sheetB]]).catch(() => {})
    await pool.query(`DELETE FROM meta_bases WHERE id = ANY($1::text[])`, [[baseA, baseB]]).catch(() => {})
  })
})
