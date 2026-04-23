/**
 * Wave 2 WP4 slice 1 — 审批模板分类 + 克隆 integration tests.
 *
 * Validates:
 *   - POST /api/approval-templates accepts `category` on create
 *   - GET  /api/approval-templates filters by `?category=xxx`
 *   - PATCH /api/approval-templates/:id updates the category without spawning
 *     a net-new version (category lives on the parent row, not the snapshot)
 *   - POST /api/approval-templates/:id/clone creates a draft with
 *       - name:  `"{original} (副本)"`
 *       - key:   `"{original}_copy_<6 hex chars>"`
 *       - same formSchema + approvalGraph + category
 *       - status 'draft' (no `publishedDefinition` carried over)
 *   - 403 when the caller lacks `approval-templates:manage`
 *   - 404 when the source template id does not exist
 *
 * ACL / 可见范围, 字段联动, 条件显隐 are other WP4 targets explicitly deferred
 * to later slices.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { randomUUID } from 'node:crypto'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function devToken(
  baseUrl: string,
  userId: string,
  options: { roles?: string; perms?: string } = {},
): Promise<string> {
  const params = new URLSearchParams({
    userId,
    roles: options.roles ?? 'admin',
    perms: options.perms ?? '*:*',
  })
  const response = await fetch(`${baseUrl}/api/auth/dev-token?${params.toString()}`)
  expect(response.status).toBe(200)
  const payload = await response.json() as { token: string }
  return payload.token
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
) {
  return await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

function buildFormSchema() {
  return {
    fields: [
      { id: 'reason', type: 'text', label: '事由', required: true },
    ],
  }
}

function buildLinearGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_1',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['manager-1'] },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-1', source: 'start', target: 'approval_1' },
      { key: 'edge-1-end', source: 'approval_1', target: 'end' },
    ],
  }
}

describeIfDatabase('Approval Wave 2 WP4 slice 1 — template categories & clone', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const suiteSuffix = randomUUID().slice(0, 8)
  const createdTemplateIds = new Set<string>()

  beforeAll(async () => {
    const canListen = await canListenOnEphemeralPort()
    expect(canListen).toBe(true)
    await ensureApprovalSchemaReady()

    // The approval schema bootstrap does not cover the RBAC tables, so the
    // route-level `rbacGuard('approval-templates:manage')` fallback path
    // (DB isAdmin + userHasPermission + namespace-admission) would throw
    // against missing relations and surface as 500 instead of the 403 we
    // want to assert below. Materializing empty stub tables lets the normal
    // "no rows → no permission → 403" flow run without depending on a full
    // platform bootstrap.
    const pool = poolManager.get()
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        PRIMARY KEY (user_id, role_id)
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_permissions (
        user_id TEXT NOT NULL,
        permission_code TEXT NOT NULL,
        PRIMARY KEY (user_id, permission_code)
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id TEXT NOT NULL,
        permission_code TEXT NOT NULL,
        PRIMARY KEY (role_id, permission_code)
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        permissions JSONB
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_namespace_admissions (
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        source TEXT,
        granted_by TEXT,
        updated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, namespace)
      )
    `)

    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [],
    })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    const pool = poolManager.get()
    try {
      const templateIds = [...createdTemplateIds]
      if (templateIds.length > 0) {
        await pool.query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool.query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool.query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templateIds])
      }
    } catch {
      // cleanup failures shouldn't mask test results
    }
    if (server) {
      await server.stop()
    }
  })

  async function createTemplate(
    token: string,
    overrides: { key: string; name: string; category?: string | null },
  ): Promise<{ id: string; category: string | null; key: string; name: string }> {
    const body: Record<string, unknown> = {
      key: overrides.key,
      name: overrides.name,
      formSchema: buildFormSchema(),
      approvalGraph: buildLinearGraph(),
    }
    if (overrides.category !== undefined) body.category = overrides.category
    const response = await jsonRequest(baseUrl, '/api/approval-templates', token, {
      method: 'POST',
      body,
    })
    expect(response.status).toBe(201)
    const payload = await response.json() as {
      id: string
      category: string | null
      key: string
      name: string
    }
    createdTemplateIds.add(payload.id)
    return payload
  }

  it('stores category on create and surfaces it in detail', async () => {
    const adminToken = await devToken(baseUrl, `wp4-admin-create-${suiteSuffix}`)
    const created = await createTemplate(adminToken, {
      key: `wp4-cat-create-${suiteSuffix}`,
      name: 'WP4 Category Create',
      category: '请假',
    })
    expect(created.category).toBe('请假')

    const detailResponse = await jsonRequest(baseUrl, `/api/approval-templates/${created.id}`, adminToken)
    expect(detailResponse.status).toBe(200)
    const detail = await detailResponse.json() as { category: string | null }
    expect(detail.category).toBe('请假')
  })

  it('filters the template list by ?category=xxx and returns all templates when omitted', async () => {
    const adminToken = await devToken(baseUrl, `wp4-admin-filter-${suiteSuffix}`)
    const tagged = await createTemplate(adminToken, {
      key: `wp4-cat-filter-a-${suiteSuffix}`,
      name: 'Filter Match',
      category: '采购',
    })
    const other = await createTemplate(adminToken, {
      key: `wp4-cat-filter-b-${suiteSuffix}`,
      name: 'Filter No Match',
      category: '报销',
    })
    const uncategorized = await createTemplate(adminToken, {
      key: `wp4-cat-filter-c-${suiteSuffix}`,
      name: 'Filter Uncategorized',
    })

    // Filtered list — only templates with category='采购' come back.
    const filteredResponse = await jsonRequest(
      baseUrl,
      `/api/approval-templates?category=${encodeURIComponent('采购')}&pageSize=200`,
      adminToken,
    )
    expect(filteredResponse.status).toBe(200)
    const filtered = await filteredResponse.json() as {
      data: Array<{ id: string; category: string | null }>
      total: number
    }
    const filteredIds = new Set(filtered.data.map((t) => t.id))
    expect(filteredIds.has(tagged.id)).toBe(true)
    expect(filteredIds.has(other.id)).toBe(false)
    expect(filteredIds.has(uncategorized.id)).toBe(false)
    for (const row of filtered.data) {
      expect(row.category).toBe('采购')
    }

    // No filter — every template the caller created this run is present,
    // including uncategorized ones. The total may include pre-existing
    // fixtures from earlier tests in the same DB, so we only assert membership
    // rather than exact count.
    const allResponse = await jsonRequest(
      baseUrl,
      `/api/approval-templates?pageSize=200`,
      adminToken,
    )
    expect(allResponse.status).toBe(200)
    const all = await allResponse.json() as { data: Array<{ id: string }> }
    const allIds = new Set(all.data.map((t) => t.id))
    expect(allIds.has(tagged.id)).toBe(true)
    expect(allIds.has(other.id)).toBe(true)
    expect(allIds.has(uncategorized.id)).toBe(true)
  })

  it('exposes /api/approval-templates/categories with distinct non-null values', async () => {
    const adminToken = await devToken(baseUrl, `wp4-admin-cats-${suiteSuffix}`)
    await createTemplate(adminToken, {
      key: `wp4-cat-distinct-${suiteSuffix}`,
      name: 'Distinct Category',
      category: `wp4-distinct-${suiteSuffix}`,
    })

    const response = await jsonRequest(baseUrl, '/api/approval-templates/categories', adminToken)
    expect(response.status).toBe(200)
    const payload = await response.json() as { data: string[] }
    expect(Array.isArray(payload.data)).toBe(true)
    expect(payload.data).toContain(`wp4-distinct-${suiteSuffix}`)
    // Distinct invariant — no duplicates.
    expect(new Set(payload.data).size).toBe(payload.data.length)
  })

  it('updates category via PATCH without changing the version graph snapshot', async () => {
    const adminToken = await devToken(baseUrl, `wp4-admin-patch-${suiteSuffix}`)
    const created = await createTemplate(adminToken, {
      key: `wp4-cat-patch-${suiteSuffix}`,
      name: 'WP4 Patch Category',
      category: '请假',
    })

    // Snapshot the original version id — we use this to detect that a PATCH
    // with *only* category does NOT create a net-new version (category lives
    // on the parent row, so the snapshot shouldn't rotate).
    const beforeResponse = await jsonRequest(baseUrl, `/api/approval-templates/${created.id}`, adminToken)
    const before = await beforeResponse.json() as { latestVersionId: string | null }
    expect(before.latestVersionId).toBeTruthy()

    const patchResponse = await jsonRequest(baseUrl, `/api/approval-templates/${created.id}`, adminToken, {
      method: 'PATCH',
      body: { category: '财务' },
    })
    expect(patchResponse.status).toBe(200)
    const patched = await patchResponse.json() as {
      category: string | null
      latestVersionId: string | null
    }
    expect(patched.category).toBe('财务')
    expect(patched.latestVersionId).toBe(before.latestVersionId)

    // DB sanity — the parent row now carries the new category.
    const pool = poolManager.get()
    const result = await pool.query<{ category: string | null }>(
      'SELECT category FROM approval_templates WHERE id = $1',
      [created.id],
    )
    expect(result.rows[0]?.category).toBe('财务')
  })

  it('clones a template into a draft with `(副本)` name, `_copy_` key, same category, no publishedDefinition', async () => {
    const adminToken = await devToken(baseUrl, `wp4-admin-clone-${suiteSuffix}`)
    const source = await createTemplate(adminToken, {
      key: `wp4-cat-clone-src-${suiteSuffix}`,
      name: 'WP4 Clone Source',
      category: '采购',
    })

    const cloneResponse = await jsonRequest(baseUrl, `/api/approval-templates/${source.id}/clone`, adminToken, {
      method: 'POST',
    })
    expect(cloneResponse.status).toBe(201)
    const clone = await cloneResponse.json() as {
      id: string
      key: string
      name: string
      status: string
      category: string | null
      activeVersionId: string | null
      latestVersionId: string | null
      formSchema: { fields: unknown[] }
      approvalGraph: { nodes: unknown[]; edges: unknown[] }
    }
    createdTemplateIds.add(clone.id)

    // Name / key mutations — exactly as documented in service docstring.
    expect(clone.id).not.toBe(source.id)
    expect(clone.name).toBe('WP4 Clone Source (副本)')
    expect(clone.key).toMatch(new RegExp(`^wp4-cat-clone-src-${suiteSuffix}_copy_[0-9a-f]{6}$`))

    // Draft-only — status is 'draft', no active_version_id.
    expect(clone.status).toBe('draft')
    expect(clone.activeVersionId).toBeNull()
    expect(clone.latestVersionId).toBeTruthy()
    expect(clone.category).toBe('采购')

    // Form schema + approval graph are byte-equivalent to the source.
    expect(clone.formSchema).toEqual({ fields: buildFormSchema().fields })
    expect(clone.approvalGraph).toEqual(buildLinearGraph())

    // DB sanity — no `approval_published_definitions` row for the clone.
    const pool = poolManager.get()
    const publishedResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM approval_published_definitions
       WHERE template_id = $1`,
      [clone.id],
    )
    expect(parseInt(publishedResult.rows[0]?.count ?? '0', 10)).toBe(0)
  })

  it('clones an archived source template (clone is not gated on status)', async () => {
    const adminToken = await devToken(baseUrl, `wp4-admin-cloneold-${suiteSuffix}`)
    const source = await createTemplate(adminToken, {
      key: `wp4-cat-clone-archived-${suiteSuffix}`,
      name: 'WP4 Clone Archived',
      category: '历史',
    })
    // Flip the source to archived directly — the HTTP surface does not yet
    // expose an archive action, and the clone must still work regardless.
    const pool = poolManager.get()
    await pool.query(`UPDATE approval_templates SET status = 'archived' WHERE id = $1`, [source.id])

    const cloneResponse = await jsonRequest(baseUrl, `/api/approval-templates/${source.id}/clone`, adminToken, {
      method: 'POST',
    })
    expect(cloneResponse.status).toBe(201)
    const clone = await cloneResponse.json() as {
      id: string
      status: string
      category: string | null
    }
    createdTemplateIds.add(clone.id)
    expect(clone.status).toBe('draft')
    expect(clone.category).toBe('历史')
  })

  it('rejects clone without the approval-templates:manage permission (403)', async () => {
    const adminToken = await devToken(baseUrl, `wp4-admin-cloneperm-${suiteSuffix}`)
    const source = await createTemplate(adminToken, {
      key: `wp4-cat-cloneperm-${suiteSuffix}`,
      name: 'WP4 Clone Perm Source',
    })

    const readOnlyToken = await devToken(baseUrl, `wp4-user-readonly-${suiteSuffix}`, {
      roles: 'user',
      perms: 'approvals:read',
    })
    const response = await jsonRequest(baseUrl, `/api/approval-templates/${source.id}/clone`, readOnlyToken, {
      method: 'POST',
    })
    expect(response.status).toBe(403)
  })

  it('returns 404 when cloning a non-existent template', async () => {
    const adminToken = await devToken(baseUrl, `wp4-admin-clone404-${suiteSuffix}`)
    const missingId = randomUUID()
    const response = await jsonRequest(baseUrl, `/api/approval-templates/${missingId}/clone`, adminToken, {
      method: 'POST',
    })
    expect(response.status).toBe(404)
    const payload = await response.json() as { error?: { code?: string } }
    expect(payload.error?.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')
  })
})
