import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type TemplateRow = {
  id: string
  key: string
  name: string
  description: string | null
  category: string | null
  visibility_scope: Record<string, unknown> | null
  status: 'draft' | 'published' | 'archived'
  active_version_id: string | null
  latest_version_id: string | null
  created_at: Date
  updated_at: Date
}

type TemplateVersionRow = {
  id: string
  template_id: string
  version: number
  status: 'draft' | 'published' | 'archived'
  form_schema: Record<string, unknown>
  approval_graph: Record<string, unknown>
  /** B3-09 — recorded at publish time; null everywhere else (mirrors the nullable column). */
  publish_note: string | null
  created_at: Date
  updated_at: Date
}

type PublishedDefinitionRow = {
  id: string
  template_id: string
  template_version_id: string
  runtime_graph: Record<string, unknown>
  is_active: boolean
  published_at: Date
}

// B3-08 — a minimal approval_instances fixture, only used to prove the /usage endpoint's counts.
type InstanceRow = {
  id: string
  template_id: string
  status: string
}

const routeState = vi.hoisted(() => {
  const now = () => new Date('2026-04-11T12:00:00.000Z')

  const state = {
    templates: new Map<string, TemplateRow>(),
    versions: new Map<string, TemplateVersionRow>(),
    publishedDefinitions: new Map<string, PublishedDefinitionRow>(),
    instances: new Map<string, InstanceRow>(),
    templateSeq: 1,
    versionSeq: 1,
    publishedSeq: 1,
    instanceSeq: 1,
  }

  function reset() {
    state.templates.clear()
    state.versions.clear()
    state.publishedDefinitions.clear()
    state.instances.clear()
    state.templateSeq = 1
    state.versionSeq = 1
    state.publishedSeq = 1
    state.instanceSeq = 1
  }

  function createInstanceFixture(templateId: string, overrides?: Partial<InstanceRow>) {
    const instance: InstanceRow = {
      id: `apr-${state.instanceSeq++}`,
      template_id: templateId,
      status: 'pending',
      ...overrides,
    }
    state.instances.set(instance.id, instance)
    return instance
  }

  function createTemplateFixture(overrides?: Partial<TemplateRow>) {
    const timestamp = now()
    const template: TemplateRow = {
      id: `tpl-${state.templateSeq++}`,
      key: 'travel-request',
      name: 'Travel Request',
      description: 'Base template',
      category: null,
      visibility_scope: { type: 'all', ids: [] },
      status: 'draft',
      active_version_id: null,
      latest_version_id: null,
      created_at: timestamp,
      updated_at: timestamp,
      ...overrides,
    }
    state.templates.set(template.id, template)
    return template
  }

  function createVersionFixture(templateId: string, overrides?: Partial<TemplateVersionRow>) {
    const timestamp = now()
    const version: TemplateVersionRow = {
      id: `ver-${state.versionSeq++}`,
      template_id: templateId,
      version: 1,
      status: 'draft',
      form_schema: {
        fields: [
          { id: 'reason', type: 'text', label: 'Reason', required: true },
        ],
      },
      approval_graph: {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'approve_1', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['manager'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e1', source: 'start', target: 'approve_1' },
          { key: 'e2', source: 'approve_1', target: 'end' },
        ],
      },
      publish_note: null,
      created_at: timestamp,
      updated_at: timestamp,
      ...overrides,
    }
    state.versions.set(version.id, version)
    return version
  }

  function normalize(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim()
  }

  function parseJson(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>
    return (value ?? {}) as Record<string, unknown>
  }

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const normalized = normalize(sql)

    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return { rows: [], rowCount: 0 }
    }

    // B3-09 — rbacGuardAny's DB fallbacks (namespace admission / isAdmin / userHasPermission /
    // legacy users.permissions) for the NON-admin user in the 403 test: this suite has no RBAC
    // tables, so every lookup resolves empty → the guard's own 403 fires (rather than a masked
    // 500 from an unhandled-query throw).
    if (
      normalized.includes('FROM user_roles')
      || normalized.includes('FROM user_permissions')
      || normalized.includes('FROM user_namespace_admissions')
    ) {
      return { rows: [], rowCount: 0 }
    }
    if (normalized.startsWith('SELECT permissions FROM users WHERE id = $1')) {
      return { rows: [], rowCount: 0 }
    }

    if (normalized.startsWith('SELECT COUNT(*)::text AS count FROM approval_templates')) {
      const rows = Array.from(state.templates.values()).filter((row) => {
        if (!normalized.includes('visibility_scope')) return true
        const scope = row.visibility_scope
        if (!scope || scope.type === 'all') return true
        if (scope.type === 'user') return (scope.ids as string[]).includes('template-admin')
        if (scope.type === 'role') return (scope.ids as string[]).includes('admin')
        return false
      })
      return { rows: [{ count: String(rows.length) }], rowCount: 1 }
    }

    if (
      normalized.startsWith('SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE')
      || normalized.startsWith('SELECT * FROM approval_templates WHERE id = $1')
    ) {
      const row = state.templates.get(String(params[0]))
      if (row && normalized.includes('visibility_scope')) {
        const scope = row.visibility_scope
        const visible = !scope
          || scope.type === 'all'
          || (scope.type === 'user' && (scope.ids as string[]).includes('template-admin'))
          || (scope.type === 'role' && (scope.ids as string[]).includes('admin'))
        return { rows: visible ? [row] : [], rowCount: visible ? 1 : 0 }
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    if (
      normalized.startsWith('SELECT * FROM approval_templates ORDER BY updated_at DESC, id DESC')
      || normalized.startsWith('SELECT * FROM approval_templates WHERE ')
    ) {
      const limit = Number(params[params.length - 2] ?? 50)
      const offset = Number(params[params.length - 1] ?? 0)
      const rows = Array.from(state.templates.values())
        .sort((left, right) => right.updated_at.getTime() - left.updated_at.getTime())
        .slice(offset, offset + limit)
      return { rows, rowCount: rows.length }
    }

    if (normalized.startsWith('INSERT INTO approval_templates')) {
      const timestamp = now()
      const hasVisibilityScope = normalized.includes('visibility_scope')
      const row: TemplateRow = {
        id: `tpl-${state.templateSeq++}`,
        key: String(params[0]),
        name: String(params[1]),
        description: params[2] == null ? null : String(params[2]),
        category: params[3] == null ? null : String(params[3]),
        visibility_scope: hasVisibilityScope
          ? parseJson(params[4])
          : { type: 'all', ids: [] },
        status: 'draft',
        active_version_id: null,
        latest_version_id: null,
        created_at: timestamp,
        updated_at: timestamp,
      }
      state.templates.set(row.id, row)
      return { rows: [row], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE approval_templates SET latest_version_id = $1, updated_at = now() WHERE id = $2 RETURNING *')) {
      const row = state.templates.get(String(params[1]))
      if (!row) return { rows: [], rowCount: 0 }
      row.latest_version_id = String(params[0])
      row.updated_at = now()
      return { rows: [row], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE approval_templates SET status = \'published\',')) {
      const row = state.templates.get(String(params[1]))
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'published'
      row.active_version_id = String(params[0])
      row.updated_at = now()
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE approval_templates SET') && normalized.includes('RETURNING *')) {
      const id = String(params[params.length - 1])
      const row = state.templates.get(id)
      if (!row) return { rows: [], rowCount: 0 }
      let index = 0
      if (normalized.includes('key = $')) row.key = String(params[index++])
      if (normalized.includes('name = $')) row.name = String(params[index++])
      if (normalized.includes('description = $')) {
        const value = params[index++]
        row.description = value == null ? null : String(value)
      }
      if (normalized.includes('category = $')) {
        // Wave 2 WP4 slice 1 — category updates on the parent row.
        const value = params[index++]
        row.category = value == null ? null : String(value)
      }
      if (normalized.includes('visibility_scope = $')) {
        row.visibility_scope = parseJson(params[index++])
      }
      row.updated_at = now()
      return { rows: [row], rowCount: 1 }
    }

    if (normalized.startsWith('SELECT * FROM approval_template_versions WHERE id = $1 AND template_id = $2')) {
      const row = state.versions.get(String(params[0]))
      const rows = row && row.template_id === String(params[1]) ? [row] : []
      return { rows, rowCount: rows.length }
    }

    if (normalized.startsWith('SELECT * FROM approval_template_versions WHERE template_id = $1 ORDER BY version DESC LIMIT 1')) {
      const rows = Array.from(state.versions.values())
        .filter((row) => row.template_id === String(params[0]))
        .sort((left, right) => right.version - left.version)
      return { rows: rows.slice(0, 1), rowCount: rows.length > 0 ? 1 : 0 }
    }

    if (normalized.startsWith('SELECT COALESCE(MAX(version), 0)::text AS max_version FROM approval_template_versions WHERE template_id = $1')) {
      const versions = Array.from(state.versions.values()).filter((row) => row.template_id === String(params[0]))
      const maxVersion = versions.length > 0 ? Math.max(...versions.map((row) => row.version)) : 0
      return { rows: [{ max_version: String(maxVersion) }], rowCount: 1 }
    }

    if (normalized.startsWith('INSERT INTO approval_template_versions')) {
      const timestamp = now()
      const hasExplicitVersionParam = params.length === 4
      const row: TemplateVersionRow = {
        id: `ver-${state.versionSeq++}`,
        template_id: String(params[0]),
        version: hasExplicitVersionParam ? Number(params[1]) : 1,
        status: 'draft',
        form_schema: parseJson(hasExplicitVersionParam ? params[2] : params[1]),
        approval_graph: parseJson(hasExplicitVersionParam ? params[3] : params[2]),
        created_at: timestamp,
        updated_at: timestamp,
      }
      state.versions.set(row.id, row)
      return { rows: [row], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE approval_template_versions SET status = \'published\'')) {
      const row = state.versions.get(String(params[0]))
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'published'
      // B3-09 — the publish UPDATE now also writes publish_note ($2, null when the admin sent none).
      row.publish_note = params.length > 1 ? ((params[1] as string | null) ?? null) : null
      row.updated_at = now()
      return { rows: [row], rowCount: 1 }
    }

    // B3-09 — listTemplateVersions: summary rows newest-first with the ACTIVE published-definition
    // id LEFT JOINed on (null for versions never published or whose definition was superseded).
    if (normalized.startsWith('SELECT v.*, pd.id AS published_definition_id FROM approval_template_versions v')) {
      const rows = Array.from(state.versions.values())
        .filter((row) => row.template_id === String(params[0]))
        .sort((left, right) => right.version - left.version)
        .map((row) => ({
          ...row,
          published_definition_id:
            Array.from(state.publishedDefinitions.values()).find(
              (pd) => pd.template_version_id === row.id && pd.is_active,
            )?.id ?? null,
        }))
      return { rows, rowCount: rows.length }
    }

    if (normalized.startsWith('SELECT * FROM approval_published_definitions WHERE template_version_id = $1')) {
      const rows = Array.from(state.publishedDefinitions.values())
        .filter((row) => row.template_version_id === String(params[0]))
        .sort((left, right) => Number(right.is_active) - Number(left.is_active))
      return { rows: rows.slice(0, 1), rowCount: rows.length > 0 ? 1 : 0 }
    }

    if (normalized.startsWith('UPDATE approval_published_definitions SET is_active = FALSE WHERE template_id = $1 AND is_active = TRUE')) {
      for (const row of state.publishedDefinitions.values()) {
        if (row.template_id === String(params[0]) && row.is_active) {
          row.is_active = false
        }
      }
      return { rows: [], rowCount: 0 }
    }

    if (normalized.startsWith('INSERT INTO approval_published_definitions')) {
      const row: PublishedDefinitionRow = {
        id: `pub-${state.publishedSeq++}`,
        template_id: String(params[0]),
        template_version_id: String(params[1]),
        runtime_graph: parseJson(params[2]),
        is_active: true,
        published_at: now(),
      }
      state.publishedDefinitions.set(row.id, row)
      return { rows: [row], rowCount: 1 }
    }

    // B3-08 — archiveTemplate/unarchiveTemplate's state-machine flip (transitionTemplateStatus).
    // Distinct from the `INSERT`/generic `RETURNING *` UPDATE branches above: this one has no
    // RETURNING clause (the caller reloads the full bundle via loadTemplateBundleWithClient right
    // after), and is parameterized ($1 = new status) rather than the publish path's literal
    // `'published'`.
    if (normalized.startsWith('UPDATE approval_templates SET status = $1, updated_at = now() WHERE id = $2')) {
      const row = state.templates.get(String(params[1]))
      if (!row) return { rows: [], rowCount: 0 }
      row.status = params[0] as TemplateRow['status']
      row.updated_at = now()
      return { rows: [], rowCount: 1 }
    }

    // B3-08 — getTemplateUsage's existence probe (lighter than the full-row SELECT * used
    // elsewhere; intentionally a distinct column list so it needs its own branch).
    if (normalized.startsWith('SELECT id FROM approval_templates WHERE id = $1')) {
      const row = state.templates.get(String(params[0]))
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 }
    }

    // B3-08 — getTemplateUsage's instance-count query (total + still-in-flight, mirroring
    // APPROVAL_TERMINAL_STATUSES = approved/rejected/revoked/cancelled).
    if (normalized.startsWith('SELECT COUNT(*)::text AS total_count')) {
      const terminal = new Set(['approved', 'rejected', 'revoked', 'cancelled'])
      const rows = Array.from(state.instances.values()).filter((row) => row.template_id === String(params[0]))
      const activeCount = rows.filter((row) => !terminal.has(row.status)).length
      return { rows: [{ total_count: String(rows.length), active_count: String(activeCount) }], rowCount: 1 }
    }

    throw new Error(`Unhandled query: ${normalized}`)
  })

  const pool = {
    query,
    connect: vi.fn(async () => ({
      query,
      release: vi.fn(),
    })),
  }

  return {
    reset,
    state,
    createTemplateFixture,
    createVersionFixture,
    createInstanceFixture,
    pool,
  }
})

