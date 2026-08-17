import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * L6-P1 (docs/development/approval-lock6-requester-global-policy-20260817.md §1) — real-DB,
 * whole-HTTP-stack proof that the template-authoring policy carrier round-trips SERVER-TRUTHFULLY,
 * not merely inside an FE-local pure function. Two shipped bugs made this NOT hold before this fix:
 *
 *   (1) `ApprovalTemplateDetailDTO` carried no `policy` field at all, so the authoring editor had
 *       nothing to hydrate `allowRevoke` from and hardcoded `true`;
 *   (2) `updateTemplate` (the PATCH `persistDraft()` calls before every publish) hardcoded its
 *       response's `publishedDefinition: null` REGARDLESS of the template's actual active
 *       published definition — so even a correct FE merge would have been handed a `null`
 *       `originalPolicy` to merge onto, one PATCH before the republish that needed it.
 *
 * This suite replays the REAL `confirmPublish` sequence — publish, GET (hydrate), PATCH
 * (persistDraft, unconditionally sent with formSchema+approvalGraph exactly like the FE's
 * `buildUpdateTemplatePayload`, so it takes the SAME "create a new draft version" branch the real
 * editor takes on every save), merge (the FE's `buildPublishPolicy` logic reproduced verbatim),
 * republish — and asserts an API-set `policy.autoApproval` (unreachable from any UI in this slice)
 * survives untouched while the editor-owned `allowRevoke` changes exactly when the editor changes
 * it (gates P-1 and P-2, docs/development/approval-lock6-requester-global-policy-20260817.md §3).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `l6p1-req-${TS}`

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

const FORM_SCHEMA = { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }] }
const LINEAR_GRAPH = {
  nodes: [
    { key: 'start', type: 'start', name: 's', config: {} },
    { key: 'approval_1', type: 'approval', name: 'a', config: { assigneeSources: [{ kind: 'static_user', userIds: [REQ] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'end', type: 'end', name: 'e', config: {} },
  ],
  edges: [
    { key: 's2a', source: 'start', target: 'approval_1' },
    { key: 'a2e', source: 'approval_1', target: 'end' },
  ],
}

type PolicyBody = { allowRevoke: boolean; revokeBeforeNodeKeys?: string[]; autoApproval?: Record<string, unknown> }
type TemplateDetailBody = { policy: PolicyBody | null; formSchema: unknown; approvalGraph: unknown }

// Reproduces `buildPublishPolicy` (apps/web/src/approvals/templateAuthoring.ts) exactly: MERGE
// onto the persisted policy, overlay only the editor-owned `allowRevoke`. This is the FE-side half
// of the fix, replayed here so the real-DB test proves the FULL round trip, not just the backend
// half in isolation.
function buildPublishPolicyFromDetail(detail: TemplateDetailBody, allowRevoke: boolean): PolicyBody {
  return { ...(detail.policy ?? {}), allowRevoke }
}

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

describeIfDatabase('L6-P1 policy carrier — real-DB publish/hydrate/PATCH/republish round trip', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqTok = ''

  async function createTemplate(key: string): Promise<string> {
    const created = await req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key, name: key, formSchema: FORM_SCHEMA, approvalGraph: LINEAR_GRAPH },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    return ((await created.json()) as { id: string }).id
  }
  async function publish(tid: string, policy: PolicyBody): Promise<Response> {
    return req(base, `/api/approval-templates/${tid}/publish`, reqTok, { method: 'POST', body: { policy } })
  }
  async function getDetail(tid: string): Promise<TemplateDetailBody> {
    const res = await req(base, `/api/approval-templates/${tid}`, reqTok)
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()) as TemplateDetailBody
  }
  // Mirrors the real FE's `persistDraft()` → PATCH with buildUpdateTemplatePayload, which ALWAYS
  // includes formSchema+approvalGraph (buildUpdateTemplatePayload = buildCreateTemplatePayload) —
  // so this always takes updateTemplate's "create a new draft version" branch, exactly like a real
  // editor save, never the version-unchanged branch.
  async function patchNoOp(tid: string, detail: TemplateDetailBody): Promise<TemplateDetailBody> {
    const res = await req(base, `/api/approval-templates/${tid}`, reqTok, {
      method: 'PATCH',
      body: { formSchema: detail.formSchema, approvalGraph: detail.approvalGraph },
    })
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()) as TemplateDetailBody
  }

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`l6p1-${TS}-%`])).rows.map((r) => r.id as string)
      if (tids.length > 0) {
        await pool.query(`DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])`, [tids])
        await pool.query(`DELETE FROM approval_templates WHERE id = ANY($1::uuid[])`, [tids])
      }
      await pool.query(`DELETE FROM users WHERE id = $1`, [REQ])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('P-1: GET reflects the PERSISTED allowRevoke — false stays false, true stays true (value-selected, not a constant)', async () => {
    const tidFalse = await createTemplate(`l6p1-${TS}-p1-false`)
    const pubFalse = await publish(tidFalse, { allowRevoke: false })
    expect(pubFalse.status, await pubFalse.clone().text()).toBe(200)
    const detailFalse = await getDetail(tidFalse)
    expect(detailFalse.policy?.allowRevoke).toBe(false)

    // Positive control: the SAME flow with `true` stays `true`.
    const tidTrue = await createTemplate(`l6p1-${TS}-p1-true`)
    const pubTrue = await publish(tidTrue, { allowRevoke: true })
    expect(pubTrue.status, await pubTrue.clone().text()).toBe(200)
    const detailTrue = await getDetail(tidTrue)
    expect(detailTrue.policy?.allowRevoke).toBe(true)
  })

  it('P-1: republish through the editor WITHOUT touching the control keeps allowRevoke:false', async () => {
    const tid = await createTemplate(`l6p1-${TS}-p1-roundtrip`)
    await publish(tid, { allowRevoke: false })

    // "reload the editor" — GET hydrates the draft's originalPolicy.
    const hydrated = await getDetail(tid)
    expect(hydrated.policy?.allowRevoke).toBe(false)

    // "republish without touching the control" — the merge overlays the SAME hydrated value.
    const merged = buildPublishPolicyFromDetail(hydrated, hydrated.policy!.allowRevoke)
    const republished = await publish(tid, merged)
    expect(republished.status, await republished.clone().text()).toBe(200)

    const final = await getDetail(tid)
    expect(final.policy?.allowRevoke).toBe(false)
  })

  it('P-2: an API-set policy.autoApproval survives PATCH (persistDraft) then a republish untouched, while allowRevoke DOES change when the editor changes it', async () => {
    const tid = await createTemplate(`l6p1-${TS}-p2-preserve`)
    const apiSetPolicy: PolicyBody = { allowRevoke: true, autoApproval: { dedupeHistoricalApprover: true } }
    const published = await publish(tid, apiSetPolicy)
    expect(published.status, await published.clone().text()).toBe(200)

    // "reload the editor" (hydrate).
    const hydrated = await getDetail(tid)
    expect(hydrated.policy?.autoApproval).toEqual({ dedupeHistoricalApprover: true })

    // "save" (persistDraft → PATCH) — no policy in the PATCH body at all (policy is publish-only);
    // this is the exact seam `updateTemplate`'s hardcoded-null bug lived in. Its OWN response must
    // still carry the active policy forward, because the FE re-hydrates `draft.value` from it.
    const patched = await patchNoOp(tid, hydrated)
    expect(patched.policy?.allowRevoke).toBe(true)
    expect(patched.policy?.autoApproval).toEqual({ dedupeHistoricalApprover: true })

    // The editor toggles the ONE field it owns — allowRevoke — and republishes via the merge.
    const merged = buildPublishPolicyFromDetail(patched, false)
    expect(merged).toEqual({ allowRevoke: false, autoApproval: { dedupeHistoricalApprover: true } })
    const republished = await publish(tid, merged)
    expect(republished.status, await republished.clone().text()).toBe(200)

    const final = await getDetail(tid)
    // Preserved: the sibling field the editor does not own.
    expect(final.policy?.autoApproval).toEqual({ dedupeHistoricalApprover: true })
    // Positive control: allowRevoke DID change — preservation above is not merge-is-globally-inert.
    expect(final.policy?.allowRevoke).toBe(false)
  })

  it('P-3: omitting policy.allowRevoke at publish still 400s (no invented default)', async () => {
    const tid = await createTemplate(`l6p1-${TS}-p3-required`)
    const res = await req(base, `/api/approval-templates/${tid}/publish`, reqTok, {
      method: 'POST',
      body: { policy: { autoApproval: { dedupeHistoricalApprover: true } } },
    })
    expect(res.status, await res.clone().text()).toBe(400)

    // Positive control: a present boolean publishes fine on the SAME template.
    const ok = await publish(tid, { allowRevoke: true })
    expect(ok.status, await ok.clone().text()).toBe(200)
  })
})
