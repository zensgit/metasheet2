import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'

type JsonRecord = Record<string, unknown>

type ApprovalRecordRow = {
  action: string
  actor_id: string | null
  to_status: string
  metadata: JsonRecord
}

type ApprovalAssignmentRow = {
  assignee_id: string
  is_active: boolean
  metadata: JsonRecord | null
}

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

/**
 * The schema bootstrap mirrors approval-pack1a-lifecycle.api.test.ts. Keeping the
 * duplication localized (rather than extracting to a shared helper) matches how the
 * existing suite is structured and avoids cross-file test coupling.
 */
async function ensureApprovalTables() {
  const pool = poolManager.get()
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS approval_instances (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS source_system TEXT`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS external_approval_id TEXT`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS workflow_key TEXT`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS business_key TEXT`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS title TEXT`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS requester_snapshot JSONB`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS subject_snapshot JSONB`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS policy_snapshot JSONB`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS metadata JSONB`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS current_step INTEGER`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS total_steps INTEGER`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS sync_status TEXT`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS sync_error TEXT`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS template_id UUID`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS template_version_id UUID`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS published_definition_id UUID`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS request_no TEXT`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS form_snapshot JSONB`)
  await pool.query(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS current_node_key TEXT`)
  await pool.query(`
    UPDATE approval_instances
    SET source_system = COALESCE(source_system, 'platform'),
        requester_snapshot = COALESCE(requester_snapshot, '{}'::jsonb),
        subject_snapshot = COALESCE(subject_snapshot, '{}'::jsonb),
        policy_snapshot = COALESCE(policy_snapshot, '{}'::jsonb),
        metadata = COALESCE(metadata, '{}'::jsonb),
        current_step = COALESCE(current_step, 0),
        total_steps = COALESCE(total_steps, 0),
        sync_status = COALESCE(sync_status, 'ok')
  `)
  await pool.query(`ALTER TABLE approval_instances ALTER COLUMN source_system SET DEFAULT 'platform'`)
  await pool.query(`ALTER TABLE approval_instances ALTER COLUMN requester_snapshot SET DEFAULT '{}'::jsonb`)
  await pool.query(`ALTER TABLE approval_instances ALTER COLUMN subject_snapshot SET DEFAULT '{}'::jsonb`)
  await pool.query(`ALTER TABLE approval_instances ALTER COLUMN policy_snapshot SET DEFAULT '{}'::jsonb`)
  await pool.query(`ALTER TABLE approval_instances ALTER COLUMN metadata SET DEFAULT '{}'::jsonb`)
  await pool.query(`ALTER TABLE approval_instances ALTER COLUMN current_step SET DEFAULT 0`)
  await pool.query(`ALTER TABLE approval_instances ALTER COLUMN total_steps SET DEFAULT 0`)
  await pool.query(`ALTER TABLE approval_instances ALTER COLUMN sync_status SET DEFAULT 'ok'`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_instances_source_external ON approval_instances(source_system, external_approval_id) WHERE external_approval_id IS NOT NULL`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_approval_instances_status_updated ON approval_instances(status, updated_at DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_approval_instances_source_status ON approval_instances(source_system, status, updated_at DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_approval_instances_workflow_business ON approval_instances(workflow_key, business_key)`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_instances_request_no ON approval_instances(request_no) WHERE request_no IS NOT NULL`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_approval_instances_template_status ON approval_instances(template_id, status, updated_at DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_approval_instances_published_definition ON approval_instances(published_definition_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS approval_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id TEXT NOT NULL REFERENCES approval_instances(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      actor_id TEXT,
      actor_name TEXT,
      comment TEXT NULL,
      reason TEXT NULL,
      from_status TEXT NULL,
      to_status TEXT NOT NULL,
      version INT NULL,
      from_version INT NULL,
      to_version INT NOT NULL DEFAULT 0,
      target_user_id TEXT NULL,
      target_step_id TEXT NULL,
      attachments JSONB DEFAULT '[]'::jsonb,
      metadata JSONB DEFAULT '{}'::jsonb,
      ip_address INET,
      user_agent TEXT,
      platform TEXT DEFAULT 'web',
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS actor_name TEXT`)
  await pool.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS reason TEXT`)
  await pool.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS version INT`)
  await pool.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS from_version INT`)
  await pool.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS to_version INT NOT NULL DEFAULT 0`)
  await pool.query(`ALTER TABLE approval_records ALTER COLUMN to_version SET DEFAULT 0`)
  await pool.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS target_user_id TEXT`)
  await pool.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS target_step_id TEXT`)
  await pool.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb`)
  await pool.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`)
  await pool.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS ip_address INET`)
  await pool.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS user_agent TEXT`)
  await pool.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'web'`)
  await pool.query(`ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()`)
  await pool.query(`ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check`)
  await pool.query(`
    ALTER TABLE approval_records
    ADD CONSTRAINT approval_records_action_check
    CHECK (action IN ('created', 'approve', 'reject', 'return', 'revoke', 'transfer', 'sign', 'comment', 'cc'))
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_approval_records_instance ON approval_records(instance_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_approval_records_instance_action_time ON approval_records(instance_id, action, occurred_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS approval_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id TEXT NOT NULL REFERENCES approval_instances(id) ON DELETE CASCADE,
      assignment_type TEXT NOT NULL CHECK (assignment_type IN ('user', 'role', 'source_queue')),
      assignee_id TEXT NOT NULL,
      source_step INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`ALTER TABLE approval_assignments ADD COLUMN IF NOT EXISTS node_key TEXT`)
  await pool.query(`
    DO $$
    DECLARE
      record_row RECORD;
    BEGIN
      FOR record_row IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'approval_assignments'::regclass
          AND contype = 'u'
      LOOP
        EXECUTE format('ALTER TABLE approval_assignments DROP CONSTRAINT IF EXISTS %I', record_row.conname);
      END LOOP;
    END $$;
  `)
  await pool.query(`DROP INDEX IF EXISTS idx_approval_assignments_active_unique`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_assignments_active_unique ON approval_assignments(instance_id, assignment_type, assignee_id) WHERE is_active = TRUE`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_approval_assignments_lookup ON approval_assignments(assignment_type, assignee_id, is_active)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_approval_assignments_instance ON approval_assignments(instance_id, is_active)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS approval_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
      active_version_id UUID,
      latest_version_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS approval_template_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      template_id UUID NOT NULL REFERENCES approval_templates(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
      form_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
      approval_graph JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (template_id, version)
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS approval_published_definitions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      template_id UUID NOT NULL REFERENCES approval_templates(id) ON DELETE CASCADE,
      template_version_id UUID NOT NULL REFERENCES approval_template_versions(id) ON DELETE CASCADE,
      runtime_graph JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`
    DO $$
    BEGIN
      ALTER TABLE approval_templates
        ADD CONSTRAINT approval_templates_active_version_fk
        FOREIGN KEY (active_version_id) REFERENCES approval_template_versions(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `)
  await pool.query(`
    DO $$
    BEGIN
      ALTER TABLE approval_templates
        ADD CONSTRAINT approval_templates_latest_version_fk
        FOREIGN KEY (latest_version_id) REFERENCES approval_template_versions(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_approval_templates_status_updated ON approval_templates(status, updated_at DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_approval_template_versions_template ON approval_template_versions(template_id, version DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_approval_published_definitions_template_version ON approval_published_definitions(template_version_id, published_at DESC)`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_published_definitions_active_template ON approval_published_definitions(template_id) WHERE is_active = TRUE`)

  await pool.query(`CREATE SEQUENCE IF NOT EXISTS approval_request_no_seq START WITH 100001 INCREMENT BY 1`)
}

async function authToken(baseUrl: string, userId: string): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
  )
  expect(response.status).toBe(200)
  const payload = await response.json() as { token: string }
  return payload.token
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  token: string,
  options: {
    method?: string
    body?: unknown
  } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  return response
}

function buildFormSchema() {
  return {
    fields: [
      {
        id: 'reason',
        type: 'text',
        label: '事由',
        required: true,
      },
    ],
  }
}

function buildAnyModeGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_any',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: ['approver-a', 'approver-b'],
          approvalMode: 'any',
        },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-any', source: 'start', target: 'approval_any' },
      { key: 'edge-any-end', source: 'approval_any', target: 'end' },
    ],
  }
}

describe('Approval Wave 2 WP1 any-mode (或签) API', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()

  beforeAll(async () => {
    const canListen = await canListenOnEphemeralPort()
    expect(canListen).toBe(true)

    await ensureApprovalTables()

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
      const approvalIds = [...createdApprovalIds]
      const templateIds = [...createdTemplateIds]
      if (approvalIds.length > 0) {
        await pool.query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [approvalIds])
      }
      if (templateIds.length > 0) {
        await pool.query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool.query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool.query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templateIds])
      }
    } catch {
      // Ignore cleanup failures — the top-level describe restart clears everything on rerun.
    }

    if (server) {
      await server.stop()
    }
  })

  it('advances an any-mode approval on the first approver and cancels siblings with audit metadata', async () => {
    const adminToken = await authToken(baseUrl, 'approval-admin-any')
    const requesterToken = await authToken(baseUrl, 'requester-any')
    const approverAToken = await authToken(baseUrl, 'approver-a')
    const approverBToken = await authToken(baseUrl, 'approver-b')
    const templateKey = `approval-wp1-any-${Date.now()}`

    const templateResponse = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Any Mode Template',
        description: 'approvalMode=any integration',
        formSchema: buildFormSchema(),
        approvalGraph: buildAnyModeGraph(),
      },
    })
    expect(templateResponse.status).toBe(201)
    const template = await templateResponse.json() as { id: string }
    createdTemplateIds.add(template.id)

    const publishResponse = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(publishResponse.status).toBe(200)

    const createResponse = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: {
        templateId: template.id,
        formData: { reason: 'any-mode request' },
      },
    })
    expect(createResponse.status).toBe(201)
    const createdApproval = await createResponse.json() as {
      id: string
      status: string
      currentNodeKey: string | null
      assignments: Array<{ assigneeId: string; isActive: boolean; nodeKey?: string | null }>
    }
    createdApprovalIds.add(createdApproval.id)
    expect(createdApproval.status).toBe('pending')
    expect(createdApproval.currentNodeKey).toBe('approval_any')
    expect(
      createdApproval.assignments
        .filter((assignment) => assignment.isActive)
        .map((assignment) => assignment.assigneeId)
        .sort(),
    ).toEqual(['approver-a', 'approver-b'])

    const approveResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, approverAToken, {
      method: 'POST',
      body: {
        action: 'approve',
        comment: 'approver-a wins',
      },
    })
    expect(approveResponse.status).toBe(200)
    const completedApproval = await approveResponse.json() as {
      status: string
      currentNodeKey: string | null
      assignments: Array<{ assigneeId: string; isActive: boolean; metadata?: JsonRecord }>
    }
    expect(completedApproval.status).toBe('approved')
    expect(completedApproval.currentNodeKey).toBeNull()
    expect(completedApproval.assignments.filter((assignment) => assignment.isActive)).toHaveLength(0)

    const pool = poolManager.get()
    const assignmentResult = await pool.query<ApprovalAssignmentRow>(
      `SELECT assignee_id, is_active, metadata
       FROM approval_assignments
       WHERE instance_id = $1
       ORDER BY assignee_id ASC`,
      [createdApproval.id],
    )
    const approverBRow = assignmentResult.rows.find((row) => row.assignee_id === 'approver-b')
    expect(approverBRow).toBeTruthy()
    expect(approverBRow?.is_active).toBe(false)
    expect(approverBRow?.metadata).toMatchObject({
      aggregateCancelledBy: 'approver-a',
      aggregateMode: 'any',
    })
    expect(typeof (approverBRow?.metadata as JsonRecord | undefined)?.aggregateCancelledAt).toBe('string')

    const approverARow = assignmentResult.rows.find((row) => row.assignee_id === 'approver-a')
    expect(approverARow?.is_active).toBe(false)
    // approver-a's own row should NOT carry aggregateCancelledBy — that metadata is reserved for siblings.
    expect((approverARow?.metadata as JsonRecord | undefined)?.aggregateCancelledBy).toBeUndefined()

    const approveRecordsResult = await pool.query<ApprovalRecordRow>(
      `SELECT action, actor_id, to_status, metadata
       FROM approval_records
       WHERE instance_id = $1 AND action = 'approve'
       ORDER BY to_version ASC, created_at ASC`,
      [createdApproval.id],
    )
    expect(approveRecordsResult.rows).toHaveLength(1)
    expect(approveRecordsResult.rows[0]?.actor_id).toBe('approver-a')
    expect(approveRecordsResult.rows[0]?.to_status).toBe('approved')
    expect(approveRecordsResult.rows[0]?.metadata).toMatchObject({
      nodeKey: 'approval_any',
      nextNodeKey: null,
      approvalMode: 'any',
      aggregateComplete: true,
      aggregateCancelled: ['approver-b'],
    })

    const signRecordsResult = await pool.query<ApprovalRecordRow>(
      `SELECT action, actor_id, to_status, metadata
       FROM approval_records
       WHERE instance_id = $1 AND action = 'sign'
       ORDER BY created_at ASC`,
      [createdApproval.id],
    )
    expect(signRecordsResult.rows).toHaveLength(1)
    expect(signRecordsResult.rows[0]?.actor_id).toBe('system')
    expect(signRecordsResult.rows[0]?.metadata).toMatchObject({
      nodeKey: 'approval_any',
      autoCancelled: true,
      aggregateMode: 'any',
      aggregateCancelledBy: 'approver-a',
      cancelledAssignees: ['approver-b'],
    })

    // approver-b attempting to approve afterward should be rejected — the active assignment is gone.
    const lateApproveResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, approverBToken, {
      method: 'POST',
      body: {
        action: 'approve',
        comment: 'too late',
      },
    })
    expect(lateApproveResponse.status).toBe(403)
    const errorPayload = await lateApproveResponse.json() as { error?: { code?: string } }
    expect(errorPayload.error?.code).toBe('APPROVAL_ASSIGNMENT_REQUIRED')

    const timelineResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/history`, approverAToken)
    expect(timelineResponse.status).toBe(200)
    const timelinePayload = await timelineResponse.json() as {
      ok: boolean
      data: { items: Array<{ action: string; metadata?: JsonRecord }> }
    }
    const actions = timelinePayload.data.items.map((item) => item.action)
    expect(actions).toContain('approve')
    expect(actions).toContain('sign')
  })
})
