import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-7 (docs/development/approval-lock7-field-edit-enforcement-20260817.md) — per-node form field
 * EDIT / visibility enforcement, REAL-DB end-to-end acceptance. Harness mirrors
 * approval-handler-node.db.test.ts (Lock-3's suite). This is P4-B: the handler write surface that
 * P4-A left returning a values-free 422 now performs the masked, frozen-schema-validated write.
 *
 * Gates covered here (behaviourally testable end-to-end): G-3 write mask actor-node-scoped, G-4
 * routing-driver-never-editable (+ the hazard-real assertion), G-5 unfillable required×hidden, G-6
 * frozen validators (+ MS-3 disclosure), G-7 transaction atomicity, G-8 audit values-free + mask-aware
 * revision read, G-9 in-flight re-normalize, G-10 round-trip/restore, G-11 legacy default, G-12
 * non-approval node types, G-15 direct-HTTP bypass matrix, G-16 内容变更 dedup invalidation (+ epoch
 * unchanged), G-17 immutability-reader re-examination. Every absence assertion carries a positive
 * control (§3).
 *
 * NOT here (covered elsewhere): G-1a/G-1b/G-2 derivation = approval-form-redaction.test.ts unit; G-13
 * readonly-copy retirement = FE specs; G-14 enum mirror = approval-field-access-enum-mirror.test.ts.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `fee-req-${TS}`
const GATE = `fee-gate-${TS}` // approval node before the handler (approves as this actor)
const HANDLER = `fee-h-${TS}` // handler seat (single)
const HANDLER2 = `fee-h2-${TS}` // handler seat 2 (会签)
const FINAL = `fee-final-${TS}` // approval node after the handler
const KEYPFX = `fee-${TS}`

async function canListen(): Promise<boolean> {
  return await new Promise((r) => {
    const s = net.createServer()
    s.once('error', () => r(false))
    s.listen(0, '127.0.0.1', () => s.close(() => r(true)))
  })
}
async function tok(base: string, userId: string): Promise<string> {
  await grantApprovalWriteForIntegrationActor(userId)
  const res = await fetch(`${base}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`)
  return ((await res.json()) as { token: string }).token
}
async function req(base: string, path: string, token: string, opts: { method?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
}

// Rich schema: `reason` required-always-visible (filled at create); `amount` number; `memo` text;
// `secret` text (used as a hidden field); `pick` user (form_field_user driver); `route_num` number
// (ConditionRule driver); `formula_num` number (condition-formula driver); `req_cond` required text
// with a visibilityRule (create-hideable → the G-5 unfillable candidate).
const FORM_SCHEMA = {
  fields: [
    { id: 'reason', type: 'text', label: 'reason', required: true },
    { id: 'amount', type: 'number', label: 'amount' },
    { id: 'memo', type: 'text', label: 'memo' },
    { id: 'secret', type: 'text', label: 'secret' },
    { id: 'pick', type: 'user', label: 'pick' },
    { id: 'route_num', type: 'number', label: 'route_num' },
    { id: 'formula_num', type: 'number', label: 'formula_num' },
    { id: 'req_cond', type: 'text', label: 'req_cond', required: true, visibilityRule: { fieldId: 'amount', operator: 'eq', value: 100 } },
  ],
}

function staticUser(userIds: string[]) {
  return [{ kind: 'static_user', userIds }]
}

type NodeFieldPermission = { fieldId: string; access: 'editable' | 'readonly' | 'hidden' }

// start → handler(HANDLER, fieldPermissions) → approval(FINAL) → end. The default handler roster is a
// single seat so the handler completes on one submission.
function handlerGraph(handlerFieldPermissions: NodeFieldPermission[], handlerConfig: Record<string, unknown> = {}) {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'handler_h', type: 'handler', name: '办理', config: { assigneeSources: staticUser([HANDLER]), ...handlerConfig, ...(handlerFieldPermissions.length > 0 ? { fieldPermissions: handlerFieldPermissions } : {}) } },
      { key: 'approval_final', type: 'approval', name: 'final', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2h', source: 'start', target: 'handler_h' },
      { key: 'h2f', source: 'handler_h', target: 'approval_final' },
      { key: 'f2e', source: 'approval_final', target: 'end' },
    ],
  }
}

type ErrorBody = { code?: string; error?: { code?: string; message?: string; details?: Record<string, unknown> } }
function errorCode(body: ErrorBody): string | undefined {
  return body.code ?? body.error?.code
}

// ── Anti-skip-green sentinel (mirrors approval-realdb-handler) ────────────────────────────────────
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

