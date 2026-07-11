/**
 * RP-1 — route-preview shared substrate (route-preview lock, RATIFIED RP-0; owner order:
 * substrate + read-only walk + consistency golden ONLY, no UI surfaces).
 *
 * The lock's hardest proof: preview === create on the SAME database at the SAME instant —
 * because both consume ONE assembly (assembleCreationContext), per-node assignees the preview
 * reports must equal the assignments createApproval then persists. Plus: delegation consistency,
 * per-node fault tolerance (EMPTY_ASSIGNEES marker, no 500), the formData whitelist hard gate
 * (owner order: no org-probing params through the read-only walk), and ZERO-WRITE proof
 * (instances/assignments/records row counts unchanged by preview).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '../../src/db/pg'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => pool.query(sql, params)

const TS = Date.now()
const REQUESTER = `u_rp1_req_${TS}`
const APPROVER = `u_rp1_appr_${TS}`
const DELEGATEE = `u_rp1_dele_${TS}`

let approvals: ApprovalProductService
let templateId = ''
let emptyTemplateId = ''

const requesterActor = { userId: REQUESTER, userName: REQUESTER, roles: [] as string[], permissions: ['approvals:write'] }

describeIfDatabase('RP-1 — route-preview substrate (real DB)', () => {
  beforeAll(async () => {
    await q(`INSERT INTO permissions (code, name, description) VALUES ('approvals:write','w','t'),('approvals:act','a','t') ON CONFLICT (code) DO NOTHING`)
    for (const uid of [REQUESTER, APPROVER, DELEGATEE]) {
      await q(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
               VALUES ($1,$2,$1,'x','user','[]'::jsonb,TRUE,FALSE) ON CONFLICT (id) DO UPDATE SET is_active = TRUE`, [uid, `${uid}@rp1.test`])
    }
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:write') ON CONFLICT DO NOTHING`, [REQUESTER])

    approvals = new ApprovalProductService()
    const template = await approvals.createTemplate({
      key: `rp1-${TS}`,
      name: 'RP1 Preview Template',
      formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: 'Start', config: {} },
          { key: 'approval_1', type: 'approval', name: '一级审批', config: { mode: 'any', assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }] } },
          { key: 'approval_2', type: 'approval', name: '二级审批', config: { mode: 'any', assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }] } },
          { key: 'end', type: 'end', name: 'End', config: {} },
        ],
        edges: [
          { key: 'e1', source: 'start', target: 'approval_1' },
          { key: 'e2', source: 'approval_1', target: 'approval_2' },
          { key: 'e3', source: 'approval_2', target: 'end' },
        ],
      },
    } as never, { userId: REQUESTER, userName: REQUESTER } as never)
    templateId = (template as { id: string }).id
    await approvals.publishTemplate(templateId, { policy: { allowRevoke: true } } as never)

    // A template whose approval node resolves NOBODY (empty static list) — the fault-tolerance
    // fixture. skip-empty policy keeps publish/create legal where applicable; the preview must
    // mark, not throw.
    const emptyTemplate = await approvals.createTemplate({
      key: `rp1e-${TS}`,
      name: 'RP1 Empty Assignee Template',
      formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: 'Start', config: {} },
          // Publish-legal but RUNTIME-empty: direct_manager for a requester with no manager row.
          { key: 'approval_1', type: 'approval', name: '无人节点', config: { mode: 'any', assigneeSources: [{ kind: 'direct_manager' }], emptyAssigneePolicy: 'auto-approve' } },
          { key: 'end', type: 'end', name: 'End', config: {} },
        ],
        edges: [
          { key: 'e1', source: 'start', target: 'approval_1' },
          { key: 'e2', source: 'approval_1', target: 'end' },
        ],
      },
    } as never, { userId: REQUESTER, userName: REQUESTER } as never)
    emptyTemplateId = (emptyTemplate as { id: string }).id
    await approvals.publishTemplate(emptyTemplateId, { policy: { allowRevoke: true } } as never)
  })

  afterAll(async () => {
    for (const tid of [templateId, emptyTemplateId]) {
      const instances = await q('SELECT id FROM approval_instances WHERE template_id = $1', [tid]).catch(() => ({ rows: [] as unknown[] }))
      for (const row of instances.rows as Array<{ id: string }>) {
        await q('DELETE FROM approval_assignments WHERE instance_id = $1', [row.id]).catch(() => {})
        await q('DELETE FROM approval_records WHERE instance_id = $1', [row.id]).catch(() => {})
        await q('DELETE FROM approval_instances WHERE id = $1', [row.id]).catch(() => {})
      }
      await q('DELETE FROM approval_templates WHERE id = $1', [tid]).catch(() => {})
    }
    await q('DELETE FROM approval_delegations WHERE delegator_user_id = $1', [APPROVER]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[REQUESTER]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[REQUESTER, APPROVER, DELEGATEE]]).catch(() => {})
  })

  it('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  it('GOLDEN: preview === create — per-node assignees match the persisted assignments (same DB, same instant)', async () => {
    const request = { templateId, formData: { summary: 'consistency run' } }
    const preview = await approvals.previewApprovalRoute(request, requesterActor as never)
    expect(preview.truncated).toBe(false)
    expect(preview.route.map((n) => n.nodeKey)).toEqual(['approval_1', 'approval_2'])
    expect(preview.route[0]!.nodeLabel).toBe('一级审批')

    const created = await approvals.createApproval(request as never, requesterActor as never)
    const persisted = await q(
      `SELECT node_key, assignee_id, assignment_type FROM approval_assignments WHERE instance_id = $1 AND node_key = $2`,
      [(created as { id: string }).id, 'approval_1'],
    )
    const persistedSet = (persisted.rows as Array<{ assignee_id: string; assignment_type: string }>)
      .map((row) => `${row.assignment_type}:${row.assignee_id}`).sort()
    const previewSet = preview.route[0]!.assignees.map((a) => `${a.assignmentType}:${a.id}`).sort()
    expect(previewSet).toEqual(persistedSet)
    expect(previewSet).toEqual([`user:${APPROVER}`])
  })

  it('ZERO-WRITE: preview leaves instances/assignments/records row counts untouched', async () => {
    const count = async (table: string) => Number((await q(`SELECT count(*) AS c FROM ${table}`)).rows[0]!.c)
    const before = [await count('approval_instances'), await count('approval_assignments'), await count('approval_records')]
    await approvals.previewApprovalRoute({ templateId, formData: { summary: 'zero write' } }, requesterActor as never)
    const after = [await count('approval_instances'), await count('approval_assignments'), await count('approval_records')]
    // RED-before: plant any INSERT into the substrate/walk and this equality breaks.
    expect(after).toEqual(before)
  })

  it('DELEGATION consistency: an active window shows the delegatee in preview (same substitution as create)', async () => {
    await q(
      `INSERT INTO approval_delegations (id, delegator_user_id, delegatee_user_id, scope, scope_template_id, start_at, end_at, active)
       VALUES ($1,$2,$3,'all',NULL, now() - interval '1 hour', now() + interval '1 day', TRUE)`,
      [`rp1-dele-${TS}`, APPROVER, DELEGATEE],
    )
    try {
      const preview = await approvals.previewApprovalRoute({ templateId, formData: { summary: 'delegation run' } }, requesterActor as never)
      expect(preview.route[0]!.assignees.map((a) => a.id)).toEqual([DELEGATEE])
    } finally {
      await q('DELETE FROM approval_delegations WHERE id = $1', [`rp1-dele-${TS}`]).catch(() => {})
    }
  })

  it('FAULT TOLERANCE (auto-approve policy): runtime-empty node never 500s the preview', async () => {
    const preview = await approvals.previewApprovalRoute({ templateId: emptyTemplateId, formData: { summary: 'empty node' } }, requesterActor as never)
    // auto-approve either walks past the node (empty route) or surfaces it with the marker —
    // both are honest; the contract under test is NO THROW + a well-formed result.
    for (const node of preview.route) {
      if (node.assignees.length === 0) expect(node.resolveError).toBe('EMPTY_ASSIGNEES')
    }
    expect(typeof preview.truncated).toBe('boolean')
  })

  it('HARD GATE: unknown formData keys are whitelisted OUT of the preview walk (no org-probing smuggling)', async () => {
    const clean = await approvals.previewApprovalRoute({ templateId, formData: { summary: 'probe' } }, requesterActor as never)
    const probed = await approvals.previewApprovalRoute(
      { templateId, formData: { summary: 'probe', requesterId: 'someone_else', managerChainIds: ['x'], __proto__polluter: true } as never },
      requesterActor as never,
    )
    expect(probed.route).toEqual(clean.route)
    expect(probed.truncated).toBe(clean.truncated)
  })
})
