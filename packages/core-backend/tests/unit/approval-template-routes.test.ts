import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type TemplateRow = {
  id: string
  key: string
  name: string
  description: string | null
  category: string | null
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

const routeState = vi.hoisted(() => {
  const now = () => new Date('2026-04-11T12:00:00.000Z')

  const state = {
    templates: new Map<string, TemplateRow>(),
    versions: new Map<string, TemplateVersionRow>(),
    publishedDefinitions: new Map<string, PublishedDefinitionRow>(),
    templateSeq: 1,
    versionSeq: 1,
    publishedSeq: 1,
  }

  function reset() {
    state.templates.clear()
    state.versions.clear()
    state.publishedDefinitions.clear()
    state.templateSeq = 1
    state.versionSeq = 1
    state.publishedSeq = 1
  }

  function createTemplateFixture(overrides?: Partial<TemplateRow>) {
    const timestamp = now()
    const template: TemplateRow = {
      id: `tpl-${state.templateSeq++}`,
      key: 'travel-request',
      name: 'Travel Request',
      description: 'Base template',
      category: null,
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

    if (normalized.startsWith('SELECT COUNT(*)::text AS count FROM approval_templates')) {
      return { rows: [{ count: String(state.templates.size) }], rowCount: 1 }
    }

    if (
      normalized.startsWith('SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE')
      || normalized.startsWith('SELECT * FROM approval_templates WHERE id = $1')
    ) {
      const row = state.templates.get(String(params[0]))
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
      // Wave 2 WP4 slice 1 — production SQL is:
      //   INSERT INTO approval_templates (key, name, description, category, status)
      //   VALUES ($1, $2, $3, $4, 'draft')
      const row: TemplateRow = {
        id: `tpl-${state.templateSeq++}`,
        key: String(params[0]),
        name: String(params[1]),
        description: params[2] == null ? null : String(params[2]),
        category: params[3] == null ? null : String(params[3]),
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
      row.updated_at = now()
      return { rows: [row], rowCount: 1 }
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
    pool,
  }
})

vi.mock('../../src/db/pg', () => ({
  pool: routeState.pool,
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: 'template-admin',
      sub: 'template-admin',
      name: 'Template Admin',
      email: 'template@example.com',
      permissions: ['*:*'],
      roles: ['admin'],
    } as never
    next()
  },
}))

import { approvalsRouter } from '../../src/routes/approvals'

describe('approval template routes', () => {
  beforeEach(() => {
    routeState.reset()
    routeState.pool.query.mockClear()
    routeState.pool.connect.mockClear()
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
          fields: [{ id: 'amount', type: 'number', label: 'Amount', required: true }],
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
    expect(response.body.formSchema.fields).toHaveLength(1)
    expect(response.body.approvalGraph.nodes[1].config).toEqual({
      assigneeType: 'role',
      assigneeIds: ['finance'],
      approvalMode: 'all',
      emptyAssigneePolicy: 'auto-approve',
    })
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
})