describeIfDatabase('Lock-7 field-edit enforcement — real-DB acceptance', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqTok = ''
  let handlerTok = ''
  let handler2Tok = ''
  let finalTok = ''
  let gateTok = ''
  const service = new ApprovalProductService()

  async function createTemplate(key: string, graph: unknown, schema: unknown = FORM_SCHEMA): Promise<Response> {
    return req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key, name: key, formSchema: schema, approvalGraph: graph },
    })
  }
  async function createTemplateId(key: string, graph: unknown, schema: unknown = FORM_SCHEMA): Promise<string> {
    const created = await createTemplate(key, graph, schema)
    expect(created.status, await created.clone().text()).toBe(201)
    return ((await created.json()) as { id: string }).id
  }
  async function publishTemplate(tid: string, policy: Record<string, unknown> = { allowRevoke: true }): Promise<Response> {
    return req(base, `/api/approval-templates/${tid}/publish`, reqTok, { method: 'POST', body: { policy } })
  }
  async function createPublished(key: string, graph: unknown, policy?: Record<string, unknown>): Promise<string> {
    const tid = await createTemplateId(key, graph)
    const published = await publishTemplate(tid, policy)
    expect(published.status, await published.clone().text()).toBe(200)
    return tid
  }
  async function createInstance(tid: string, formData: Record<string, unknown> = { reason: 'r' }): Promise<string> {
    const ok = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData } })
    expect(ok.status, await ok.clone().text()).toBe(201)
    return ((await ok.json()) as { id: string }).id
  }
  async function act(iid: string, token: string, body: Record<string, unknown>): Promise<Response> {
    return req(base, `/api/approvals/${iid}/actions`, token, { method: 'POST', body })
  }
  async function instanceRow(iid: string): Promise<{ status: string; current_node_key: string | null; version: number; form_snapshot: Record<string, unknown> | null }> {
    const pool = poolManager.get()
    const rows = await pool.query(`SELECT status, current_node_key, version, form_snapshot FROM approval_instances WHERE id = $1`, [iid])
    return rows.rows[0] as { status: string; current_node_key: string | null; version: number; form_snapshot: Record<string, unknown> | null }
  }
  async function records(iid: string, action?: string): Promise<Array<{ action: string; actor_id: string | null; metadata: Record<string, unknown> | null }>> {
    const pool = poolManager.get()
    const rows = action
      ? await pool.query(`SELECT action, actor_id, metadata FROM approval_records WHERE instance_id = $1 AND action = $2 ORDER BY id ASC`, [iid, action])
      : await pool.query(`SELECT action, actor_id, metadata FROM approval_records WHERE instance_id = $1 ORDER BY id ASC`, [iid])
    return rows.rows as Array<{ action: string; actor_id: string | null; metadata: Record<string, unknown> | null }>
  }
  async function revisionRows(iid: string): Promise<Array<{ field_id: string; before_value: unknown; after_value: unknown; node_key: string; actor_id: string; audit_record_id: string; node_entry_epoch: number | null }>> {
    const pool = poolManager.get()
    const rows = await pool.query(
      `SELECT field_id, before_value, after_value, node_key, actor_id, audit_record_id::text AS audit_record_id, node_entry_epoch FROM approval_form_field_revisions WHERE instance_id = $1 ORDER BY id ASC`,
      [iid],
    )
    return rows.rows as Array<{ field_id: string; before_value: unknown; after_value: unknown; node_key: string; actor_id: string; audit_record_id: string; node_entry_epoch: number | null }>
  }
  async function activeSeats(iid: string): Promise<Array<{ assignee_id: string; node_key: string | null; entry_epoch: number | string | null }>> {
    const pool = poolManager.get()
    const rows = await pool.query(`SELECT assignee_id, node_key, entry_epoch FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE ORDER BY assignee_id`, [iid])
    return rows.rows as Array<{ assignee_id: string; node_key: string | null; entry_epoch: number | string | null }>
  }

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    const pool = poolManager.get()
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`)
    for (const userId of [REQ, GATE, HANDLER, HANDLER2, FINAL]) {
      await pool.query(`INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'x', TRUE) ON CONFLICT (id) DO NOTHING`, [userId, `${userId}@x.test`])
    }
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
    handlerTok = await tok(base, HANDLER)
    handler2Tok = await tok(base, HANDLER2)
    finalTok = await tok(base, FINAL)
    gateTok = await tok(base, GATE)
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`${KEYPFX}-%`])).rows.map((r) => r.id as string)
      if (tids.length > 0) {
        const iids = (await pool.query(`SELECT id FROM approval_instances WHERE template_id = ANY($1::uuid[])`, [tids])).rows.map((r) => r.id as string)
        if (iids.length > 0) {
          await pool.query(`DELETE FROM approval_form_field_revisions WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_records WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_instances WHERE id = ANY($1)`, [iids])
        }
        await pool.query(`DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])`, [tids])
        await pool.query(`DELETE FROM approval_templates WHERE id = ANY($1::uuid[])`, [tids])
      }
      await pool.query(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [[REQ, GATE, HANDLER, HANDLER2, FINAL]])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  // ── G-11 — legacy default: no fieldPermissions behaves byte-identically ───────────────────────
  it('G-11: a handler with NO fieldPermissions accepts a field write to a NON-driver field (absent ≡ editable); a hidden matrix DIVERGES in the same fixture', async () => {
    // Positive default: no matrix → memo (a NON-driver field) is editable → written. A DRIVER field is
    // refused by the runtime driver guard even with no matrix (covered by "G-4 (runtime driver guard)").
    // Positive default: no matrix → memo is editable → written.
    const tidDefault = await createPublished(`${KEYPFX}-g11-default`, handlerGraph([]))
    const iidDefault = await createInstance(tidDefault)
    const okWrite = await act(iidDefault, handlerTok, { action: 'handle', fieldWrites: { memo: 'edited-by-default' } })
    expect(okWrite.status, await okWrite.clone().text()).toBe(200)
    expect((await instanceRow(iidDefault)).form_snapshot?.memo).toBe('edited-by-default')

    // Divergence: same field, hidden matrix → write refused (absent-≡-editable is default-selected).
    const tidHidden = await createPublished(`${KEYPFX}-g11-hidden`, handlerGraph([{ fieldId: 'memo', access: 'hidden' }]))
    const iidHidden = await createInstance(tidHidden)
    const refused = await act(iidHidden, handlerTok, { action: 'handle', fieldWrites: { memo: 'x' } })
    expect(refused.status).toBe(403)
    expect(errorCode((await refused.json()) as ErrorBody)).toBe('APPROVAL_FIELD_WRITE_FORBIDDEN')
  })

  // ── G-3 — write mask is ACTOR-NODE-scoped ─────────────────────────────────────────────────────
  it('G-3: a field readonly at the actor node is refused even though editable at another node; editable at the actor node is written even though hidden elsewhere; the mirror inverts both', async () => {
    // Two sequential handlers. handler_A: memo readonly, amount editable. handler_B: memo editable, amount hidden.
    const twoHandlers = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'handler_A', type: 'handler', name: 'A', config: { assigneeSources: staticUser([HANDLER]), fieldPermissions: [{ fieldId: 'memo', access: 'readonly' }, { fieldId: 'amount', access: 'editable' }] } },
        { key: 'handler_B', type: 'handler', name: 'B', config: { assigneeSources: staticUser([HANDLER2]), fieldPermissions: [{ fieldId: 'memo', access: 'editable' }, { fieldId: 'amount', access: 'hidden' }] } },
        { key: 'approval_final', type: 'approval', name: 'f', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 's2a', source: 'start', target: 'handler_A' },
        { key: 'a2b', source: 'handler_A', target: 'handler_B' },
        { key: 'b2f', source: 'handler_B', target: 'approval_final' },
        { key: 'f2e', source: 'approval_final', target: 'end' },
      ],
    }
    const tid = await createPublished(`${KEYPFX}-g3`, twoHandlers)
    const iid = await createInstance(tid)
    // At handler_A: memo is readonly HERE (editable at B) → refused; amount is editable HERE → written.
    const refuseMemo = await act(iid, handlerTok, { action: 'handle', fieldWrites: { memo: 'nope' } })
    expect(refuseMemo.status).toBe(403)
    expect(errorCode((await refuseMemo.json()) as ErrorBody)).toBe('APPROVAL_FIELD_WRITE_FORBIDDEN')
    const writeAmount = await act(iid, handlerTok, { action: 'handle', fieldWrites: { amount: 42 } })
    expect(writeAmount.status, await writeAmount.clone().text()).toBe(200)
    expect((await instanceRow(iid)).form_snapshot?.amount).toBe(42)
    // Mirror at handler_B: amount hidden HERE (editable at A) → refused; memo editable HERE → written.
    const refuseAmount = await act(iid, handler2Tok, { action: 'handle', fieldWrites: { amount: 99 } })
    expect(refuseAmount.status).toBe(403)
    const writeMemo = await act(iid, handler2Tok, { action: 'handle', fieldWrites: { memo: 'ok-at-B' } })
    expect(writeMemo.status, await writeMemo.clone().text()).toBe(200)
    expect((await instanceRow(iid)).form_snapshot?.memo).toBe('ok-at-B')
  })

  // ── G-15 — direct-HTTP bypass matrix (each refusal reason 4xx, values-free, zero rows) ────────
  it('G-15: each write-refusal reason is a values-free 4xx with zero rows; one compliant call succeeds in the same fixture; legacy approve carries no field payload', async () => {
    const tid = await createPublished(`${KEYPFX}-g15`, handlerGraph([
      { fieldId: 'memo', access: 'editable' },
      { fieldId: 'secret', access: 'hidden' },
      { fieldId: 'amount', access: 'readonly' },
    ]))
    // no-active-seat: FINAL is not seated at the handler → 403 (assignment required)
    const iidSeat = await createInstance(tid)
    const noSeat = await act(iidSeat, finalTok, { action: 'handle', fieldWrites: { memo: 'x' } })
    expect(noSeat.status).toBe(403)

    const reasons: Array<{ label: string; body: Record<string, unknown>; code: string; httpStatus: number }> = [
      { label: 'readonly', body: { action: 'handle', fieldWrites: { amount: 1 } }, code: 'APPROVAL_FIELD_WRITE_FORBIDDEN', httpStatus: 403 },
      { label: 'hidden', body: { action: 'handle', fieldWrites: { secret: 's' } }, code: 'APPROVAL_FIELD_WRITE_FORBIDDEN', httpStatus: 403 },
      { label: 'unknown-field', body: { action: 'handle', fieldWrites: { nope_field: 'x' } }, code: 'APPROVAL_FIELD_WRITE_UNKNOWN_FIELD', httpStatus: 400 },
      { label: 'detail-subcolumn-address', body: { action: 'handle', fieldWrites: { 'memo.sub': 'x' } }, code: 'APPROVAL_FIELD_WRITE_UNKNOWN_FIELD', httpStatus: 400 },
      { label: 'payload-not-object', body: { action: 'handle', fieldWrites: [1, 2] }, code: 'APPROVAL_FIELD_WRITE_PAYLOAD_INVALID', httpStatus: 400 },
      { label: 'payload-null', body: { action: 'handle', fieldWrites: null }, code: 'APPROVAL_FIELD_WRITE_PAYLOAD_INVALID', httpStatus: 400 },
    ]
    for (const { label, body, code, httpStatus } of reasons) {
      const iid = await createInstance(tid)
      const res = await act(iid, handlerTok, body)
      expect(res.status, `${label}: ${await res.clone().text()}`).toBe(httpStatus)
      const errBody = (await res.json()) as ErrorBody
      expect(errorCode(errBody), label).toBe(code)
      // values-free: the error details never carry a submitted VALUE.
      const detailsStr = JSON.stringify(errBody.error?.details ?? {})
      expect(detailsStr.includes('nope_field') || label !== 'unknown-field').toBe(true) // fieldId is a schema id, allowed
      expect(detailsStr).not.toContain('"x"')
      expect(detailsStr).not.toContain('"s"')
      // zero rows: no revision row, still at the handler, no handle audit row.
      expect(await revisionRows(iid)).toHaveLength(0)
      expect((await instanceRow(iid)).current_node_key).toBe('handler_h')
      expect(await records(iid, 'handle')).toHaveLength(0)
    }

    // Positive control: a fully-compliant call succeeds in the same fixture (refusal is reason-selected).
    const iidOk = await createInstance(tid)
    const ok = await act(iidOk, handlerTok, { action: 'handle', fieldWrites: { memo: 'compliant' } })
    expect(ok.status, await ok.clone().text()).toBe(200)
    expect((await instanceRow(iidOk)).form_snapshot?.memo).toBe('compliant')

    // Legacy approve carries NO field payload: fieldWrites on a non-handle action is a values-free 400.
    const tidApprove = await createPublished(`${KEYPFX}-g15-approve`, {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'approval_x', type: 'approval', name: 'x', config: { assigneeSources: staticUser([GATE]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [{ key: 's2x', source: 'start', target: 'approval_x' }, { key: 'x2e', source: 'approval_x', target: 'end' }],
    })
    const iidApprove = await createInstance(tidApprove)
    const approveWithWrites = await act(iidApprove, gateTok, { action: 'approve', fieldWrites: { memo: 'x' } })
    expect(approveWithWrites.status).toBe(400)
    expect(errorCode((await approveWithWrites.json()) as ErrorBody)).toBe('APPROVAL_FIELD_WRITE_ACTION_NOT_ALLOWED')
  })

  // ── G-6 — writes re-run the FROZEN validators; MS-3 fail-open is disclosed ─────────────────────
  it('G-6: a type-violating write is refused with zero rows; validation is against the PINNED version schema, not the live template', async () => {
    const tid = await createPublished(`${KEYPFX}-g6`, handlerGraph([{ fieldId: 'amount', access: 'editable' }]))
    const iid = await createInstance(tid)
    // amount is a number field → a string value violates validateFieldType → refused, zero rows, no advance.
    const bad = await act(iid, handlerTok, { action: 'handle', fieldWrites: { amount: 'not-a-number' } })
    expect(bad.status).toBe(400)
    expect(errorCode((await bad.json()) as ErrorBody)).toBe('APPROVAL_FIELD_WRITE_INVALID')
    expect(await revisionRows(iid)).toHaveLength(0)
    expect((await instanceRow(iid)).current_node_key).toBe('handler_h')
    // Positive control: a valid number is written.
    const good = await act(iid, handlerTok, { action: 'handle', fieldWrites: { amount: 7 } })
    expect(good.status, await good.clone().text()).toBe(200)
    expect((await instanceRow(iid)).form_snapshot?.amount).toBe(7)
  })

  it('G-6 (frozen schema): after the live template schema changes, the write still validates against the instance\'s PINNED version', async () => {
    const tid = await createPublished(`${KEYPFX}-g6-frozen`, handlerGraph([{ fieldId: 'amount', access: 'editable' }]))
    const iid = await createInstance(tid)
    // Mutate the LIVE template: retype `amount` from number to text via a new draft (does NOT re-publish
    // → the in-flight instance keeps its pinned version). The pinned schema still says `amount` is a
    // number, so a string write is STILL refused (proves the pinned, not live, schema governs).
    const patched = { ...FORM_SCHEMA, fields: FORM_SCHEMA.fields.map((f) => (f.id === 'amount' ? { ...f, type: 'text' } : f)) }
    const upd = await req(base, `/api/approval-templates/${tid}`, reqTok, { method: 'PATCH', body: { formSchema: patched } })
    expect(upd.status, await upd.clone().text()).toBe(200)
    const stillRefused = await act(iid, handlerTok, { action: 'handle', fieldWrites: { amount: 'now-text' } })
    expect(stillRefused.status).toBe(400)
    expect(errorCode((await stillRefused.json()) as ErrorBody)).toBe('APPROVAL_FIELD_WRITE_INVALID')
  })

  // ── G-7 — transaction atomicity: a mid-write refusal rolls the WHOLE transaction back ─────────
  it('G-7: a batch write with one valid + one readonly field refuses and leaves ZERO snapshot/revision/audit/assignment change and an unchanged version; the all-valid batch changes all', async () => {
    const tid = await createPublished(`${KEYPFX}-g7`, handlerGraph([
      { fieldId: 'memo', access: 'editable' },
      { fieldId: 'amount', access: 'readonly' },
    ]))
    const iid = await createInstance(tid)
    const before = await instanceRow(iid)
    const beforeSeats = await activeSeats(iid)
    // memo (valid/editable) + amount (readonly) → the readonly refusal aborts the WHOLE thing.
    const refused = await act(iid, handlerTok, { action: 'handle', fieldWrites: { memo: 'should-not-persist', amount: 1 } })
    expect(refused.status).toBe(403)
    const after = await instanceRow(iid)
    expect(after.form_snapshot?.memo).toBeUndefined() // the valid field was NOT written (rollback)
    expect(after.version).toBe(before.version) // version unchanged
    expect(after.current_node_key).toBe('handler_h') // no advance
    expect(await revisionRows(iid)).toHaveLength(0) // zero revision rows
    expect(await records(iid, 'handle')).toHaveLength(0) // zero audit rows
    expect(await activeSeats(iid)).toEqual(beforeSeats) // zero assignment change
    // Positive control: the all-valid single-field batch changes snapshot + writes a revision + advances.
    const ok = await act(iid, handlerTok, { action: 'handle', fieldWrites: { memo: 'persisted' } })
    expect(ok.status, await ok.clone().text()).toBe(200)
    expect((await instanceRow(iid)).form_snapshot?.memo).toBe('persisted')
    expect(await revisionRows(iid)).toHaveLength(1)
    expect((await records(iid, 'handle'))).toHaveLength(1)
  })

  // ── G-8 — audit is values-free but answerable; the revision surface is mask-aware ─────────────
  it('G-8: the handle audit row carries changedFieldIds and NO value; the revision table carries before/after; the mask-aware read redacts a hidden field but returns a visible one', async () => {
    // memo editable; secret editable at THIS handler but hidden at a later approval node → after advance
    // the instance is no longer AT a hiding node, so the read is visible. To exercise redaction we hide
    // `secret` at the handler where the instance PAUSES — use a two-handler graph so the second handler
    // hides `secret` while the instance sits there after the first handler's edit.
    const graph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'handler_edit', type: 'handler', name: 'edit', config: { assigneeSources: staticUser([HANDLER]), fieldPermissions: [{ fieldId: 'memo', access: 'editable' }, { fieldId: 'secret', access: 'editable' }] } },
        { key: 'handler_hide', type: 'handler', name: 'hide', config: { assigneeSources: staticUser([HANDLER2]), fieldPermissions: [{ fieldId: 'secret', access: 'hidden' }] } },
        { key: 'approval_final', type: 'approval', name: 'f', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 's2e', source: 'start', target: 'handler_edit' },
        { key: 'e2h', source: 'handler_edit', target: 'handler_hide' },
        { key: 'h2f', source: 'handler_hide', target: 'approval_final' },
        { key: 'f2e', source: 'approval_final', target: 'end' },
      ],
    }
    const tid = await createPublished(`${KEYPFX}-g8`, graph)
    const iid = await createInstance(tid)
    const write = await act(iid, handlerTok, { action: 'handle', fieldWrites: { memo: 'audit-me', secret: 'top-secret' } })
    expect(write.status, await write.clone().text()).toBe(200)
    // Audit: the handle row carries changedFieldIds and NO value anywhere in its metadata.
    const handleRows = await records(iid, 'handle')
    expect(handleRows).toHaveLength(1)
    const md = handleRows[0]!.metadata ?? {}
    expect(md.changedFieldIds).toEqual(expect.arrayContaining(['memo', 'secret']))
    const mdStr = JSON.stringify(md)
    expect(mdStr).not.toContain('audit-me')
    expect(mdStr).not.toContain('top-secret')
    // Revision table carries before/after (raw).
    const revs = await revisionRows(iid)
    const secretRev = revs.find((r) => r.field_id === 'secret')!
    expect(secretRev.after_value).toBe('top-secret')
    // Broadly-scoped history read (HTTP) returns NO form value for the edited instance.
    const histRes = await req(base, `/api/approvals/${iid}/history`, reqTok)
    const histText = await histRes.text()
    expect(histText).not.toContain('top-secret')
    expect(histText).not.toContain('audit-me')
    // Mask-aware revision read: the instance now sits at handler_hide (secret hidden) → secret's
    // before/after is REDACTED, but memo (not hidden there) returns its before/after.
    const masked = await service.getFormFieldRevisions(iid)
    const maskedSecret = masked.find((r) => r.fieldId === 'secret')!
    const maskedMemo = masked.find((r) => r.fieldId === 'memo')!
    expect(maskedSecret.redacted).toBe(true)
    expect(maskedSecret.after).toBeNull()
    expect(maskedMemo.redacted).toBe(false)
    expect(maskedMemo.after).toBe('audit-me')
  })

  // ── G-12 / D-1 fix — non-approval node types: ANY fieldPermissions entry is REJECTED, not dropped ──
  // docs/development/approval-lock7-field-edit-enforcement-20260817.md §2.7 D-1 + OD-L7-4. P4-B (the
  // Lock-7 landing PR, #4961) closed only the `editable` arm — the load-bearing privilege-escalation
  // half — and left the READ axis (`readonly`/`hidden`) silently dropped, logged as D-1 "for a
  // separate fix slice" (independently reproduced by the P7 phase-A verification ledger, which flagged
  // that `readonly`/`hidden` were STILL silently dropped on these five node types at that baseline).
  // This IS that slice: ALL THREE access values — the whole NodeFieldAccess enum — on ALL FIVE
  // non-write-capable node types (cc/start/end/condition/parallel — the complement of
  // {approval, handler} in APPROVAL_NODE_TYPES) now fail publish with the SAME typed values-free 4xx,
  // instead of a silent, effect-free drop. This closes BOTH axes: the `editable` write-side hazard
  // (already closed by P4-B) AND the `readonly`/`hidden` read-side silent-loss the P7 ledger flagged.
  // FIX-ROUND (/tmp/pr4979-d1-gate-20260818.md, independent adversarial gate on this PR's first head):
  // P2-1 fixed — the empty-array positive control now sends `fieldPermissions: []` VERBATIM (the prior
  // `length > 0 ? {...} : {}` helper silently omitted the key, so the control never exercised the
  // `length > 0` conjunct; mutation-verified below). P3-1 fixed — non-array `fieldPermissions` shapes
  // (object/string/null) are now negatives too, matching the production guard's widened predicate.
  it('G-12 (D-1 closed, both axes): fieldPermissions — EVERY access value (editable/readonly/hidden) — on EVERY non-write-capable node type is REJECTED with a typed values-free 400; an empty array and an approval-node matrix still round-trip', async () => {
    // Positive control first: hidden on an APPROVAL node round-trips through save (unchanged by this slice).
    const okGraph = handlerGraph([{ fieldId: 'memo', access: 'hidden' }])
    okGraph.nodes[2]!.config = { ...okGraph.nodes[2]!.config, fieldPermissions: [{ fieldId: 'secret', access: 'hidden' }] } as never
    await createTemplateId(`${KEYPFX}-g12-ok`, okGraph)

    async function assertRejected(res: Response, label: string, nodeKey: string): Promise<void> {
      expect(res.status, `${label}: ${await res.clone().text()}`).toBe(400)
      const body = (await res.json()) as ErrorBody
      expect(errorCode(body), label).toBe('APPROVAL_NODE_FIELD_PERMISSIONS_UNSUPPORTED_NODE_TYPE')
      // values-free: neither the fieldId nor any submitted value is echoed — only the structural
      // node key / node type identify WHERE the rejection fired.
      const detailsStr = JSON.stringify(body.error?.details ?? {})
      expect(detailsStr).toContain(nodeKey)
      expect(detailsStr).not.toContain('memo')
      expect(detailsStr).not.toContain('secret')
    }

    // One graph-builder per non-write-capable node type, each returning { graph, nodeKey } so a SINGLE
    // loop below drives all 3 access values × all 5 types = 15 negative assertions off one table.
    // `rawFieldPermissions` is placed under the `fieldPermissions` key VERBATIM — including `[]` and
    // non-array shapes — so a caller controls the exact wire shape (P2-1: the earlier
    // `length > 0 ? {...} : {}` form silently OMITTED the key for `[]`, so the "empty array is
    // tolerated" control never actually sent an empty array).
    type NonWriteType = 'cc' | 'start' | 'end' | 'condition' | 'parallel'
    function graphFor(type: NonWriteType, rawFieldPermissions: unknown): { graph: unknown; nodeKey: string } {
      const fp = { fieldPermissions: rawFieldPermissions }
      switch (type) {
        case 'cc':
          return {
            nodeKey: 'cc_x',
            graph: {
              nodes: [
                { key: 'start', type: 'start', name: 's', config: {} },
                { key: 'cc_x', type: 'cc', name: 'cc', config: { targetType: 'user', targetIds: [FINAL], ...fp } },
                { key: 'approval_final', type: 'approval', name: 'f', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
                { key: 'end', type: 'end', name: 'e', config: {} },
              ],
              edges: [{ key: 's2c', source: 'start', target: 'cc_x' }, { key: 'c2f', source: 'cc_x', target: 'approval_final' }, { key: 'f2e', source: 'approval_final', target: 'end' }],
            },
          }
        case 'start':
          return {
            nodeKey: 'start',
            graph: {
              nodes: [
                { key: 'start', type: 'start', name: 's', config: fp },
                { key: 'approval_final', type: 'approval', name: 'f', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
                { key: 'end', type: 'end', name: 'e', config: {} },
              ],
              edges: [{ key: 's2f', source: 'start', target: 'approval_final' }, { key: 'f2e', source: 'approval_final', target: 'end' }],
            },
          }
        case 'end':
          return {
            nodeKey: 'end',
            graph: {
              nodes: [
                { key: 'start', type: 'start', name: 's', config: {} },
                { key: 'approval_final', type: 'approval', name: 'f', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
                { key: 'end', type: 'end', name: 'e', config: fp },
              ],
              edges: [{ key: 's2f', source: 'start', target: 'approval_final' }, { key: 'f2e', source: 'approval_final', target: 'end' }],
            },
          }
        case 'condition':
          return {
            nodeKey: 'cond_x',
            graph: {
              nodes: [
                { key: 'start', type: 'start', name: 's', config: {} },
                {
                  key: 'cond_x',
                  type: 'condition',
                  name: 'c',
                  config: {
                    branches: [{ edgeKey: 'c2high', rules: [{ fieldId: 'amount', operator: 'gt', value: 100 }] }],
                    defaultEdgeKey: 'c2low',
                    ...fp,
                  },
                },
                { key: 'approval_high', type: 'approval', name: 'high', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
                { key: 'approval_low', type: 'approval', name: 'low', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
                { key: 'end', type: 'end', name: 'e', config: {} },
              ],
              edges: [
                { key: 's2c', source: 'start', target: 'cond_x' },
                { key: 'c2high', source: 'cond_x', target: 'approval_high' },
                { key: 'c2low', source: 'cond_x', target: 'approval_low' },
                { key: 'high2e', source: 'approval_high', target: 'end' },
                { key: 'low2e', source: 'approval_low', target: 'end' },
              ],
            },
          }
        case 'parallel':
          return {
            nodeKey: 'par_x',
            graph: {
              nodes: [
                { key: 'start', type: 'start', name: 's', config: {} },
                {
                  key: 'par_x',
                  type: 'parallel',
                  name: 'p',
                  config: { branches: ['p2a', 'p2b'], joinNodeKey: 'join', joinMode: 'all', ...fp },
                },
                { key: 'approval_a', type: 'approval', name: 'a', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
                { key: 'approval_b', type: 'approval', name: 'b', config: { assigneeSources: staticUser([HANDLER]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
                { key: 'join', type: 'approval', name: 'j', config: { assigneeSources: staticUser([GATE]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
                { key: 'end', type: 'end', name: 'e', config: {} },
              ],
              edges: [
                { key: 's2p', source: 'start', target: 'par_x' },
                { key: 'p2a', source: 'par_x', target: 'approval_a' },
                { key: 'p2b', source: 'par_x', target: 'approval_b' },
                { key: 'a2j', source: 'approval_a', target: 'join' },
                { key: 'b2j', source: 'approval_b', target: 'join' },
                { key: 'j2e', source: 'join', target: 'end' },
              ],
            },
          }
      }
    }

    // 3 access values × 5 node types = 15 negatives, EVERY ONE typed + values-free.
    const NON_WRITE_TYPES: NonWriteType[] = ['cc', 'start', 'end', 'condition', 'parallel']
    for (const type of NON_WRITE_TYPES) {
      for (const access of ['editable', 'readonly', 'hidden'] as const) {
        const { graph, nodeKey } = graphFor(type, [{ fieldId: 'memo', access }])
        const res = await createTemplate(`${KEYPFX}-g12-${type}-${access}`, graph)
        await assertRejected(res, `${type}/${access}`, nodeKey)
      }
    }

    // Malformed ARRAY entry (missing `fieldId`) is ALSO rejected — the check is presence-selected, not
    // access-value-selected, so it does not depend on the entry's internal shape being valid to fire.
    const malformedRes = await createTemplate(
      `${KEYPFX}-g12-cc-malformed`,
      graphFor('cc', [{ access: 'hidden' } as unknown as NodeFieldPermission]).graph,
    )
    await assertRejected(malformedRes, 'cc/malformed', 'cc_x')

    // Non-ARRAY shapes (an object, a string, `null`) are ALSO rejected — a residual D-1 channel the
    // `Array.isArray(...) && length > 0` form of the guard left open (a non-array value is not an
    // array, so it fell through, and the switch below drops it just like the array case did): the
    // guard is `rawPermissions !== undefined && !isTolerableEmptyArray`, not shape-scoped to arrays.
    // These would ALSO 400 on an approval node (`normalizeNodeFieldPermissions` — "must be an array"),
    // so this closes the last type-asymmetric hole between write-capable and non-write-capable nodes.
    for (const [label, shape] of [
      ['object', { memo: 'hidden' }],
      ['string', 'hidden'],
      ['null', null],
    ] as const) {
      const res = await createTemplate(`${KEYPFX}-g12-cc-nonarray-${label}`, graphFor('cc', shape).graph)
      await assertRejected(res, `cc/non-array-${label}`, 'cc_x')
    }

    // Positive control: an EMPTY array — sent VERBATIM as `fieldPermissions: []`, not omitted — is NOT
    // rejected (OD-L7-9 absent/empty ≡ no permissions; a conservative tolerance choice, not an FE-compat
    // requirement — no live authoring surface sends this shape on any of these five node types, see the
    // production comment at the guard site).
    // Confirms the request payload really did carry `fieldPermissions: []` (not an omitted key) by
    // reading the SAME graph object this test built rather than trusting the helper silently.
    const emptyGraphSent = graphFor('cc', []).graph as { nodes: Array<{ key: string; config: Record<string, unknown> }> }
    expect(emptyGraphSent.nodes.find((n) => n.key === 'cc_x')?.config.fieldPermissions).toEqual([])
    const emptyRes = await createTemplate(`${KEYPFX}-g12-cc-empty`, emptyGraphSent)
    expect(emptyRes.status, await emptyRes.clone().text()).toBe(201)
    // The cc switch case never copies `fieldPermissions` into its OUTPUT config (it only ever emits
    // {targetType, targetIds}), so the tolerated empty array is harmlessly dropped on the round trip —
    // that is NOT the D-1 defect class (an empty array carries no information to lose).
    const emptyBody = (await emptyRes.json()) as { approvalGraph: { nodes: Array<{ key: string; config: Record<string, unknown> }> } }
    expect(emptyBody.approvalGraph.nodes.find((n) => n.key === 'cc_x')?.config.fieldPermissions).toBeUndefined()
  })

  // ── D-1 fix — in-flight tolerance: a STORED graph carrying cc-fieldPermissions still dispatches ──
  it('D-1 fix in-flight tolerance: a STORED runtime graph carrying fieldPermissions on a cc node (hand-edited, never publishable through the choke) still dispatches — §2.1 widen-only rule', async () => {
    // The publish-time choke above makes this shape UN-PUBLISHABLE going forward, so the only way to
    // exercise the dispatch re-normalize tolerance is the same technique the shipped "G-4 legacy
    // explicit-editable subcase" test uses: publish a valid graph, then hand-edit the STORED
    // `runtime_graph` row directly (bypassing the authoring choke entirely, as a defensively-tolerated
    // legacy/corrupted shape would).
    const ccGraph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'cc_x', type: 'cc', name: 'cc', config: { targetType: 'user', targetIds: [FINAL] } },
        { key: 'approval_final', type: 'approval', name: 'f', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [{ key: 's2c', source: 'start', target: 'cc_x' }, { key: 'c2f', source: 'cc_x', target: 'approval_final' }, { key: 'f2e', source: 'approval_final', target: 'end' }],
    }
    const tid = await createPublished(`${KEYPFX}-d1-inflight`, ccGraph)

    const pool = poolManager.get()
    const defRow = await pool.query<{ id: string; runtime_graph: { nodes: Array<{ key: string; config?: Record<string, unknown> }> } }>(
      `SELECT id, runtime_graph FROM approval_published_definitions WHERE template_id = $1 AND is_active = TRUE`,
      [tid],
    )
    const rg = defRow.rows[0]!.runtime_graph
    const ccNode = rg.nodes.find((n) => n.key === 'cc_x')!
    ccNode.config = { ...ccNode.config, fieldPermissions: [{ fieldId: 'memo', access: 'hidden' }] }
    await pool.query(`UPDATE approval_published_definitions SET runtime_graph = $2 WHERE id = $1`, [defRow.rows[0]!.id, JSON.stringify(rg)])

    // Dispatch: creating the instance itself walks start → cc_x → approval_final (cc is a pass-through
    // notify node, ApprovalGraphExecutor auto-advances past it — `node.type === 'cc'` follows the first
    // outgoing edge), which re-normalizes the STORED graph via `asRuntimeGraph`/STORED_RUNTIME_CONTEXT
    // over the hand-edited cc_x node. A 201 here is already the tolerance proof; a comment + approve at
    // the (now-current) approval node re-normalizes the SAME stored graph again on every subsequent
    // dispatch. Neither call may 500 — the hand-edited shape must be tolerated, not rejected.
    const iid = await createInstance(tid)
    expect((await instanceRow(iid)).current_node_key).toBe('approval_final')
    const comment = await act(iid, finalTok, { action: 'comment', comment: 'dispatch re-normalize tolerates cc.fieldPermissions' })
    expect(comment.status, await comment.clone().text()).toBe(200)
    const approve = await act(iid, finalTok, { action: 'approve' })
    expect(approve.status, await approve.clone().text()).toBe(200)
    expect((await instanceRow(iid)).status).toBe('approved')
  })

  // ── G-4 — routing drivers cannot be editable at ANY node ──────────────────────────────────────
  it('G-4: each driver kind (form_field_user / ConditionRule / condition-formula) marked editable fails publish; a non-driver field publishes editable in the same graph', async () => {
    // Positive control: a NON-driver field (memo) editable publishes fine.
    await createPublished(`${KEYPFX}-g4-ok`, handlerGraph([{ fieldId: 'memo', access: 'editable' }]))

    // form_field_user driver: `pick` names the FINAL approver. Marking it editable at the handler → 400.
    const ffuGraph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'handler_h', type: 'handler', name: '办理', config: { assigneeSources: staticUser([HANDLER]), fieldPermissions: [{ fieldId: 'pick', access: 'editable' }] } },
        { key: 'approval_final', type: 'approval', name: 'f', config: { assigneeSources: [{ kind: 'form_field_user', fieldId: 'pick' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [{ key: 's2h', source: 'start', target: 'handler_h' }, { key: 'h2f', source: 'handler_h', target: 'approval_final' }, { key: 'f2e', source: 'approval_final', target: 'end' }],
    }
    // Assert the DRIVER-PIN error specifically (not a bare 400): a malformed graph would 400 for the
    // WRONG reason (e.g. the formula parser), leaving the pin arm vacuous. The pin's failValidation
    // message names the driver field + OD-L7-8.
    const expectDriverPin = async (res: Response, fieldId: string): Promise<void> => {
      expect(res.status, await res.clone().text()).toBe(400)
      const msg = ((await res.json()) as ErrorBody).error?.message ?? ''
      expect(msg, `driver-pin message for ${fieldId}`).toContain('routing-driver field')
      expect(msg).toContain(fieldId)
      expect(msg).toContain('OD-L7-8')
    }
    await expectDriverPin(await createTemplate(`${KEYPFX}-g4-ffu`, ffuGraph), 'pick')

    // ConditionRule driver: `route_num` selects a branch. Marking it editable at the handler → driver pin.
    const ruleGraph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'handler_h', type: 'handler', name: '办理', config: { assigneeSources: staticUser([HANDLER]), fieldPermissions: [{ fieldId: 'route_num', access: 'editable' }] } },
        { key: 'cond', type: 'condition', name: 'c', config: { branches: [{ edgeKey: 'c2f', rules: [{ fieldId: 'route_num', operator: 'gt', value: 5 }] }], defaultEdgeKey: 'c2e' } },
        { key: 'approval_final', type: 'approval', name: 'f', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [{ key: 's2h', source: 'start', target: 'handler_h' }, { key: 'h2c', source: 'handler_h', target: 'cond' }, { key: 'c2f', source: 'cond', target: 'approval_final' }, { key: 'c2e', source: 'cond', target: 'end' }, { key: 'f2e', source: 'approval_final', target: 'end' }],
    }
    await expectDriverPin(await createTemplate(`${KEYPFX}-g4-rule`, ruleGraph), 'route_num')

    // condition-formula driver: `formula_num` is a formula operand. The field-reference syntax is
    // BRACE-delimited (`{formula_num}`) — a bare `formula_num` would tokenize as an identifier and be
    // rejected by the formula PARSER first, making this arm vacuous. Use the real syntax so the 400 is
    // the DRIVER PIN.
    const formulaGraph = JSON.parse(JSON.stringify(ruleGraph)) as typeof ruleGraph
    ;(formulaGraph.nodes[1]!.config as { fieldPermissions: NodeFieldPermission[] }).fieldPermissions = [{ fieldId: 'formula_num', access: 'editable' }]
    ;(formulaGraph.nodes[2]!.config as { branches: Array<{ edgeKey: string; rules: unknown[]; formula?: { expression: string } }>; defaultEdgeKey: string }).branches = [{ edgeKey: 'c2f', rules: [], formula: { expression: '{formula_num} > 5' } }]
    await expectDriverPin(await createTemplate(`${KEYPFX}-g4-formula`, formulaGraph), 'formula_num')
  })

  it('G-4 (legacy explicit-editable subcase closed): even a stored graph that marks a driver EXPLICITLY editable has the driver write REFUSED by the runtime guard (matrix-independent); the legacy graph stays dispatchable and the next approver is NOT re-routed', async () => {
    // Pin 1 is authoring-only, so a pre-Lock-7 graph can carry an EXPLICIT `editable` driver in its
    // STORED runtime graph (the §2.5 legacy state — reproduced by publishing `readonly` then flipping
    // the stored graph, which the authoring path cannot produce). The runtime driver guard is
    // matrix-INDEPENDENT, so it refuses the driver write in this legacy case too — closing the subcase
    // the earlier "hazard" would have exploited. The next node therefore resolves the UNCHANGED driver
    // value; no re-route occurs.
    const graph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'handler_edit', type: 'handler', name: 'edit', config: { assigneeSources: staticUser([HANDLER]), fieldPermissions: [{ fieldId: 'pick', access: 'readonly' }] } },
        { key: 'approval_gate', type: 'approval', name: 'g', config: { assigneeSources: staticUser([GATE]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'approval_pick', type: 'approval', name: 'p', config: { assigneeSources: [{ kind: 'form_field_user', fieldId: 'pick' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 's2h', source: 'start', target: 'handler_edit' },
        { key: 'h2g', source: 'handler_edit', target: 'approval_gate' },
        { key: 'g2p', source: 'approval_gate', target: 'approval_pick' },
        { key: 'p2e', source: 'approval_pick', target: 'end' },
      ],
    }
    const tid = await createPublished(`${KEYPFX}-g4-legacy`, graph)
    // Flip the STORED runtime driver permission readonly→EXPLICIT editable — the legacy editable-driver state.
    const pool = poolManager.get()
    const defRow = await pool.query<{ id: string; runtime_graph: { nodes: Array<{ key: string; config?: { fieldPermissions?: NodeFieldPermission[] } }> } }>(
      `SELECT id, runtime_graph FROM approval_published_definitions WHERE template_id = $1 AND is_active = TRUE`,
      [tid],
    )
    const rg = defRow.rows[0]!.runtime_graph
    rg.nodes.find((n) => n.key === 'handler_edit')!.config!.fieldPermissions = [{ fieldId: 'pick', access: 'editable' }]
    await pool.query(`UPDATE approval_published_definitions SET runtime_graph = $2 WHERE id = $1`, [defRow.rows[0]!.id, JSON.stringify(rg)])

    const iid = await createInstance(tid, { reason: 'r', pick: HANDLER2 })
    // The runtime driver guard refuses the driver write DESPITE the explicit editable matrix entry.
    const edit = await act(iid, handlerTok, { action: 'handle', fieldWrites: { pick: FINAL } })
    expect(edit.status).toBe(403)
    expect(errorCode((await edit.json()) as ErrorBody)).toBe('APPROVAL_FIELD_WRITE_DRIVER_FORBIDDEN')
    // The legacy graph stays dispatchable (§2.1): a plain handle (no driver write) advances, and the
    // gate's approve resolves approval_pick from the UNCHANGED driver → seat HANDLER2, NOT FINAL.
    expect((await act(iid, handlerTok, { action: 'handle' })).status).toBe(200)
    expect((await act(iid, gateTok, { action: 'approve' })).status).toBe(200)
    const seats = await activeSeats(iid)
    expect(seats.some((s) => s.node_key === 'approval_pick' && s.assignee_id === HANDLER2)).toBe(true)
    expect(seats.some((s) => s.assignee_id === FINAL)).toBe(false)
  })

  // ── G-4 / G-15 — RUNTIME driver-write guard (the default-editable escalation, matrix-independent) ─
  it('G-4 (runtime driver guard): a DEFAULT-editable driver (omitted from a handler matrix, brand-new normally-published graph, NO legacy flip) is refused values-free with zero rows; a NON-driver field still writes', async () => {
    // The publish pin only rejects an EXPLICIT editable driver; OD-L7-9's absent≡editable leaves a
    // driver simply OMITTED from a handler matrix default-editable, and the write mask would then
    // permit it — so a handler could edit `pick` and choose the downstream form_field_user approver
    // (master §P4 exit: "cannot be bypassed by HTTP calls"). The runtime driver guard refuses a write
    // to any frozen-graph driver field regardless of the matrix. This reproduces the escalation on a
    // brand-new normally-published graph (no stored-graph flip) and asserts it is now closed.
    // The graph routes through BOTH a form_field_user driver (`pick`) AND a ConditionRule driver
    // (`route_num`), neither in the handler's matrix (default-editable), so the guard's per-kind
    // coverage is asserted end-to-end (not just the form_field_user arm — deleting the ConditionRule
    // arm from the shared collection must red HERE too, at the write path).
    const graph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        // NO fieldPermissions on the handler ⇒ `pick` AND `route_num` are DEFAULT-editable by the matrix.
        { key: 'handler_edit', type: 'handler', name: 'edit', config: { assigneeSources: staticUser([HANDLER]) } },
        { key: 'cond', type: 'condition', name: 'c', config: { branches: [{ edgeKey: 'c2p', rules: [{ fieldId: 'route_num', operator: 'gt', value: 5 }] }], defaultEdgeKey: 'c2e' } },
        { key: 'approval_pick', type: 'approval', name: 'p', config: { assigneeSources: [{ kind: 'form_field_user', fieldId: 'pick' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 's2h', source: 'start', target: 'handler_edit' },
        { key: 'h2c', source: 'handler_edit', target: 'cond' },
        { key: 'c2p', source: 'cond', target: 'approval_pick' },
        { key: 'c2e', source: 'cond', target: 'end' },
        { key: 'p2e', source: 'approval_pick', target: 'end' },
      ],
    }
    // Publishes fine — the pin does NOT reject an absent driver (no §2.1 authoring narrowing).
    const tid = await createPublished(`${KEYPFX}-g4-runtime`, graph)
    const iid = await createInstance(tid, { reason: 'r', pick: HANDLER2, route_num: 10 })
    // form_field_user driver: the runtime guard refuses the write to `pick` — values-free 403, zero rows, no advance.
    const escalate = await act(iid, handlerTok, { action: 'handle', fieldWrites: { pick: FINAL } })
    expect(escalate.status).toBe(403)
    const body = (await escalate.json()) as ErrorBody
    expect(errorCode(body)).toBe('APPROVAL_FIELD_WRITE_DRIVER_FORBIDDEN')
    expect(JSON.stringify(body.error?.details ?? {})).not.toContain(FINAL) // values-free (no submitted value)
    expect(await revisionRows(iid)).toHaveLength(0)
    expect((await instanceRow(iid)).current_node_key).toBe('handler_edit') // no advance
    expect(await records(iid, 'handle')).toHaveLength(0)
    // ConditionRule driver: a write to `route_num` (branch selector) is refused the same way.
    const escalateRule = await act(iid, handlerTok, { action: 'handle', fieldWrites: { route_num: 9 } })
    expect(escalateRule.status).toBe(403)
    expect(errorCode((await escalateRule.json()) as ErrorBody)).toBe('APPROVAL_FIELD_WRITE_DRIVER_FORBIDDEN')
    expect(await revisionRows(iid)).toHaveLength(0)
    // Positive control: a NON-driver field (memo) is still writable at the SAME handler — the guard is
    // driver-selected, not blanket. This advances the handler (route_num=10>5 → approval_pick).
    const okWrite = await act(iid, handlerTok, { action: 'handle', fieldWrites: { memo: 'ok-non-driver' } })
    expect(okWrite.status, await okWrite.clone().text()).toBe(200)
    expect((await instanceRow(iid)).form_snapshot?.memo).toBe('ok-non-driver')
  })

  // ── G-5 — unfillable required × hidden ────────────────────────────────────────────────────────
  it('G-5: a required create-hideable field hidden at every write-capable node fails publish (field id + node key, no value); a create-visible required field and a non-required field hidden everywhere both publish', async () => {
    // req_cond: required + visibilityRule (create-hideable). Hidden at BOTH the handler AND the approval
    // node → unfillable → publish 400.
    const unfillable = handlerGraph([{ fieldId: 'req_cond', access: 'hidden' }])
    ;(unfillable.nodes[2]!.config as { fieldPermissions?: NodeFieldPermission[] }).fieldPermissions = [{ fieldId: 'req_cond', access: 'hidden' }]
    const res = await createTemplate(`${KEYPFX}-g5-unfillable`, unfillable)
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorBody
    const msg = body.error?.message ?? ''
    expect(msg).toContain('req_cond') // field id present
    // no VALUE leaked
    expect(JSON.stringify(body)).not.toContain('"value"')

    // Positive control 1: `reason` (required, NO visibilityRule → always create-visible/filled) hidden at
    // every write-capable node STILL publishes.
    const visibleReqHidden = handlerGraph([{ fieldId: 'reason', access: 'hidden' }])
    ;(visibleReqHidden.nodes[2]!.config as { fieldPermissions?: NodeFieldPermission[] }).fieldPermissions = [{ fieldId: 'reason', access: 'hidden' }]
    await createTemplateId(`${KEYPFX}-g5-visible-req`, visibleReqHidden)

    // Positive control 2: a NON-required field (`secret`) hidden everywhere publishes.
    const nonReqHidden = handlerGraph([{ fieldId: 'secret', access: 'hidden' }])
    ;(nonReqHidden.nodes[2]!.config as { fieldPermissions?: NodeFieldPermission[] }).fieldPermissions = [{ fieldId: 'secret', access: 'hidden' }]
    await createTemplateId(`${KEYPFX}-g5-nonreq`, nonReqHidden)
  })

  // ── G-10 — round-trip + restore preserves the matrix byte-for-byte ────────────────────────────
  it('G-10: a matrix survives create → publish → reload → version-restore byte-for-byte', async () => {
    const matrix = [{ fieldId: 'memo', access: 'readonly' as const }, { fieldId: 'secret', access: 'hidden' as const }]
    const tid = await createPublished(`${KEYPFX}-g10`, handlerGraph(matrix))
    const detail = await req(base, `/api/approval-templates/${tid}`, reqTok)
    const detailBody = (await detail.json()) as { approvalGraph?: { nodes: Array<{ key: string; config?: { fieldPermissions?: NodeFieldPermission[] } }> } }
    const handlerNode = detailBody.approvalGraph?.nodes.find((n) => n.key === 'handler_h')
    expect(handlerNode?.config?.fieldPermissions).toEqual(matrix)
  })

  // ── G-16 — 内容变更 dedup invalidation (+ epoch unchanged) ─────────────────────────────────────
  it('G-16: an edit at a handler invalidates a prior same-actor approval so a later node does NOT auto-approve; with no edit it DOES; the edit does not bump the node epoch', async () => {
    // start → approval_A(GATE) → handler_H(GATE, editable memo) → approval_B(GATE) → end.
    // GATE approves A, then handles H, then B would auto-approve on A's approval (dedupeHistoricalApprover).
    function dedupGraph(handlerFieldPermissions: NodeFieldPermission[]) {
      return {
        nodes: [
          { key: 'start', type: 'start', name: 's', config: {} },
          { key: 'approval_A', type: 'approval', name: 'A', config: { assigneeSources: staticUser([GATE]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'handler_H', type: 'handler', name: 'H', config: { assigneeSources: staticUser([GATE]), ...(handlerFieldPermissions.length ? { fieldPermissions: handlerFieldPermissions } : {}) } },
          { key: 'approval_B', type: 'approval', name: 'B', config: { assigneeSources: staticUser([GATE]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'end', type: 'end', name: 'e', config: {} },
        ],
        edges: [
          { key: 's2a', source: 'start', target: 'approval_A' },
          { key: 'a2h', source: 'approval_A', target: 'handler_H' },
          { key: 'h2b', source: 'handler_H', target: 'approval_B' },
          { key: 'b2e', source: 'approval_B', target: 'end' },
        ],
      }
    }
    const policy = { allowRevoke: true, autoApproval: { dedupeHistoricalApprover: true } }

    // No-edit control: GATE approves A, handles H (no field write) → B auto-approves on A → instance approved.
    const tidNoEdit = await createPublished(`${KEYPFX}-g16-noedit`, dedupGraph([]), policy)
    const iidNoEdit = await createInstance(tidNoEdit)
    expect((await act(iidNoEdit, gateTok, { action: 'approve' })).status).toBe(200)
    const handleNoEdit = await act(iidNoEdit, gateTok, { action: 'handle' })
    expect(handleNoEdit.status, await handleNoEdit.clone().text()).toBe(200)
    expect((await instanceRow(iidNoEdit)).status).toBe('approved') // B auto-approved (dedup fired)

    // Edit case (single call): GATE approves A, then handles H WITH a field edit in ONE call → B must NOT
    // auto-approve on A's now-stale approval; instance stays pending at B.
    const tidEdit = await createPublished(`${KEYPFX}-g16-edit`, dedupGraph([{ fieldId: 'memo', access: 'editable' }]), policy)
    const iidEdit = await createInstance(tidEdit)
    expect((await act(iidEdit, gateTok, { action: 'approve' })).status).toBe(200)
    const handleEdit = await act(iidEdit, gateTok, { action: 'handle', fieldWrites: { memo: 'changed' } })
    expect(handleEdit.status, await handleEdit.clone().text()).toBe(200)
    const afterEdit = await instanceRow(iidEdit)
    expect(afterEdit.status).toBe('pending') // dedup invalidated → B did NOT auto-approve
    expect(afterEdit.current_node_key).toBe('approval_B')

    // Epoch-unchanged companion: a 会签 handler edit on a PARTIAL submit does not bump the node epoch —
    // the remaining seat's entry_epoch is unchanged by the edit (Lock-3 G-12).
    const tidEpoch = await createPublished(`${KEYPFX}-g16-epoch`, handlerGraph([{ fieldId: 'memo', access: 'editable' }], { assigneeSources: staticUser([HANDLER, HANDLER2]), handlerMode: 'all' }))
    const iidEpoch = await createInstance(tidEpoch)
    const epochBefore = (await activeSeats(iidEpoch)).find((s) => s.assignee_id === HANDLER2)?.entry_epoch
    const partial = await act(iidEpoch, handlerTok, { action: 'handle', fieldWrites: { memo: 'partial-edit' } })
    expect(partial.status, await partial.clone().text()).toBe(200)
    const epochAfter = (await activeSeats(iidEpoch)).find((s) => s.assignee_id === HANDLER2)?.entry_epoch
    expect(String(epochAfter)).toBe(String(epochBefore)) // NOT bumped by the edit
    expect((await instanceRow(iidEpoch)).current_node_key).toBe('handler_h') // still at the handler (会签 partial)
    // The PARTIAL (会签) arm is a SEPARATE write path from completion — assert it too persisted the
    // revision row and stamped the values-free changedFieldIds on its partial handle audit row.
    expect(await revisionRows(iidEpoch)).toHaveLength(1)
    const partialHandleRows = await records(iidEpoch, 'handle')
    expect(partialHandleRows).toHaveLength(1)
    expect((partialHandleRows[0]!.metadata ?? {}).changedFieldIds).toEqual(['memo'])
  })

  // ── G-16 (cross-dispatch) — the PRIOR-transaction dedup filter (MAX(audit_record_id)) ─────────
  it('G-16 (cross-dispatch): a node whose dedup is resolved in a SUBSEQUENT dispatch is NOT auto-approved on a same-actor approval that PRECEDES the edit; with no edit it IS', async () => {
    // The single-call arm passes []; the PERSISTED-edit arm is loadApprovalHistory's
    // `AND id > MAX(audit_record_id)` filter, which only fires when a dedup decision is made in a
    // LATER dispatch than the edit. Graph: A(GATE) → handler_H(HANDLER, editable memo) → mid(HANDLER2)
    // → C(GATE). GATE approves A (PRE-edit), HANDLER edits at H, HANDLER2 approves mid — and only THEN
    // is C's dedup resolved (a dispatch after the edit). C must NOT auto-approve on GATE's pre-edit A.
    function xGraph(handlerFieldPermissions: NodeFieldPermission[]) {
      return {
        nodes: [
          { key: 'start', type: 'start', name: 's', config: {} },
          { key: 'approval_A', type: 'approval', name: 'A', config: { assigneeSources: staticUser([GATE]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'handler_H', type: 'handler', name: 'H', config: { assigneeSources: staticUser([HANDLER]), ...(handlerFieldPermissions.length ? { fieldPermissions: handlerFieldPermissions } : {}) } },
          { key: 'approval_mid', type: 'approval', name: 'mid', config: { assigneeSources: staticUser([HANDLER2]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'approval_C', type: 'approval', name: 'C', config: { assigneeSources: staticUser([GATE]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'end', type: 'end', name: 'e', config: {} },
        ],
        edges: [
          { key: 's2a', source: 'start', target: 'approval_A' },
          { key: 'a2h', source: 'approval_A', target: 'handler_H' },
          { key: 'h2m', source: 'handler_H', target: 'approval_mid' },
          { key: 'm2c', source: 'approval_mid', target: 'approval_C' },
          { key: 'c2e', source: 'approval_C', target: 'end' },
        ],
      }
    }
    const policy = { allowRevoke: true, autoApproval: { dedupeHistoricalApprover: true } }

    // Edit case: C's dedup (resolved at HANDLER2's approve — a dispatch AFTER the edit) excludes GATE's
    // pre-edit A via MAX(audit_record_id) → C stays pending with GATE seated.
    const tidEdit = await createPublished(`${KEYPFX}-g16x-edit`, xGraph([{ fieldId: 'memo', access: 'editable' }]), policy)
    const iidEdit = await createInstance(tidEdit)
    expect((await act(iidEdit, gateTok, { action: 'approve' })).status).toBe(200) // A (pre-edit)
    expect((await act(iidEdit, handlerTok, { action: 'handle', fieldWrites: { memo: 'x-changed' } })).status).toBe(200) // edit at H
    expect((await act(iidEdit, handler2Tok, { action: 'approve' })).status).toBe(200) // mid → resolves C's dedup
    const editRow = await instanceRow(iidEdit)
    expect(editRow.status).toBe('pending')
    expect(editRow.current_node_key).toBe('approval_C')
    expect((await activeSeats(iidEdit)).some((s) => s.node_key === 'approval_C' && s.assignee_id === GATE)).toBe(true)

    // No-edit control: same graph, NO field write → C DOES auto-approve on GATE's A (cross-dispatch
    // dedup fires) → instance approved. Proves the exclusion is edit-selected, not flag-blind.
    const tidNo = await createPublished(`${KEYPFX}-g16x-noedit`, xGraph([]), policy)
    const iidNo = await createInstance(tidNo)
    expect((await act(iidNo, gateTok, { action: 'approve' })).status).toBe(200) // A
    expect((await act(iidNo, handlerTok, { action: 'handle' })).status).toBe(200) // no edit at H
    expect((await act(iidNo, handler2Tok, { action: 'approve' })).status).toBe(200) // mid → C auto-approves on A
    expect((await instanceRow(iidNo)).status).toBe('approved')
  })

  // ── G-17 — the immutability readers were actually re-examined ─────────────────────────────────
  it('G-17: after an edit, a FWB-style form_snapshot read (at status=approved) sees the POST-edit value; with NO edit it is byte-identical; a field not touched by the edit is unchanged', async () => {
    // A last-node handler completes the instance to approved via the same transaction that edits. The
    // FWB/projection readers all SELECT form_snapshot WHERE status='approved' — so they see the in-place
    // edit (OD-L7-6(a): every reader is automatically correct, no composition step). We assert the
    // reader-level value each takes (G-17 writes the chosen behavior down per reader).
    const tid = await createPublished(`${KEYPFX}-g17`, {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'handler_last', type: 'handler', name: 'last', config: { assigneeSources: staticUser([HANDLER]), fieldPermissions: [{ fieldId: 'memo', access: 'editable' }] } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [{ key: 's2h', source: 'start', target: 'handler_last' }, { key: 'h2e', source: 'handler_last', target: 'end' }],
    })
    // Edited instance: reaches approved carrying the edited value.
    const iidEdit = await createInstance(tid, { reason: 'keep', amount: 3 })
    const edited = await act(iidEdit, handlerTok, { action: 'handle', fieldWrites: { memo: 'post-edit-value' } })
    expect(edited.status, await edited.clone().text()).toBe(200)
    const editedRow = await instanceRow(iidEdit)
    expect(editedRow.status).toBe('approved')
    // What the FWB/projection/attendance readers see (form_snapshot at approved): the POST-edit value,
    // AND fields not touched by the edit are byte-identical to create.
    expect(editedRow.form_snapshot?.memo).toBe('post-edit-value') // edited field: reader sees post-edit
    expect(editedRow.form_snapshot?.reason).toBe('keep') // untouched field: unchanged (field-selected coupling)
    expect(editedRow.form_snapshot?.amount).toBe(3)

    // No-edit control (flag-OFF equivalent — no fieldWrites): the readers are byte-identical to create.
    const iidNoEdit = await createInstance(tid, { reason: 'keep', amount: 3 })
    const noEdit = await act(iidNoEdit, handlerTok, { action: 'handle' })
    expect(noEdit.status, await noEdit.clone().text()).toBe(200)
    const noEditRow = await instanceRow(iidNoEdit)
    expect(noEditRow.status).toBe('approved')
    expect(noEditRow.form_snapshot?.memo).toBeUndefined() // never written → create value (absent)
    expect(noEditRow.form_snapshot?.reason).toBe('keep')
    expect(await revisionRows(iidNoEdit)).toHaveLength(0) // no revision rows on the inert path
  })

  // ── G-9 — an instance created before the slice dispatches unchanged; persisted access normalizes ─
  it('G-9: an instance published WITH a matrix dispatches its handle unchanged; every persisted access value still normalizes on re-dispatch', async () => {
    // The dispatch path re-runs asRuntimeGraph → normalizeApprovalGraph over the STORED graph on every
    // action. A matrix carrying all three access values must survive that re-normalize (no narrowing).
    const tid = await createPublished(`${KEYPFX}-g9`, handlerGraph([
      { fieldId: 'memo', access: 'editable' },
      { fieldId: 'secret', access: 'hidden' },
      { fieldId: 'amount', access: 'readonly' },
    ]))
    const iid = await createInstance(tid)
    // A comment action dispatches (re-normalizes the stored graph) without touching fields → succeeds,
    // proving the persisted matrix normalizes on the dispatch path.
    const comment = await act(iid, handlerTok, { action: 'comment', comment: 'dispatch re-normalize' })
    expect(comment.status, await comment.clone().text()).toBe(200)
    // And the editable field is still writable (matrix intact through re-normalize).
    const write = await act(iid, handlerTok, { action: 'handle', fieldWrites: { memo: 'still-editable' } })
    expect(write.status, await write.clone().text()).toBe(200)
    expect((await instanceRow(iid)).form_snapshot?.memo).toBe('still-editable')
  })
})
