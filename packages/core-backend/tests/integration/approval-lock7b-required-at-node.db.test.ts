import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'
import { NODE_FIELD_ACCESS_WRITABLE_VALUES } from '../../src/types/approval-product'

/**
 * Lock-7B (docs/development/approval-lock7b-required-at-node-20260820.md) — node-level `required`
 * field tier (必填), REAL-DB end-to-end acceptance. Harness mirrors approval-field-edit-enforcement.db
 * .test.ts (Lock-7's sibling suite).
 *
 * Gates covered here (behaviourally testable end-to-end, real handler-submit transaction): G-5
 * (submit 422 + atomicity), G-9b (fail-closed schema-load-unreachable, NULL template_version_id), G-9c
 * (effective snapshot reconstruction), G-10 (snapshot-selected not writer-selected), G-10b (per-submit
 * under 会签), G-10c (absent-fieldWrites-key bypass closed, with the zero-extra-query positive
 * control), G-11 (emptiness = create-time isEmptyValue, holes disclosed), G-12 (author-configured
 * invisibility does not deadlock), G-12b (actor-induced invisibility does not discharge the
 * obligation), G-13 (legacy byte-identity), G-16 (the DTO's writable-set promise, behaviourally).
 *
 * NOT here (covered elsewhere): G-1/G-2/G-6/G-7/G-8 (publish-time, DB-mocked unit tests in
 * approval-product-service.test.ts — no DB behaviour to prove); G-3/G-4 read-axis (approval-form-
 * redaction.test.ts unit); G-14/G-14b (approval-field-access-enum-mirror.test.ts + CI); G-15 FE
 * (approval-handler-node-config.spec.ts / approval-template-authoring-canvas-inspector.spec.ts).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `l7b-req-${TS}`
const HANDLER = `l7b-h-${TS}`
const HANDLER2 = `l7b-h2-${TS}`
const FINAL = `l7b-final-${TS}`
const KEYPFX = `l7b-${TS}`

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

// Declaration order matters (§1.3 "first empty candidate"): `secret` precedes `gate_field` precedes
// `driver_field` precedes `reveal_field`. `amount` drives `gate_field`'s rule; `driver_field` drives
// `reveal_field`'s rule and is a PLAIN writable field (never a routing driver).
const FORM_SCHEMA = {
  fields: [
    { id: 'reason', type: 'text', label: 'reason', required: true },
    { id: 'secret', type: 'text', label: 'secret' },
    { id: 'amount', type: 'number', label: 'amount' },
    { id: 'gate_field', type: 'text', label: 'gate_field', visibilityRule: { fieldId: 'amount', operator: 'eq', value: 999 } },
    { id: 'driver_field', type: 'text', label: 'driver_field' },
    { id: 'reveal_field', type: 'text', label: 'reveal_field', visibilityRule: { fieldId: 'driver_field', operator: 'eq', value: 'show' } },
    // G-11's EMPTY-array arm needs a field type whose validator actually accepts an array value —
    // `text` rejects `[]` at the type level (400) before the required check is ever reached.
    { id: 'tags', type: 'multi-select', label: 'tags', options: [{ label: 'A', value: 'a' }] },
  ],
}

function staticUser(userIds: string[]) {
  return [{ kind: 'static_user', userIds }]
}

type NodeFieldPermission = { fieldId: string; access: 'editable' | 'readonly' | 'hidden' | 'required' }

// start -> handler_h(fieldPermissions) -> approval_final -> end. Single handler seat unless
// `handlerConfig.assigneeSources` is overridden (see the G-10b two-seat variant below).
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

function twoSeatHandlerGraph(handlerFieldPermissions: NodeFieldPermission[]) {
  return handlerGraph(handlerFieldPermissions, { assigneeSources: staticUser([HANDLER, HANDLER2]), handlerMode: 'all' })
}

type ErrorBody = { code?: string; error?: { code?: string; message?: string; details?: Record<string, unknown> } }
function errorCode(body: ErrorBody): string | undefined {
  return body.code ?? body.error?.code
}
function errorDetails(body: ErrorBody): Record<string, unknown> | undefined {
  return body.error?.details
}

// ── Anti-skip-green sentinel (mirrors approval-realdb-field-edit / approval-realdb-handler) ────────
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

describeIfDatabase('Lock-7B node-level required field tier (必填) — real-DB acceptance', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqTok = ''
  let handlerTok = ''
  let handler2Tok = ''
  let finalTok = ''
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
  // Raw fetch bypassing JSON.stringify's `fieldWrites` key entirely — proves the ABSENT-key payload
  // shape (the shipped pre-Lock-7 shape, and the dominant one), distinct from `fieldWrites: {}`.
  async function actNoFieldWritesKey(iid: string, token: string, action = 'handle', comment?: string): Promise<Response> {
    const body: Record<string, unknown> = { action }
    if (comment !== undefined) body.comment = comment
    return act(iid, token, body)
  }
  async function instanceRow(iid: string): Promise<{ status: string; current_node_key: string | null; version: number; form_snapshot: Record<string, unknown> | null; template_version_id: string | null }> {
    const pool = poolManager.get()
    const rows = await pool.query(`SELECT status, current_node_key, version, form_snapshot, template_version_id::text AS template_version_id FROM approval_instances WHERE id = $1`, [iid])
    return rows.rows[0] as { status: string; current_node_key: string | null; version: number; form_snapshot: Record<string, unknown> | null; template_version_id: string | null }
  }
  async function nullifyTemplateVersionId(iid: string): Promise<void> {
    const pool = poolManager.get()
    // §2.1 residual 2 / G-9b — `template_version_id` is nullable and INDEPENDENT of
    // `published_definition_id` (the runtime graph's own source column, left untouched here).
    await pool.query(`UPDATE approval_instances SET template_version_id = NULL WHERE id = $1`, [iid])
  }
  async function records(iid: string, action?: string): Promise<Array<{ action: string; actor_id: string | null; metadata: Record<string, unknown> | null }>> {
    const pool = poolManager.get()
    const rows = action
      ? await pool.query(`SELECT action, actor_id, metadata FROM approval_records WHERE instance_id = $1 AND action = $2 ORDER BY id ASC`, [iid, action])
      : await pool.query(`SELECT action, actor_id, metadata FROM approval_records WHERE instance_id = $1 ORDER BY id ASC`, [iid])
    return rows.rows as Array<{ action: string; actor_id: string | null; metadata: Record<string, unknown> | null }>
  }
  async function revisionRows(iid: string): Promise<Array<{ field_id: string }>> {
    const pool = poolManager.get()
    const rows = await pool.query(`SELECT field_id FROM approval_form_field_revisions WHERE instance_id = $1 ORDER BY id ASC`, [iid])
    return rows.rows as Array<{ field_id: string }>
  }
  async function activeSeats(iid: string): Promise<Array<{ assignee_id: string; node_key: string | null }>> {
    const pool = poolManager.get()
    const rows = await pool.query(`SELECT assignee_id, node_key FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE ORDER BY assignee_id`, [iid])
    return rows.rows as Array<{ assignee_id: string; node_key: string | null }>
  }

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    const pool = poolManager.get()
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`)
    for (const userId of [REQ, HANDLER, HANDLER2, FINAL]) {
      await pool.query(`INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'x', TRUE) ON CONFLICT (id) DO NOTHING`, [userId, `${userId}@x.test`])
    }
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
    handlerTok = await tok(base, HANDLER)
    handler2Tok = await tok(base, HANDLER2)
    finalTok = await tok(base, FINAL)
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
      await pool.query(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [[REQ, HANDLER, HANDLER2, FINAL]])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  // ── G-5 — submit 422 when required field is empty after writes; ATOMIC rollback ────────────────
  it('G-5: handler submits with the required field empty -> 422, zero snapshot/revision/audit/assignment change, unchanged version', async () => {
    const tid = await createPublished(`${KEYPFX}-g5`, handlerGraph([{ fieldId: 'secret', access: 'required' }]))
    const iid = await createInstance(tid)
    const before = await instanceRow(iid)

    const res = await act(iid, handlerTok, { action: 'handle', fieldWrites: { secret: '' } })
    expect(res.status, await res.clone().text()).toBe(422)
    const body = (await res.json()) as ErrorBody
    expect(errorCode(body)).toBe('APPROVAL_HANDLER_REQUIRED_FIELD_EMPTY')
    expect(errorDetails(body)).toEqual({ nodeKey: 'handler_h', fieldId: 'secret' })

    const after = await instanceRow(iid)
    expect(after).toEqual(before) // zero snapshot / status / version / node change
    expect(await records(iid, 'handle')).toEqual([])
    expect(await revisionRows(iid)).toEqual([])
    expect(await activeSeats(iid)).toEqual([{ assignee_id: HANDLER, node_key: 'handler_h' }]) // seat untouched

    // Success path in the SAME fixture changes all five — the rollback above is not a no-op comparison.
    const ok = await act(iid, handlerTok, { action: 'handle', fieldWrites: { secret: 'filled' } })
    expect(ok.status, await ok.clone().text()).toBe(200)
    const afterOk = await instanceRow(iid)
    expect(afterOk.form_snapshot?.secret).toBe('filled')
    expect(afterOk.version).not.toBe(before.version)
    expect(afterOk.current_node_key).not.toBe(before.current_node_key)
    expect((await records(iid, 'handle')).length).toBeGreaterThan(0)
    expect((await revisionRows(iid)).map((r) => r.field_id)).toContain('secret')
    // The handler's own seat is deactivated; the node advanced to approval_final, which activates a
    // NEW seat there — not an empty set.
    expect(await activeSeats(iid)).toEqual([{ assignee_id: FINAL, node_key: 'approval_final' }])
  })

  // ── G-9b — fail-closed when the frozen schema is unreachable (NULL template_version_id) ────────
  // Also discharges G-10c's "zero extra query" positive control: the SAME NULL-template_version_id
  // instance, on a template with NO `required` entry and no `fieldWrites` key, still 200s — proving
  // the conditional hoist never issued the SELECT for it (had it, this instance would 409 too).
  it('G-9b/G-10c: NULL template_version_id + a `required` entry -> 409 fail-closed; the SAME NULL row on a template with NO required entry (key-absent payload) -> 200 unchanged', async () => {
    const tidRequired = await createPublished(`${KEYPFX}-g9b-required`, handlerGraph([{ fieldId: 'secret', access: 'required' }]))
    const iidRequired = await createInstance(tidRequired)
    await nullifyTemplateVersionId(iidRequired)
    expect((await instanceRow(iidRequired)).template_version_id).toBeNull()

    const res = await actNoFieldWritesKey(iidRequired, handlerTok)
    expect(res.status, await res.clone().text()).toBe(409)
    const body = (await res.json()) as ErrorBody
    expect(errorCode(body)).toBe('APPROVAL_FROZEN_SCHEMA_NOT_FOUND')
    expect(errorDetails(body)).toEqual({ nodeKey: 'handler_h' }) // values-free
    // Transaction rolled back: the node did not advance.
    expect((await instanceRow(iidRequired)).current_node_key).toBe('handler_h')

    const tidLegacy = await createPublished(`${KEYPFX}-g9b-legacy`, handlerGraph([]))
    const iidLegacy = await createInstance(tidLegacy)
    await nullifyTemplateVersionId(iidLegacy)
    const before = await instanceRow(iidLegacy)
    expect(before.template_version_id).toBeNull()

    const legacyRes = await actNoFieldWritesKey(iidLegacy, handlerTok)
    // 200: the schema SELECT never ran for this instance (the conditional hoist is opt-in), which is
    // exactly what makes the NULL template_version_id harmless here — if it HAD run, this would 409
    // exactly like the sibling above.
    expect(legacyRes.status, await legacyRes.clone().text()).toBe(200)
    const after = await instanceRow(iidLegacy)
    expect(after.current_node_key).not.toBe('handler_h') // advanced normally
    expect(after.form_snapshot).toEqual(before.form_snapshot) // byte-identical snapshot
  })

  // ── G-9c — the effective snapshot is RECONSTRUCTED, not re-read un-merged ───────────────────────
  it('G-9c: requester leaves the field EMPTY at create; only the handler\'s OWN write satisfies it in the SAME submit -> 200', async () => {
    const tid = await createPublished(`${KEYPFX}-g9c`, handlerGraph([{ fieldId: 'secret', access: 'required' }]))
    const iid = await createInstance(tid, { reason: 'r', secret: '' })
    const res = await act(iid, handlerTok, { action: 'handle', fieldWrites: { secret: 'now-set' } })
    expect(res.status, await res.clone().text()).toBe(200)
    expect((await instanceRow(iid)).form_snapshot?.secret).toBe('now-set')

    // Reverse fixture (G-10's own case, re-confirmed here): requester filled, handler writes nothing.
    const iid2 = await createInstance(tid, { reason: 'r', secret: 'from-requester' })
    const res2 = await act(iid2, handlerTok, { action: 'handle', fieldWrites: {} })
    expect(res2.status, await res2.clone().text()).toBe(200)
  })

  // ── G-10 — satisfaction is SNAPSHOT-selected, not WRITER-selected ──────────────────────────────
  it('G-10: (a) requester pre-filled + empty fieldWrites -> 200; (b) handler fills it -> 200; (c) neither -> 422', async () => {
    const tid = await createPublished(`${KEYPFX}-g10`, handlerGraph([{ fieldId: 'secret', access: 'required' }]))

    const iidA = await createInstance(tid, { reason: 'r', secret: 'requester-filled' })
    const resA = await act(iidA, handlerTok, { action: 'handle', fieldWrites: {} })
    expect(resA.status, await resA.clone().text()).toBe(200)

    const iidB = await createInstance(tid, { reason: 'r' })
    const resB = await act(iidB, handlerTok, { action: 'handle', fieldWrites: { secret: 'handler-filled' } })
    expect(resB.status, await resB.clone().text()).toBe(200)

    const iidC = await createInstance(tid, { reason: 'r' })
    const resC = await act(iidC, handlerTok, { action: 'handle', fieldWrites: {} })
    expect(resC.status).toBe(422)
    expect(errorCode((await resC.json()) as ErrorBody)).toBe('APPROVAL_HANDLER_REQUIRED_FIELD_EMPTY')
  })

  // ── G-10b — the obligation is PER-SUBMIT under 会签, not only the completing submit ─────────────
  it('G-10b: two-seat 会签 node — the FIRST seat 422s on an empty required field (no partial handle recorded); once filled, the first seat completes a PARTIAL handle and the second seat completes the node', async () => {
    const tid = await createPublished(`${KEYPFX}-g10b`, twoSeatHandlerGraph([{ fieldId: 'secret', access: 'required' }]))
    const iid = await createInstance(tid)

    const empty = await act(iid, handlerTok, { action: 'handle', fieldWrites: {} })
    expect(empty.status, await empty.clone().text()).toBe(422)
    expect(errorCode((await empty.json()) as ErrorBody)).toBe('APPROVAL_HANDLER_REQUIRED_FIELD_EMPTY')
    expect(await records(iid, 'handle')).toEqual([]) // no partial handle recorded
    expect((await activeSeats(iid)).map((s) => s.assignee_id).sort()).toEqual([HANDLER, HANDLER2].sort())

    const partial = await act(iid, handlerTok, { action: 'handle', fieldWrites: { secret: 'filled-by-seat-1' } })
    expect(partial.status, await partial.clone().text()).toBe(200)
    const afterPartial = await instanceRow(iid)
    expect(afterPartial.current_node_key).toBe('handler_h') // still pending — 会签 not complete
    expect((await activeSeats(iid)).map((s) => s.assignee_id)).toEqual([HANDLER2])

    // Second seat: field already satisfied (from seat 1's write) — no re-check needed to complete.
    const complete = await act(iid, handler2Tok, { action: 'handle', fieldWrites: {} })
    expect(complete.status, await complete.clone().text()).toBe(200)
    expect((await instanceRow(iid)).current_node_key).not.toBe('handler_h')

    // Positive control: the identical two-seat fixture with NO required entry records both handles
    // unchanged (partial then completing), proving the required check adds no OTHER side effect.
    const tidLegacy = await createPublished(`${KEYPFX}-g10b-legacy`, twoSeatHandlerGraph([]))
    const iidLegacy = await createInstance(tidLegacy)
    const p1 = await act(iidLegacy, handlerTok, { action: 'handle', fieldWrites: {} })
    expect(p1.status, await p1.clone().text()).toBe(200)
    expect((await instanceRow(iidLegacy)).current_node_key).toBe('handler_h')
    const p2 = await act(iidLegacy, handler2Tok, { action: 'handle', fieldWrites: {} })
    expect(p2.status, await p2.clone().text()).toBe(200)
    expect((await instanceRow(iidLegacy)).current_node_key).not.toBe('handler_h')
  })

  // ── G-10c — the check cannot be skipped by OMITTING the fieldWrites key ────────────────────────
  it('G-10c: a handle payload with NO fieldWrites key at all -> 422 when empty; -> 200 when the requester already filled it', async () => {
    const tid = await createPublished(`${KEYPFX}-g10c`, handlerGraph([{ fieldId: 'secret', access: 'required' }]))

    const iidEmpty = await createInstance(tid, { reason: 'r' })
    const resEmpty = await actNoFieldWritesKey(iidEmpty, handlerTok)
    expect(resEmpty.status, await resEmpty.clone().text()).toBe(422)
    expect(errorCode((await resEmpty.json()) as ErrorBody)).toBe('APPROVAL_HANDLER_REQUIRED_FIELD_EMPTY')

    const iidFilled = await createInstance(tid, { reason: 'r', secret: 'requester-filled' })
    const resFilled = await actNoFieldWritesKey(iidFilled, handlerTok)
    expect(resFilled.status, await resFilled.clone().text()).toBe(200)
  })

  // ── G-11 — emptiness = the create-time isEmptyValue definition, arm by arm ──────────────────────
  // The per-arm SOURCE mutation of `isEmptyValue` itself (each disjunct deleted independently,
  // proving it reds BOTH the matching create-time fixture and this node-time fixture) is asserted at
  // the unit level in approval-graph-executor.test.ts's "isEmptyValue" describe block, which shares
  // this exact predicate with `validateApprovalFormData`'s create-time required check — there is only
  // ONE definition to mutate, so a red there is a red here by construction. `false`/`{}` are NOT
  // reachable through this schema's TYPED write validators for a `text`/`number`/`multi-select` field
  // (a `text` field DOES accept `{}` per `validateFieldType`'s `isRecord(value)` arm, exercised below;
  // `false` fails every declared field type's validator before the required check is ever reached, so
  // its non-empty-hole disclosure is unit-only).
  it('G-11: `\'\'`, `null`, an empty array, and an absent key each 422; `0`, whitespace, and `{}` are NON-empty at the node (matching create)', async () => {
    const tid = await createPublished(`${KEYPFX}-g11`, handlerGraph([{ fieldId: 'secret', access: 'required' }]))
    const tidTags = await createPublished(`${KEYPFX}-g11-tags`, handlerGraph([{ fieldId: 'tags', access: 'required' }]))

    for (const value of ['', null]) {
      const iid = await createInstance(tid, { reason: 'r' })
      const res = await act(iid, handlerTok, { action: 'handle', fieldWrites: { secret: value } })
      expect(res.status, `value=${JSON.stringify(value)}: ${await res.clone().text()}`).toBe(422)
    }
    {
      const iid = await createInstance(tidTags, { reason: 'r' })
      const res = await act(iid, handlerTok, { action: 'handle', fieldWrites: { tags: [] } })
      expect(res.status, `value=[]: ${await res.clone().text()}`).toBe(422)
    }
    // Absent key entirely (not sent in fieldWrites) is the SAME as unfilled.
    {
      const iid = await createInstance(tid, { reason: 'r' })
      const res = await act(iid, handlerTok, { action: 'handle', fieldWrites: {} })
      expect(res.status).toBe(422)
    }

    // Disclosed non-empty holes (§0.2) — inherited from create-time, not re-derived stricter. Each
    // value goes to a field type whose OWN validator actually accepts it (`0` needs `number`; a
    // whitespace string and `{}` are both valid `text` values per `validateFieldType`'s
    // `typeof value === 'string' || isRecord(value)` arm).
    for (const value of ['   ', {}]) {
      const iid = await createInstance(tid, { reason: 'r' })
      const res = await act(iid, handlerTok, { action: 'handle', fieldWrites: { secret: value } })
      expect(res.status, `value=${JSON.stringify(value)} (create-time non-empty hole): ${await res.clone().text()}`).toBe(200)
    }
    {
      const tidAmount = await createPublished(`${KEYPFX}-g11-amount`, handlerGraph([{ fieldId: 'amount', access: 'required' }]))
      const iid = await createInstance(tidAmount, { reason: 'r' })
      const res = await act(iid, handlerTok, { action: 'handle', fieldWrites: { amount: 0 } })
      expect(res.status, `value=0 (create-time non-empty hole): ${await res.clone().text()}`).toBe(200)
    }
  })

  // ── G-12 — author-configured invisibility does not deadlock the node ───────────────────────────
  it('G-12: a required field whose OWN visibilityRule is unsatisfied on BOTH pre- and post-write is SKIPPED (not enforced); the same field with the rule satisfied 422s in the same fixture', async () => {
    const tid = await createPublished(`${KEYPFX}-g12`, handlerGraph([{ fieldId: 'gate_field', access: 'required' }]))

    // amount never set to 999 -> gate_field invisible at both points -> skipped -> 200.
    const iidInvisible = await createInstance(tid, { reason: 'r' })
    const resInvisible = await act(iidInvisible, handlerTok, { action: 'handle', fieldWrites: {} })
    expect(resInvisible.status, await resInvisible.clone().text()).toBe(200)

    // Discriminating pair: amount = 999 at CREATE (gate_field visible from the start) -> enforced -> 422.
    const iidVisible = await createInstance(tid, { reason: 'r', amount: 999 })
    const resVisible = await act(iidVisible, handlerTok, { action: 'handle', fieldWrites: {} })
    expect(resVisible.status).toBe(422)
    expect(errorDetails((await resVisible.json()) as ErrorBody)).toEqual({ nodeKey: 'handler_h', fieldId: 'gate_field' })
  })

  // ── G-12b — ACTOR-induced invisibility does NOT discharge the obligation (union semantics) ─────
  it('G-12b: (a) actor HIDES a pre-visible required field -> still 422 (union keeps it enforced); (b) actor REVEALS a pre-invisible one and leaves it empty -> 422; (c) same as (b) but filled -> 200; (d) invisible throughout, untouched -> 200 (G-12 re-asserted)', async () => {
    const tid = await createPublished(`${KEYPFX}-g12b`, handlerGraph([{ fieldId: 'reveal_field', access: 'required' }]))

    // (a) driver_field='show' at CREATE -> reveal_field visible pre-write. Actor writes driver_field
    // to hide it and leaves reveal_field empty -> still 422 (pre-write visibility keeps it enforced).
    const iidA = await createInstance(tid, { reason: 'r', driver_field: 'show' })
    const resA = await act(iidA, handlerTok, { action: 'handle', fieldWrites: { driver_field: 'hide-now' } })
    expect(resA.status, await resA.clone().text()).toBe(422)
    expect(errorDetails((await resA.json()) as ErrorBody)).toEqual({ nodeKey: 'handler_h', fieldId: 'reveal_field' })

    // (b) driver_field starts NOT 'show' -> reveal_field invisible pre-write. Actor reveals it
    // (writes driver_field='show') and leaves reveal_field empty -> 422 (post-write visibility).
    const iidB = await createInstance(tid, { reason: 'r', driver_field: 'nope' })
    const resB = await act(iidB, handlerTok, { action: 'handle', fieldWrites: { driver_field: 'show' } })
    expect(resB.status, await resB.clone().text()).toBe(422)
    expect(errorDetails((await resB.json()) as ErrorBody)).toEqual({ nodeKey: 'handler_h', fieldId: 'reveal_field' })

    // (c) same as (b), but reveal_field is ALSO filled in the same submit -> 200.
    const iidC = await createInstance(tid, { reason: 'r', driver_field: 'nope' })
    const resC = await act(iidC, handlerTok, { action: 'handle', fieldWrites: { driver_field: 'show', reveal_field: 'now-filled' } })
    expect(resC.status, await resC.clone().text()).toBe(200)

    // (d) invisible at both points, driver_field untouched -> 200 (G-12's own case).
    const iidD = await createInstance(tid, { reason: 'r', driver_field: 'nope' })
    const resD = await act(iidD, handlerTok, { action: 'handle', fieldWrites: {} })
    expect(resD.status, await resD.clone().text()).toBe(200)

    // Positive control: the identical four-case fixture with NO required entry records 200 in all
    // four cases and writes driver_field exactly as instructed.
    const tidLegacy = await createPublished(`${KEYPFX}-g12b-legacy`, handlerGraph([]))
    const legacyA = await createInstance(tidLegacy, { reason: 'r', driver_field: 'show' })
    const legacyResA = await act(legacyA, handlerTok, { action: 'handle', fieldWrites: { driver_field: 'hide-now' } })
    expect(legacyResA.status, await legacyResA.clone().text()).toBe(200)
    expect((await instanceRow(legacyA)).form_snapshot?.driver_field).toBe('hide-now')
  })

  // ── G-13 — legacy graphs (no `required` entry) are byte-identical ──────────────────────────────
  it('G-13: a template with NO `required` entry behaves byte-identically before/after; the SAME fixture WITH a required entry diverges', async () => {
    const legacyGraph = handlerGraph([])
    const tidLegacy = await createPublished(`${KEYPFX}-g13-legacy`, legacyGraph)
    const iidLegacy = await createInstance(tidLegacy, { reason: 'r' })
    const resLegacy = await actNoFieldWritesKey(iidLegacy, handlerTok)
    expect(resLegacy.status, await resLegacy.clone().text()).toBe(200)
    const afterLegacy = await instanceRow(iidLegacy)
    expect(afterLegacy.current_node_key).not.toBe('handler_h')
    expect(afterLegacy.form_snapshot).toEqual({ reason: 'r' })

    // Fetch the detail read too — fieldAccess payload bytes for a legacy (no-permissions) node.
    const detailLegacy = await req(base, `/api/approvals/${iidLegacy}`, reqTok)
    expect(detailLegacy.status).toBe(200)
    const detailLegacyBody = (await detailLegacy.json()) as { fieldAccess?: Record<string, string> | null }
    expect(detailLegacyBody.fieldAccess ?? null).toEqual(null) // no matrix at all -> no map (or empty)

    // Divergence: the SAME shape WITH a required entry, unfilled -> 422 (byte-different).
    const tidRequired = await createPublished(`${KEYPFX}-g13-required`, handlerGraph([{ fieldId: 'secret', access: 'required' }]))
    const iidRequired = await createInstance(tidRequired, { reason: 'r' })
    const resRequired = await actNoFieldWritesKey(iidRequired, handlerTok)
    expect(resRequired.status).toBe(422)
  })

  // ── G-16 — the DTO's writable-set promise, behaviourally: every member the DTO reports WRITABLE
  //           at this seat is accepted by the write mask at the same node ───────────────────────
  //
  // Prior requalification finding R4 (P3): the shipped test hard-coded ONE member (`required`)
  // rather than iterating the exported `NODE_FIELD_ACCESS_WRITABLE_VALUES` set the lock's own G-16
  // text names as the mandated mechanism ("by iterating the exported writable set rather than by
  // listing members"), so nothing exercised `editable`'s write path at all — only `required`'s.
  // Iterating the constant closes that gap precisely: this drives a REAL end-to-end HTTP write
  // through `applyHandlerFieldWrites` for EACH current member and asserts it is accepted, rather than
  // trusting that the write mask's `NODE_FIELD_ACCESS_WRITABLE_VALUES.has(access)` call does what its
  // name implies. Mutation-verified: reverting that one call to a hand-written `access !== 'required'`
  // equality (byte-identical to the mask's OWN pre-Lock-7B shape) reds exactly this loop's `editable`
  // case, not the `required` one — the loop catches the write mask DIVERGING from the writable set for
  // an EXISTING member, which a bare "does the set contain N members" assertion would not. It does
  // NOT independently prove a HYPOTHETICAL future 5th member's write path in advance, since the mask
  // reads this SAME constant — widening the constant necessarily widens the mask in the same edit, so
  // there is no "set grows, mask lags" failure mode to catch there; iterating still means a 5th member
  // gets its own named test the moment one exists, rather than requiring a human to hand-add a case.
  for (const access of NODE_FIELD_ACCESS_WRITABLE_VALUES) {
    it(`G-16: fieldAccess reports \`secret\` as \`${access}\` (a NODE_FIELD_ACCESS_WRITABLE_VALUES member); a write to it is ACCEPTED (writable)`, async () => {
      const tid = await createPublished(`${KEYPFX}-g16-${access}`, handlerGraph([{ fieldId: 'secret', access }]))
      const iid = await createInstance(tid, { reason: 'r' })

      const detail = await req(base, `/api/approvals/${iid}`, handlerTok)
      expect(detail.status).toBe(200)
      const detailBody = (await detail.json()) as { fieldAccess?: Record<string, string> | null }
      expect(detailBody.fieldAccess?.secret).toBe(access)

      const write = await act(iid, handlerTok, { action: 'handle', fieldWrites: { secret: `writable-per-dto-${access}` } })
      expect(write.status, await write.clone().text()).toBe(200)
      expect((await instanceRow(iid)).form_snapshot?.secret).toBe(`writable-per-dto-${access}`)
    })
  }

  // Negative control for the loop above, so "every member passes" is not confusable with "the write
  // mask accepts everything regardless of access" — `readonly` (NOT in the writable set) must still
  // be refused at the SAME node shape the loop just proved accepts `editable`/`required`.
  it('G-16 negative control: `readonly` (not in NODE_FIELD_ACCESS_WRITABLE_VALUES) is REFUSED at the same node shape', async () => {
    const tid = await createPublished(`${KEYPFX}-g16-readonly-control`, handlerGraph([{ fieldId: 'secret', access: 'readonly' }]))
    const iid = await createInstance(tid, { reason: 'r' })
    const write = await act(iid, handlerTok, { action: 'handle', fieldWrites: { secret: 'should-not-write' } })
    expect(write.status).toBe(403)
    expect((await instanceRow(iid)).form_snapshot?.secret).toBeUndefined()
  })
})