vi.mock('../../src/db/pg', () => ({
  pool: routeState.pool,
  // B3-09 — rbac/namespace-admission.ts imports the bare `query` helper (not `pool`); route it to
  // the same mock so the guard's non-admin deny path resolves instead of blowing up the mock.
  query: (sql: string, params?: unknown[]) => routeState.pool.query(sql, params ?? []),
}))

// B3-09 — the mock user is now swappable per test (default stays the historical template-admin)
// so the versions-list guard can be proven to 403 a NON-admin, not just 200 an admin.
const authState = vi.hoisted(() => {
  const adminUser = {
    id: 'template-admin',
    sub: 'template-admin',
    name: 'Template Admin',
    email: 'template@example.com',
    permissions: ['*:*'],
    roles: ['admin'],
  }
  return { adminUser, currentUser: adminUser as Record<string, unknown> }
})

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = authState.currentUser as never
    next()
  },
}))

import { approvalsRouter } from '../../src/routes/approvals'

describe('approval template routes', () => {
  beforeEach(() => {
    routeState.reset()
    routeState.pool.query.mockClear()
    routeState.pool.connect.mockClear()
    authState.currentUser = authState.adminUser
  })

  function createApp() {
    const app = express()
    app.use(express.json())
    app.use(approvalsRouter())
    return app
  }

  it('creates a template and its first draft version', async () => {
    const app = createApp()

    const response = await request(app)
      .post('/api/approval-templates')
      .send({
        key: 'expense-approval',
        name: 'Expense Approval',
        description: 'Travel and expense approvals',
        formSchema: {
          fields: [
            { id: 'showDetails', type: 'select', label: 'Show Details', required: true, options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] },
            {
              id: 'details',
              type: 'textarea',
              label: 'Details',
              required: true,
              visibilityRule: {
                fieldId: 'showDetails',
                operator: 'eq',
                value: 'yes',
              },
            },
          ],
        },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            {
              key: 'approve_1',
              type: 'approval',
              config: {
                assigneeType: 'role',
                assigneeIds: ['finance'],
                approvalMode: 'all',
                emptyAssigneePolicy: 'auto-approve',
              },
            },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'e1', source: 'start', target: 'approve_1' },
            { key: 'e2', source: 'approve_1', target: 'end' },
          ],
        },
      })

    expect(response.status).toBe(201)
    expect(response.body.key).toBe('expense-approval')
    expect(response.body.status).toBe('draft')
    expect(response.body.latestVersionId).toMatch(/^ver-/)
    expect(response.body.visibilityScope).toEqual({ type: 'all', ids: [] })
    expect(response.body.formSchema.fields).toHaveLength(2)
    expect(response.body.formSchema.fields[1].visibilityRule).toEqual({
      fieldId: 'showDetails',
      operator: 'eq',
      value: 'yes',
    })
    expect(response.body.approvalGraph.nodes[1].config).toEqual({
      assigneeType: 'role',
      assigneeIds: ['finance'],
      approvalMode: 'all',
      emptyAssigneePolicy: 'auto-approve',
    })
  })

  it('creates and patches template visibility scope metadata without rotating versions', async () => {
    const app = createApp()

    const createResponse = await request(app)
      .post('/api/approval-templates')
      .send({
        key: 'dept-expense',
        name: 'Dept Expense',
        visibilityScope: { type: 'dept', ids: ['finance', 'ops'] },
        formSchema: {
          fields: [{ id: 'amount', type: 'number', label: 'Amount', required: true }],
        },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            { key: 'approve_1', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['finance'] } },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'e1', source: 'start', target: 'approve_1' },
            { key: 'e2', source: 'approve_1', target: 'end' },
          ],
        },
      })

    expect(createResponse.status).toBe(201)
    expect(createResponse.body.visibilityScope).toEqual({ type: 'dept', ids: ['finance', 'ops'] })
    const originalVersionId = createResponse.body.latestVersionId

    const patchResponse = await request(app)
      .patch(`/api/approval-templates/${createResponse.body.id}`)
      .send({
        visibilityScope: { type: 'role', ids: ['manager'] },
      })

    expect(patchResponse.status).toBe(200)
    expect(patchResponse.body.visibilityScope).toEqual({ type: 'role', ids: ['manager'] })
    expect(patchResponse.body.latestVersionId).toBe(originalVersionId)
    expect(routeState.state.versions.size).toBe(1)
  })

  it('patches template metadata and creates a new draft version when graph changes', async () => {
    const template = routeState.createTemplateFixture()
    const version = routeState.createVersionFixture(template.id)
    template.latest_version_id = version.id

    const app = createApp()
    const response = await request(app)
      .patch(`/api/approval-templates/${template.id}`)
      .send({
        name: 'Travel Request v2',
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            { key: 'approve_1', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['manager'] } },
            { key: 'cc_1', type: 'cc', config: { targetType: 'role', targetIds: ['finance'] } },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'e1', source: 'start', target: 'approve_1' },
            { key: 'e2', source: 'approve_1', target: 'cc_1' },
            { key: 'e3', source: 'cc_1', target: 'end' },
          ],
        },
      })

    expect(response.status).toBe(200)
    expect(response.body.name).toBe('Travel Request v2')
    expect(response.body.latestVersionId).not.toBe(version.id)
    expect(routeState.state.versions.size).toBe(2)
    expect(response.body.approvalGraph.nodes).toHaveLength(4)
  })

  it('publishes latest template version and injects runtime policy', async () => {
    const template = routeState.createTemplateFixture()
    const version = routeState.createVersionFixture(template.id, {
      approval_graph: {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          {
            key: 'approve_1',
            type: 'approval',
            config: {
              assigneeType: 'role',
              assigneeIds: ['manager'],
              approvalMode: 'any',
              emptyAssigneePolicy: 'error',
            },
          },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e1', source: 'start', target: 'approve_1' },
          { key: 'e2', source: 'approve_1', target: 'end' },
        ],
      },
    })
    template.latest_version_id = version.id

    const app = createApp()
    const response = await request(app)
      .post(`/api/approval-templates/${template.id}/publish`)
      .send({
        policy: {
          allowRevoke: true,
          revokeBeforeNodeKeys: ['approve_1'],
        },
      })

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('published')
    expect(response.body.publishedDefinitionId).toMatch(/^pub-/)
    expect(response.body.runtimeGraph.policy).toEqual({
      allowRevoke: true,
      revokeBeforeNodeKeys: ['approve_1'],
    })
    expect(response.body.runtimeGraph.nodes[1].config).toEqual({
      assigneeType: 'role',
      assigneeIds: ['manager'],
      approvalMode: 'any',
      emptyAssigneePolicy: 'error',
    })
    expect(routeState.state.templates.get(template.id)?.active_version_id).toBe(version.id)
  })

  it('lists templates and fetches version detail', async () => {
    const template = routeState.createTemplateFixture()
    const version = routeState.createVersionFixture(template.id)
    const publishedDefinition: PublishedDefinitionRow = {
      id: 'pub-1',
      template_id: template.id,
      template_version_id: version.id,
      runtime_graph: {
        ...version.approval_graph,
        policy: { allowRevoke: false },
      },
      is_active: true,
      published_at: new Date('2026-04-11T12:00:00.000Z'),
    }
    template.latest_version_id = version.id
    template.active_version_id = version.id
    template.status = 'published'
    version.status = 'published'
    routeState.state.publishedDefinitions.set(publishedDefinition.id, publishedDefinition)

    const app = createApp()

    const listResponse = await request(app).get('/api/approval-templates?page=1&pageSize=20')
    expect(listResponse.status).toBe(200)
    expect(listResponse.body.total).toBe(1)
    expect(listResponse.body.data[0].id).toBe(template.id)

    const versionResponse = await request(app).get(`/api/approval-templates/${template.id}/versions/${version.id}`)
    expect(versionResponse.status).toBe(200)
    expect(versionResponse.body.id).toBe(version.id)
    expect(versionResponse.body.runtimeGraph.policy.allowRevoke).toBe(false)
  })

  // B3-08 — 模板停用/启用 + 用量.
  describe('template archive/unarchive + usage (B3-08)', () => {
    it('archives a published template', async () => {
      const template = routeState.createTemplateFixture({ status: 'published' })
      const version = routeState.createVersionFixture(template.id, { status: 'published' })
      template.latest_version_id = version.id
      template.active_version_id = version.id

      const app = createApp()
      const response = await request(app).post(`/api/approval-templates/${template.id}/archive`)

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('archived')
      expect(routeState.state.templates.get(template.id)?.status).toBe('archived')
    })

    it('rejects archiving a draft template (state-machine guard)', async () => {
      const template = routeState.createTemplateFixture({ status: 'draft' })
      const version = routeState.createVersionFixture(template.id)
      template.latest_version_id = version.id

      const app = createApp()
      const response = await request(app).post(`/api/approval-templates/${template.id}/archive`)

      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('APPROVAL_TEMPLATE_ARCHIVE_INVALID_STATUS')
      // Non-vacuous: the template must still be 'draft' — the guard actually blocked the write.
      expect(routeState.state.templates.get(template.id)?.status).toBe('draft')
    })

    it('unarchives an archived template back to published', async () => {
      const template = routeState.createTemplateFixture({ status: 'archived' })
      const version = routeState.createVersionFixture(template.id, { status: 'published' })
      template.latest_version_id = version.id
      template.active_version_id = version.id

      const app = createApp()
      const response = await request(app).post(`/api/approval-templates/${template.id}/unarchive`)

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('published')
      expect(routeState.state.templates.get(template.id)?.status).toBe('published')
    })

    it('rejects unarchiving a template that is not archived', async () => {
      const template = routeState.createTemplateFixture({ status: 'published' })
      const version = routeState.createVersionFixture(template.id, { status: 'published' })
      template.latest_version_id = version.id
      template.active_version_id = version.id

      const app = createApp()
      const response = await request(app).post(`/api/approval-templates/${template.id}/unarchive`)

      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('APPROVAL_TEMPLATE_UNARCHIVE_INVALID_STATUS')
      expect(routeState.state.templates.get(template.id)?.status).toBe('published')
    })

    it('404s archiving/unarchiving a template that does not exist', async () => {
      const app = createApp()
      const archiveResponse = await request(app).post('/api/approval-templates/tpl-missing/archive')
      expect(archiveResponse.status).toBe(404)
      expect(archiveResponse.body.error.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')

      const unarchiveResponse = await request(app).post('/api/approval-templates/tpl-missing/unarchive')
      expect(unarchiveResponse.status).toBe(404)
      expect(unarchiveResponse.body.error.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')
    })

    it('reports usage counts (total + still-in-flight) for the archive confirm dialog', async () => {
      const template = routeState.createTemplateFixture({ status: 'published' })
      routeState.createInstanceFixture(template.id, { status: 'pending' })
      routeState.createInstanceFixture(template.id, { status: 'pending' })
      routeState.createInstanceFixture(template.id, { status: 'approved' })
      // A different template's instances must not leak into this count.
      const otherTemplate = routeState.createTemplateFixture({ status: 'published' })
      routeState.createInstanceFixture(otherTemplate.id, { status: 'pending' })

      const app = createApp()
      const response = await request(app).get(`/api/approval-templates/${template.id}/usage`)

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        templateId: template.id,
        instanceCount: 3,
        activeInstanceCount: 2,
      })
    })

    it('reports zero usage for a template with no instances', async () => {
      const template = routeState.createTemplateFixture({ status: 'published' })

      const app = createApp()
      const response = await request(app).get(`/api/approval-templates/${template.id}/usage`)

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        templateId: template.id,
        instanceCount: 0,
        activeInstanceCount: 0,
      })
    })

    it('404s usage for a template that does not exist', async () => {
      const app = createApp()
      const response = await request(app).get('/api/approval-templates/tpl-missing/usage')
      expect(response.status).toBe(404)
      expect(response.body.error.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')
    })
  })

  // B3-09 (模板治理 — 版本历史 + 发布说明)
  describe('B3-09 version history + publish note', () => {
    function publishableTemplate() {
      const template = routeState.createTemplateFixture()
      const version = routeState.createVersionFixture(template.id)
      template.latest_version_id = version.id
      return { template, version }
    }

    const validPolicy = { allowRevoke: false }

    it('persists a trimmed publish note and returns it on the version detail', async () => {
      const { template, version } = publishableTemplate()
      const app = createApp()

      const response = await request(app)
        .post(`/api/approval-templates/${template.id}/publish`)
        .send({ policy: validPolicy, note: '  修复报销金额上限条件  ' })

      expect(response.status).toBe(200)
      expect(response.body.publishNote).toBe('修复报销金额上限条件')
      expect(routeState.state.versions.get(version.id)?.publish_note).toBe('修复报销金额上限条件')
    })

    it('publishes without a note exactly as before (publishNote null)', async () => {
      const { template, version } = publishableTemplate()
      const app = createApp()

      const response = await request(app)
        .post(`/api/approval-templates/${template.id}/publish`)
        .send({ policy: validPolicy })

      expect(response.status).toBe(200)
      expect(response.body.publishNote).toBeNull()
      expect(routeState.state.versions.get(version.id)?.publish_note).toBeNull()
    })

    it('rejects an over-length note with 400 BEFORE opening a transaction (fail-fast, nothing written)', async () => {
      const { template, version } = publishableTemplate()
      const app = createApp()

      const response = await request(app)
        .post(`/api/approval-templates/${template.id}/publish`)
        .send({ policy: validPolicy, note: 'x'.repeat(2001) })

      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('VALIDATION_ERROR')
      // normalizeTemplatePublishNote throws before pool.connect() — the same pre-transaction
      // ordering discipline as the policy validator. No client checkout, no status flip.
      expect(routeState.pool.connect).not.toHaveBeenCalled()
      expect(routeState.state.versions.get(version.id)?.status).toBe('draft')
    })

    it('409s publishing an ARCHIVED template (no silent reactivation bypassing 启用)', async () => {
      const template = routeState.createTemplateFixture({ status: 'archived' })
      const version = routeState.createVersionFixture(template.id)
      template.latest_version_id = version.id

      const app = createApp()
      const response = await request(app)
        .post(`/api/approval-templates/${template.id}/publish`)
        .send({ policy: validPolicy })

      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('APPROVAL_TEMPLATE_ARCHIVED')
      // fail-closed: nothing flipped
      expect(routeState.state.templates.get(template.id)?.status).toBe('archived')
      expect(routeState.state.versions.get(version.id)?.status).toBe('draft')
    })

    it('rejects a non-string note with 400', async () => {
      const { template } = publishableTemplate()
      const app = createApp()

      const response = await request(app)
        .post(`/api/approval-templates/${template.id}/publish`)
        .send({ policy: validPolicy, note: 42 })

      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('lists versions newest-first as summary rows (publishNote + active definition id, NO schema/graph payloads)', async () => {
      const template = routeState.createTemplateFixture({ status: 'published' })
      const v1 = routeState.createVersionFixture(template.id, {
        version: 1,
        status: 'published',
        publish_note: '首次发布',
      })
      const v2 = routeState.createVersionFixture(template.id, { version: 2, status: 'draft' })
      template.latest_version_id = v2.id
      template.active_version_id = v1.id
      // v1 carries the ACTIVE published definition; a superseded (inactive) one must not surface.
      routeState.state.publishedDefinitions.set('pub-active', {
        id: 'pub-active',
        template_id: template.id,
        template_version_id: v1.id,
        runtime_graph: {},
        is_active: true,
        published_at: new Date('2026-04-11T12:00:00.000Z'),
      })
      // Another template's versions must not leak into this list.
      const other = routeState.createTemplateFixture()
      routeState.createVersionFixture(other.id, { version: 9 })

      const app = createApp()
      const response = await request(app).get(`/api/approval-templates/${template.id}/versions`)

      expect(response.status).toBe(200)
      expect(response.body.versions).toHaveLength(2)
      expect(response.body.versions.map((row: { version: number }) => row.version)).toEqual([2, 1])
      expect(response.body.versions[1]).toMatchObject({
        id: v1.id,
        templateId: template.id,
        status: 'published',
        publishNote: '首次发布',
        publishedDefinitionId: 'pub-active',
      })
      expect(response.body.versions[0]).toMatchObject({
        id: v2.id,
        status: 'draft',
        publishNote: null,
        publishedDefinitionId: null,
      })
      // Summary shape — pin the EXACT key set (review P3-2: a `...row` spread would leak the
      // snake_case form_schema/approval_graph blobs while camelCase-absence checks stayed green).
      expect(Object.keys(response.body.versions[0]).sort()).toEqual([
        'createdAt',
        'id',
        'publishNote',
        'publishedDefinitionId',
        'status',
        'templateId',
        'updatedAt',
        'version',
      ])
    })

    it('404s the versions list for a template that does not exist', async () => {
      const app = createApp()
      const response = await request(app).get('/api/approval-templates/tpl-missing/versions')
      expect(response.status).toBe(404)
      expect(response.body.error.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')
    })

    it('403s the versions list for a non-admin (approvalTemplateAdminGuard, not just authenticate)', async () => {
      const { template } = publishableTemplate()
      authState.currentUser = {
        id: 'plain-user',
        sub: 'plain-user',
        name: 'Plain User',
        email: 'plain@example.com',
        permissions: ['approvals:read', 'approvals:write'],
        roles: ['user'],
      }

      const app = createApp()
      const response = await request(app).get(`/api/approval-templates/${template.id}/versions`)

      expect(response.status).toBe(403)
    })
  })
})
