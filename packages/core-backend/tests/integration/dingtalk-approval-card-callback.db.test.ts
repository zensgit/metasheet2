/**
 * B-3 callback adapter — real-DB integration (Slice B design lock §B-3 / §6 real-DB matrix).
 *
 * Locks the owner matrix for the Stream-callback execution path end-to-end against real Postgres
 * and the real approval engine:
 *   - linked recipient callback approves; `approval_records.metadata.channel='dingtalk_card'` +
 *     `cardDeliveryId` land; the card claims acted — while a HOSTILE payload `instanceId` pointing
 *     at another live instance is ignored (ledger-only resolution, Slice-A P1 invariant);
 *   - duplicate callback converges to `stale` with the real terminal summary and exactly ONE
 *     approve record (wrapper idempotency, not adapter-local state);
 *   - unmapped / inactive DingTalk operators fail closed with a typed refusal and write NOTHING;
 *   - mapped but non-assignee operator is rejected by the ENGINE (zero bypass), writes nothing,
 *     and the card stays claimable;
 *   - pending/failed send rows are never actionable;
 *   - operator resolution is pinned to the DELIVERY row's integration (DT-R2): the same external
 *     id linked in two corps is ambiguous only for unpinned rows and resolves cleanly when pinned;
 *     a corp-pinned delivery verifies through THAT corp's stored secret with env unset
 *     (same-source token threading).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { createHmac, randomUUID } from 'crypto'

import { poolManager } from '../../src/integration/db/connection-pool'
import { Logger } from '../../src/core/logger'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { executeDingTalkApprovalCardCallback } from '../../src/integrations/dingtalk/interactive-card-callback'
import {
  insertDingTalkApprovalCardDelivery,
  markDingTalkApprovalCardDeliverySendFailed,
  markDingTalkApprovalCardDeliverySent,
} from '../../src/integrations/dingtalk/approval-card-deliveries'
import { normalizeStoredSecretValue } from '../../src/security/encrypted-secrets'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const CREATOR = `u_cb_creator_${TS}`
const REQUESTER = `u_cb_req_${TS}`
const APPROVER = `u_cb_appr_${TS}`
const INACTIVE = `u_cb_inactive_${TS}`

const INTEGRATION_A = randomUUID()
const INTEGRATION_B = randomUUID()
// P1-2: the DingTalk corp each integration belongs to (directory_integrations.corp_id). The
// callback corp cross-check requires the payload's official corpId to equal the corp the DELIVERY
// row's integration belongs to.
const CORP_A = `corp_b3cb_a_${TS}`
const CORP_B = `corp_b3cb_b_${TS}`
const DD_OP = `dd_cb_op_${TS}` // → APPROVER (corp A)
const DD_REQ = `dd_cb_req_${TS}` // → REQUESTER (corp A) — mapped but non-assignee
const DD_INACTIVE = `dd_cb_inactive_${TS}` // → INACTIVE user (corp A)
const DD_GHOST = `dd_cb_ghost_${TS}` // linked nowhere
const DD_DUP = `dd_cb_dup_${TS}` // corp A → APPROVER, corp B → REQUESTER (ambiguity probe)
const DD_OP_B = `dd_cb_op_b_${TS}` // → APPROVER (corp B, stored-secret chain)
const DD_CORP_DRIFT = `dd_cb_corp_drift_${TS}`

const SECRET = `cb-env-secret-${TS}`
const STORED_SECRET_A = `cb-stored-secret-a-${TS}`
const STORED_SECRET_B = `cb-stored-secret-b-${TS}`

const q = (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)

let approvals: ApprovalProductService
let templateId = ''
const deps = { query: q, approvals: null as unknown as ApprovalProductService }

// P1-2: `corpId` is the official clicker corp the callback carries. It defaults to CORP_A (the
// corp the default INTEGRATION_A deliveries belong to) so the happy path passes the corp
// cross-check; corp-B deliveries and the cross-corp goldens pass it explicitly. `corpId: null`
// omits the field entirely (the ABSENT-corpId fail-closed case).
function payloadFor(
  outTrackId: string,
  operator: string,
  extra: Record<string, unknown> = {},
  action = 'approve',
  corpId: string | null = CORP_A,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    outTrackId,
    userId: operator,
    userIdType: 1,
    content: JSON.stringify({ cardPrivateData: { actionIds: [action], params: {} } }),
  }
  if (corpId !== null) base.corpId = corpId
  return { ...base, ...extra }
}

async function newInstance(): Promise<string> {
  const dto = await approvals.createApproval(
    { templateId, formData: { summary: 'b3 callback test' } },
    { userId: REQUESTER, userName: REQUESTER },
  )
  return (dto as { id: string }).id
}

/**
 * The live node-entry epoch of the active seat for (instance, node, recipient). A DELIVERABLE card
 * MUST be stamped with this (strict P1-1 binding: a NULL-epoch card is never actionable) — the real
 * send path reads `task.entryEpoch` from the task_created event; the fixtures read it from the seat
 * the engine minted so the card binds to its real round. Undeliverable negatives (pending/failed)
 * keep NULL — they are unactionable by send_status alone, and stamping them would mask nothing.
 */
async function liveSeatEpoch(instanceId: string, nodeKey: string, recipientUserId: string): Promise<number> {
  const res = await q(
    `SELECT entry_epoch FROM approval_assignments
      WHERE instance_id = $1 AND node_key = $2 AND assignee_id = $3 AND is_active = TRUE AND entry_epoch IS NOT NULL
      ORDER BY entry_epoch DESC LIMIT 1`,
    [instanceId, nodeKey, recipientUserId],
  )
  const epoch = (res.rows[0] as { entry_epoch: number } | undefined)?.entry_epoch
  if (typeof epoch !== 'number') throw new Error(`no live non-null-epoch seat for ${instanceId}/${nodeKey}/${recipientUserId}`)
  return epoch
}

async function newSentDelivery(instanceId: string, integrationId: string | null = INTEGRATION_A): Promise<string> {
  const row = await insertDingTalkApprovalCardDelivery(q, {
    instanceId,
    nodeKey: 'approval_1',
    recipientUserId: APPROVER,
    recipientDingTalkUserId: DD_OP,
    deliveryKind: 'interactive_card',
    integrationId,
    entryEpoch: await liveSeatEpoch(instanceId, 'approval_1', APPROVER),
  })
  await markDingTalkApprovalCardDeliverySent(q, row.id, `carrier_${row.id.slice(0, 8)}`)
  return row.id
}

async function approveRecordCount(instanceId: string): Promise<number> {
  const result = await q(`SELECT COUNT(*)::int AS n FROM approval_records WHERE instance_id = $1 AND action = 'approve'`, [instanceId])
  return Number((result.rows[0] as { n: number }).n)
}

async function cardState(deliveryId: string): Promise<string> {
  const result = await q('SELECT card_state FROM dingtalk_approval_card_deliveries WHERE id = $1', [deliveryId])
  return (result.rows[0] as { card_state: string }).card_state
}

async function linkAccount(
  accountId: string,
  integrationId: string,
  externalUserId: string,
  localUserId: string,
  corpId = integrationId === INTEGRATION_A ? CORP_A : CORP_B,
): Promise<void> {
  // Production operator resolution now requires account corp to agree with its parent integration.
  // A dedicated negative below overrides this value to prove fail-closed behavior on historical drift.
  await q(
    `INSERT INTO directory_accounts (id, integration_id, provider, corp_id, external_user_id, external_key, name, is_active)
     VALUES ($1, $2, 'dingtalk', $3, $4, $5, 'B3 Callback Fixture', TRUE)
     ON CONFLICT (id) DO UPDATE SET corp_id = EXCLUDED.corp_id, is_active = TRUE`,
    [accountId, integrationId, corpId, externalUserId, `${externalUserId}#${accountId.slice(0, 8)}`],
  )
  await q(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
     VALUES ($1, $2, 'linked')`,
    [accountId, localUserId],
  )
}

const ACCOUNTS = {
  op: randomUUID(),
  req: randomUUID(),
  inactive: randomUUID(),
  dupA: randomUUID(),
  dupB: randomUUID(),
  opB: randomUUID(),
  corpDrift: randomUUID(),
}

describeIfDatabase('B-3 DingTalk card callback adapter (real DB)', () => {
  let savedSecret: string | undefined

  beforeAll(async () => {
    savedSecret = process.env.APPROVAL_CARD_LINK_SECRET
    process.env.APPROVAL_CARD_LINK_SECRET = SECRET

    await q(`INSERT INTO permissions (code, name, description) VALUES ('approvals:read','r','t'),('approvals:write','w','t'),('approvals:act','a','t') ON CONFLICT (code) DO NOTHING`)
    for (const uid of [CREATOR, REQUESTER, APPROVER, INACTIVE]) {
      await q(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
               VALUES ($1,$2,$1,'x','user','[]'::jsonb,TRUE,FALSE) ON CONFLICT (id) DO UPDATE SET is_active = TRUE`, [uid, `${uid}@b3cb.test`])
    }
    await q('UPDATE users SET is_active = FALSE WHERE id = $1', [INACTIVE])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:write') ON CONFLICT DO NOTHING`, [REQUESTER])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:act') ON CONFLICT DO NOTHING`, [APPROVER])

    // Two corps, BOTH with stored (encrypted-at-rest) link secrets for the env-unset test.
    // Anti-shadowing (mirrors the DT-R2 wrapper test): corp A is deliberately the FRESHEST
    // integration, so the legacy LIMIT-1 global pick (active-first, updated_at DESC) would land on
    // corp A's secret — if the adapter ever signed with that pick instead of the DELIVERY row's
    // pinned corp B, the token would fail wrapper verification and the per-corp test turns red.
    // now()-based rows cannot permanently shadow real integrations if a crash skips cleanup.
    await q(
      `INSERT INTO directory_integrations (id, name, provider, status, corp_id, config, updated_at)
       VALUES ($1, $2, 'dingtalk', 'active', $3, $4::jsonb, now())`,
      [INTEGRATION_A, `b3cb-corp-a-${TS}`, CORP_A, JSON.stringify({ approvalCardLinkSecret: normalizeStoredSecretValue(STORED_SECRET_A) })],
    )
    await q(
      `INSERT INTO directory_integrations (id, name, provider, status, corp_id, config, updated_at)
       VALUES ($1, $2, 'dingtalk', 'active', $3, $4::jsonb, now() - interval '1 minute')`,
      [INTEGRATION_B, `b3cb-corp-b-${TS}`, CORP_B, JSON.stringify({ approvalCardLinkSecret: normalizeStoredSecretValue(STORED_SECRET_B) })],
    )

    await linkAccount(ACCOUNTS.op, INTEGRATION_A, DD_OP, APPROVER)
    await linkAccount(ACCOUNTS.req, INTEGRATION_A, DD_REQ, REQUESTER)
    await linkAccount(ACCOUNTS.inactive, INTEGRATION_A, DD_INACTIVE, INACTIVE)
    await linkAccount(ACCOUNTS.dupA, INTEGRATION_A, DD_DUP, APPROVER)
    await linkAccount(ACCOUNTS.dupB, INTEGRATION_B, DD_DUP, REQUESTER)
    await linkAccount(ACCOUNTS.opB, INTEGRATION_B, DD_OP_B, APPROVER)
    await linkAccount(ACCOUNTS.corpDrift, INTEGRATION_A, DD_CORP_DRIFT, APPROVER, CORP_B)

    approvals = new ApprovalProductService()
    deps.approvals = approvals
    const template = await approvals.createTemplate({
      key: `b3cb-${TS}`,
      name: 'B3 Callback Template',
      formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: 'Start', config: {} },
          { key: 'approval_1', type: 'approval', name: 'First', config: { mode: 'any', assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }] } },
          { key: 'end', type: 'end', name: 'End', config: {} },
        ],
        edges: [
          { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
          { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
        ],
      },
    } as never)
    templateId = (template as { id: string }).id
    await approvals.publishTemplate(templateId, { policy: { allowRevoke: true } } as never)
  })

  afterAll(async () => {
    const instances = await q('SELECT id FROM approval_instances WHERE template_id = $1', [templateId]).catch(() => ({ rows: [] as unknown[] }))
    for (const row of instances.rows as Array<{ id: string }>) {
      await q('DELETE FROM dingtalk_approval_card_deliveries WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_assignments WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_records WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_instances WHERE id = $1', [row.id]).catch(() => {})
    }
    await q('DELETE FROM approval_templates WHERE id = $1', [templateId]).catch(() => {})
    await q('DELETE FROM directory_account_links WHERE directory_account_id = ANY($1::uuid[])', [Object.values(ACCOUNTS)]).catch(() => {})
    await q('DELETE FROM directory_accounts WHERE id = ANY($1::uuid[])', [Object.values(ACCOUNTS)]).catch(() => {})
    await q('DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [[INTEGRATION_A, INTEGRATION_B]]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[CREATOR, REQUESTER, APPROVER, INACTIVE]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[CREATOR, REQUESTER, APPROVER, INACTIVE]]).catch(() => {})
    if (savedSecret === undefined) delete process.env.APPROVAL_CARD_LINK_SECRET
    else process.env.APPROVAL_CARD_LINK_SECRET = savedSecret
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('linked recipient approves via callback: engine record + channel attribution + acted claim; HOSTILE payload instanceId is ignored', async () => {
    const instanceId = await newInstance()
    const decoyInstanceId = await newInstance()
    const deliveryId = await newSentDelivery(instanceId)

    const result = await executeDingTalkApprovalCardCallback(
      deps,
      payloadFor(deliveryId, DD_OP, {
        // Slice-A P1 hostile probe: payload ids must never steer resolution.
        instanceId: decoyInstanceId,
        processInstanceId: decoyInstanceId,
        sheetId: 'sheet-hostile',
      }),
    )
    expect(result.outcome).toBe('executed')
    if (result.outcome === 'executed') {
      expect(result.deliveryId).toBe(deliveryId)
      expect(result.summary.approval.instanceId).toBe(instanceId)
      expect(result.summary.cardState).toBe('acted')
      expect(result.summary.actedAction).toBe('approve')
      expect(result.summary.approval.status).toBe('approved')
    }

    // Engine record carries the server-side channel attribution (never from the payload).
    const record = await q(
      `SELECT metadata FROM approval_records WHERE instance_id = $1 AND action = 'approve' ORDER BY created_at DESC LIMIT 1`,
      [instanceId],
    )
    const metadata = (record.rows[0] as { metadata: Record<string, unknown> }).metadata
    expect(metadata.channel).toBe('dingtalk_card')
    expect(metadata.cardDeliveryId).toBe(deliveryId)
    expect(await cardState(deliveryId)).toBe('acted')

    // The decoy instance the hostile payload pointed at is untouched.
    const decoy = await q('SELECT status FROM approval_instances WHERE id = $1', [decoyInstanceId])
    expect((decoy.rows[0] as { status: string }).status).toBe('pending')
    expect(await approveRecordCount(decoyInstanceId)).toBe(0)
  })

  test('duplicate callback converges: stale with the real terminal summary, exactly ONE approve record', async () => {
    const instanceId = await newInstance()
    const deliveryId = await newSentDelivery(instanceId)

    const first = await executeDingTalkApprovalCardCallback(deps, payloadFor(deliveryId, DD_OP))
    expect(first.outcome).toBe('executed')

    const second = await executeDingTalkApprovalCardCallback(deps, payloadFor(deliveryId, DD_OP))
    expect(second.outcome).toBe('stale')
    if (second.outcome === 'stale') {
      expect(second.summary.cardState).toBe('acted')
      expect(second.summary.approval.status).toBe('approved')
    }
    expect(await approveRecordCount(instanceId)).toBe(1)
  })

  test('non-approve action on a live card is a recorded no-op: nothing executes, card stays actionable', async () => {
    const instanceId = await newInstance()
    const deliveryId = await newSentDelivery(instanceId)

    const result = await executeDingTalkApprovalCardCallback(deps, payloadFor(deliveryId, DD_OP, {}, 'reject'))
    expect(result).toEqual({ outcome: 'ignored_unsupported_action', outTrackId: deliveryId })
    expect(await approveRecordCount(instanceId)).toBe(0)
    expect(await cardState(deliveryId)).toBe('sent')
  })

  test('unmapped DingTalk operator fails closed: typed refusal, NO approval record, card stays claimable', async () => {
    const instanceId = await newInstance()
    const deliveryId = await newSentDelivery(instanceId)

    const result = await executeDingTalkApprovalCardCallback(deps, payloadFor(deliveryId, DD_GHOST))
    expect(result).toEqual({ outcome: 'operator_unresolved', deliveryId, reason: 'unlinked' })
    expect(await approveRecordCount(instanceId)).toBe(0)
    expect(await cardState(deliveryId)).toBe('sent')
  })

  test('linked-but-INACTIVE local user fails closed with NO engine write', async () => {
    const instanceId = await newInstance()
    const deliveryId = await newSentDelivery(instanceId)

    const result = await executeDingTalkApprovalCardCallback(deps, payloadFor(deliveryId, DD_INACTIVE))
    expect(result).toEqual({ outcome: 'operator_unresolved', deliveryId, reason: 'inactive' })
    expect(await approveRecordCount(instanceId)).toBe(0)
    expect(await cardState(deliveryId)).toBe('sent')
  })

  test('mapped but non-assignee operator is rejected by the ENGINE (zero bypass), writes nothing, card stays claimable', async () => {
    const instanceId = await newInstance()
    const deliveryId = await newSentDelivery(instanceId)

    const result = await executeDingTalkApprovalCardCallback(deps, payloadFor(deliveryId, DD_REQ))
    expect(result.outcome).toBe('engine_rejected')
    if (result.outcome === 'engine_rejected') {
      expect(result.httpStatus).toBeGreaterThanOrEqual(400)
      expect(result.summary.cardState).toBe('sent')
    }
    expect(await approveRecordCount(instanceId)).toBe(0)
    expect(await cardState(deliveryId)).toBe('sent')
  })

  test('pending and failed send rows are never actionable through the callback', async () => {
    const instanceId = await newInstance()
    const pendingRow = await insertDingTalkApprovalCardDelivery(q, {
      instanceId, nodeKey: 'approval_1', recipientUserId: APPROVER, recipientDingTalkUserId: DD_OP, deliveryKind: 'interactive_card', integrationId: INTEGRATION_A,
    })
    const pendingOutcome = await executeDingTalkApprovalCardCallback(deps, payloadFor(pendingRow.id, DD_OP))
    expect(pendingOutcome.outcome).toBe('stale')

    const failedRow = await insertDingTalkApprovalCardDelivery(q, {
      instanceId, nodeKey: 'approval_1', recipientUserId: APPROVER, recipientDingTalkUserId: DD_OP, deliveryKind: 'interactive_card', integrationId: INTEGRATION_A,
    })
    await markDingTalkApprovalCardDeliverySendFailed(q, failedRow.id, 'redacted send failure')
    const failedOutcome = await executeDingTalkApprovalCardCallback(deps, payloadFor(failedRow.id, DD_OP))
    expect(failedOutcome.outcome).toBe('stale')

    expect(await approveRecordCount(instanceId)).toBe(0)
  })

  test('UUID-shaped ghost outTrackId → delivery_not_found (no oracle beyond the ledger)', async () => {
    const ghost = randomUUID()
    const result = await executeDingTalkApprovalCardCallback(deps, payloadFor(ghost, DD_OP))
    expect(result).toEqual({ outcome: 'delivery_not_found', outTrackId: ghost })
  })

  test('account/integration corp drift fails closed before a linked operator can act', async () => {
    const instanceId = await newInstance()
    const deliveryId = await newSentDelivery(instanceId, INTEGRATION_A)

    const result = await executeDingTalkApprovalCardCallback(
      deps,
      payloadFor(deliveryId, DD_CORP_DRIFT, {}, 'approve', CORP_A),
    )

    expect(result).toEqual({ outcome: 'operator_unresolved', deliveryId, reason: 'unlinked' })
    expect(await approveRecordCount(instanceId)).toBe(0)
    expect(await cardState(deliveryId)).toBe('sent')
  })

  test('DT-R2 identity pinning: unpinned rows refuse OUTRIGHT (owner gate); the pinned corp resolves cleanly', async () => {
    const instanceId = await newInstance()

    // Owner hard gate (2026-07-10): an unpinned delivery (integration_id NULL) refuses BEFORE any
    // lookup — previously this degraded to a GLOBAL userId lookup that refused only on ambiguity,
    // so a globally-unique-but-wrong-corp id would have resolved (cross-corp collision face).
    const unpinned = await insertDingTalkApprovalCardDelivery(q, {
      instanceId, nodeKey: 'approval_1', recipientUserId: APPROVER, recipientDingTalkUserId: DD_DUP, deliveryKind: 'interactive_card', integrationId: null,
      entryEpoch: await liveSeatEpoch(instanceId, 'approval_1', APPROVER),
    })
    await markDingTalkApprovalCardDeliverySent(q, unpinned.id, 'carrier_dup_unpinned')
    const refused = await executeDingTalkApprovalCardCallback(deps, payloadFor(unpinned.id, DD_DUP))
    expect(refused).toEqual({ outcome: 'operator_unresolved', deliveryId: unpinned.id, reason: 'integration_unpinned' })
    expect(await approveRecordCount(instanceId)).toBe(0)

    // Corp-A-pinned delivery: the SAME external id resolves to corp A's link (APPROVER) → executes.
    const pinned = await insertDingTalkApprovalCardDelivery(q, {
      instanceId, nodeKey: 'approval_1', recipientUserId: APPROVER, recipientDingTalkUserId: DD_DUP, deliveryKind: 'interactive_card', integrationId: INTEGRATION_A,
      entryEpoch: await liveSeatEpoch(instanceId, 'approval_1', APPROVER),
    })
    await markDingTalkApprovalCardDeliverySent(q, pinned.id, 'carrier_dup_pinned')
    const executed = await executeDingTalkApprovalCardCallback(deps, payloadFor(pinned.id, DD_DUP))
    expect(executed.outcome).toBe('executed')
    expect(await approveRecordCount(instanceId)).toBe(1)
  })

  // ══ UAT §0-a INSTRUMENT (owner-scoped, 2026-07-12) ═══════════════════════════════════════════════
  //
  // §0-a asks ONE question of a real DingTalk frame: does it carry `eventCorpId` (SDK-typed header),
  // `corpId` (untyped body), or NEITHER? If neither, every click fail-closes and the card is
  // DEAD-ON-ARRIVAL — close the flag. The old gate could not answer it: absent / conflicting /
  // unresolvable / genuinely-mismatched all collapsed into one `corp_mismatch`, with no logging at all.
  //
  // These pin the full matrix, plus the two hard constraints: presence is reported on SUCCESS too
  // (otherwise a working click still cannot prove WHICH source carried the anchor), and the log is
  // VALUES-FREE (a corp id must never reach a log line).
  describe('UAT §0-a corp-anchor observability', () => {
    // Spy on the module's Logger; the callback logs through Logger.prototype.info.
    const infoSpy = vi.spyOn(Logger.prototype, 'info')

    beforeEach(() => { infoSpy.mockClear() })
    afterAll(() => { infoSpy.mockRestore() })

    /** The values-free presence record the corp gate emits for a given delivery. */
    const anchorLogFor = (deliveryId: string): Record<string, unknown> | null => {
      for (const call of infoSpy.mock.calls) {
        const [msg, meta] = call as [string, Record<string, unknown> | undefined]
        if (msg === 'DingTalk interactive-card callback corp anchor' && meta?.deliveryId === deliveryId) return meta
      }
      return null
    }

    /** Every string that ever reached ANY logger call this test — used to prove no corp value leaked. */
    const allLoggedText = (): string =>
      infoSpy.mock.calls.map((c) => JSON.stringify(c)).join(' | ')

    async function pinnedCorpBCard(instanceId: string): Promise<string> {
      const row = await insertDingTalkApprovalCardDelivery(q, {
        instanceId, nodeKey: 'approval_1', recipientUserId: APPROVER, recipientDingTalkUserId: DD_OP_B,
        deliveryKind: 'interactive_card', integrationId: INTEGRATION_B,
        entryEpoch: await liveSeatEpoch(instanceId, 'approval_1', APPROVER),
      })
      await markDingTalkApprovalCardDeliverySent(q, row.id, `carrier_0a_${row.id.slice(0, 8)}`)
      return row.id
    }

    test('HEADER-ONLY (eventCorpId, no body corpId) → executes; presence logged as header=true body=false', async () => {
      const instanceId = await newInstance()
      const deliveryId = await pinnedCorpBCard(instanceId)
      // The Stream adapter stamps the header value as `eventCorpId`; no top-level `corpId` at all.
      const res = await executeDingTalkApprovalCardCallback(
        deps, payloadFor(deliveryId, DD_OP_B, { eventCorpId: CORP_B }, 'approve', null),
      )
      expect(res.outcome).toBe('executed')
      expect(anchorLogFor(deliveryId)).toMatchObject({ headerEventCorpIdPresent: true, bodyCorpIdPresent: false })
    })

    test('BODY-ONLY (no header) → executes; presence logged as header=false body=true — THIS is the §0-a answer that says the header does not exist on real frames', async () => {
      const instanceId = await newInstance()
      const deliveryId = await pinnedCorpBCard(instanceId)
      const res = await executeDingTalkApprovalCardCallback(deps, payloadFor(deliveryId, DD_OP_B, {}, 'approve', CORP_B))
      expect(res.outcome).toBe('executed')
      expect(anchorLogFor(deliveryId)).toMatchObject({ headerEventCorpIdPresent: false, bodyCorpIdPresent: true })
    })

    test('BOTH ABSENT → corp_anchor_absent (the DEAD-ON-ARRIVAL signal), zero approvals, presence both false', async () => {
      const instanceId = await newInstance()
      const deliveryId = await pinnedCorpBCard(instanceId)
      const res = await executeDingTalkApprovalCardCallback(deps, payloadFor(deliveryId, DD_OP_B, {}, 'approve', null))
      expect(res).toEqual({ outcome: 'operator_unresolved', deliveryId, reason: 'corp_anchor_absent' })
      expect(await approveRecordCount(instanceId)).toBe(0)
      expect(anchorLogFor(deliveryId)).toMatchObject({ headerEventCorpIdPresent: false, bodyCorpIdPresent: false })
    })

    test('CONFLICT (header ≠ body) → corp_anchor_conflict, NOT absent — a disagreement must never be misreported as "no anchor exists"', async () => {
      // THE trap. The old reader returned '' on a disagreement, so this looked exactly like BOTH-ABSENT
      // — which would tell an operator "DingTalk sends no corp field, close the flag" when in fact two
      // anchors arrived and disagreed. Opposite diagnosis, opposite action.
      const instanceId = await newInstance()
      const deliveryId = await pinnedCorpBCard(instanceId)
      const res = await executeDingTalkApprovalCardCallback(
        deps, payloadFor(deliveryId, DD_OP_B, { eventCorpId: CORP_A }, 'approve', CORP_B),
      )
      expect(res).toEqual({ outcome: 'operator_unresolved', deliveryId, reason: 'corp_anchor_conflict' })
      expect(await approveRecordCount(instanceId)).toBe(0)
      // Both WERE present — that is the whole point, and it is what distinguishes this from absent.
      expect(anchorLogFor(deliveryId)).toMatchObject({ headerEventCorpIdPresent: true, bodyCorpIdPresent: true })
    })

    test('DELIVERY CORP UNRESOLVABLE (pinned integration exists but its corp cannot be resolved) → delivery_corp_unresolved, zero approvals', async () => {
      // Two earlier drafts of this test were WRONG, and how they were wrong is worth keeping:
      //   1. DELETE the integration row → it CASCADED and destroyed the shared corp-B accounts/links,
      //      silently breaking the two tests that ran after it. Construct state; never demolish a fixture.
      //   2. Pin the delivery at a ghost uuid → rejected by the FK
      //      (dingtalk_approval_card_deliveries_integration_id_fkey). A delivery CANNOT point at a
      //      missing integration.
      // And the FK is ON DELETE SET NULL, so deleting an integration UNPINS the delivery — which returns
      // `integration_unpinned` at an EARLIER gate, not this one. So the docstring on
      // resolveIntegrationCorpId ("returns '' when the integration row is missing, e.g. deleted") names a
      // cause the schema makes unreachable.
      //
      // The genuinely reachable cause is an integration that EXISTS but is not a DingTalk integration.
      // Phase B rejects blank corp ids at the schema boundary, while resolveIntegrationCorpId also
      // requires provider='dingtalk'. A delivery pinned to a differently typed integration is a real
      // misconfiguration, and it must read as OUR failure — never as "the frame carried no corp anchor",
      // which would wrongly tell an operator to close the flag.
      const instanceId = await newInstance()
      const brokenIntegrationId = randomUUID()
      await q(
        `INSERT INTO directory_integrations (id, name, provider, status, corp_id, config, updated_at)
         VALUES ($1, $2, 'wecom', 'active', $3, '{}'::jsonb, now())`,
        [brokenIntegrationId, `b3cb-corp-broken-${TS}`, CORP_B],
      )
      try {
        const row = await insertDingTalkApprovalCardDelivery(q, {
          instanceId, nodeKey: 'approval_1', recipientUserId: APPROVER, recipientDingTalkUserId: DD_OP_B,
          deliveryKind: 'interactive_card', integrationId: brokenIntegrationId,
          entryEpoch: await liveSeatEpoch(instanceId, 'approval_1', APPROVER),
        })
        await markDingTalkApprovalCardDeliverySent(q, row.id, 'carrier_0a_brokencorp')

        const res = await executeDingTalkApprovalCardCallback(deps, payloadFor(row.id, DD_OP_B, {}, 'approve', CORP_B))
        expect(res).toEqual({ outcome: 'operator_unresolved', deliveryId: row.id, reason: 'delivery_corp_unresolved' })
        expect(await approveRecordCount(instanceId)).toBe(0)
        // The frame's anchor WAS present. The failure is on OUR side, and the log must say so.
        expect(anchorLogFor(row.id)).toMatchObject({ headerEventCorpIdPresent: false, bodyCorpIdPresent: true })
      } finally {
        await q('DELETE FROM dingtalk_approval_card_deliveries WHERE integration_id = $1::uuid', [brokenIntegrationId]).catch(() => {})
        await q('DELETE FROM directory_integrations WHERE id = $1::uuid', [brokenIntegrationId]).catch(() => {})
      }
    })

    test('REAL MISMATCH (corp-A click on a corp-B delivery) → corp_mismatch — still refused, still distinct from the absent/conflict cases', async () => {
      const instanceId = await newInstance()
      const deliveryId = await pinnedCorpBCard(instanceId)
      const res = await executeDingTalkApprovalCardCallback(deps, payloadFor(deliveryId, DD_OP_B, {}, 'approve', CORP_A))
      expect(res).toEqual({ outcome: 'operator_unresolved', deliveryId, reason: 'corp_mismatch' })
      expect(await approveRecordCount(instanceId)).toBe(0)
    })

    test('VALUES-FREE: no corp id, user id, form value or raw payload EVER reaches a log line', async () => {
      // The §0-a instrument exists to answer a presence question — it must not become an exfiltration
      // channel for the very identifiers the doctrine forbids logging. Drive the successful path (the
      // one that carries a real corp value end-to-end) and prove the corp value never appears anywhere.
      const instanceId = await newInstance()
      const deliveryId = await pinnedCorpBCard(instanceId)
      const res = await executeDingTalkApprovalCardCallback(deps, payloadFor(deliveryId, DD_OP_B, { eventCorpId: CORP_B }, 'approve', CORP_B))
      expect(res.outcome).toBe('executed')

      const logged = allLoggedText()
      expect(logged).not.toContain(CORP_A)
      expect(logged).not.toContain(CORP_B)          // the corp VALUE must never be logged
      expect(logged).not.toContain(DD_OP_B)         // nor the DingTalk user id
      expect(logged).not.toContain('cardPrivateData') // nor any raw payload fragment

      // ...while the presence booleans ARE there. Absent this, the test would pass by logging nothing.
      expect(anchorLogFor(deliveryId)).toMatchObject({ headerEventCorpIdPresent: true, bodyCorpIdPresent: true })
    })
  })

  test('P1-2 corp cross-check: a corp-A click (userId collision) on a corp-B delivery is refused (corp_mismatch); missing corpId is refused; the matching corp executes', async () => {
    const instanceId = await newInstance()
    // Delivery pinned to corp B; the assignee APPROVER is linked under corp B as DD_OP_B.
    // The delivery MUST carry the live seat's entry_epoch (P1-1 strict binding): without it the card
    // is un-actionable for the epoch reason, and the final `executed` leg below would degrade to
    // `stale` — leaving an all-fail-closed suite that stays green even if the corp gate refused
    // EVERYTHING. The positive control is what proves the gate refuses the attacker specifically,
    // rather than refusing everyone.
    const row = await insertDingTalkApprovalCardDelivery(q, {
      instanceId, nodeKey: 'approval_1', recipientUserId: APPROVER, recipientDingTalkUserId: DD_OP_B, deliveryKind: 'interactive_card', integrationId: INTEGRATION_B,
      entryEpoch: await liveSeatEpoch(instanceId, 'approval_1', APPROVER),
    })
    await markDingTalkApprovalCardDeliverySent(q, row.id, 'carrier_corp_xcheck')

    // The cross-corp collision face: the click carries the corp-B assignee's userId (DD_OP_B) but
    // the OFFICIAL corpId is corp A — a corp-A clicker whose id collides with the corp-B assignee.
    // On main (no corp check) resolveOperatorLocalUser(DD_OP_B, INTEGRATION_B) → APPROVER and the
    // corp-A clicker APPROVES the corp-B task. The gate refuses it before any operator lookup.
    const mismatch = await executeDingTalkApprovalCardCallback(deps, payloadFor(row.id, DD_OP_B, {}, 'approve', CORP_A))
    expect(mismatch).toEqual({ outcome: 'operator_unresolved', deliveryId: row.id, reason: 'corp_mismatch' })
    expect(await approveRecordCount(instanceId)).toBe(0)
    expect(await cardState(row.id)).toBe('sent')

    // Fail-closed on an ABSENT payload corpId (the field is omitted entirely), never skipped.
    // UAT §0-a: this is now its OWN reason. Collapsed into `corp_mismatch` it was indistinguishable
    // from a real cross-corp click — and those demand opposite responses (close the flag vs. a config fix).
    const absent = await executeDingTalkApprovalCardCallback(deps, payloadFor(row.id, DD_OP_B, {}, 'approve', null))
    expect(absent).toEqual({ outcome: 'operator_unresolved', deliveryId: row.id, reason: 'corp_anchor_absent' })
    expect(await approveRecordCount(instanceId)).toBe(0)
    expect(await cardState(row.id)).toBe('sent')

    // Matching corpId (the delivery's own corp B) passes the gate and executes end-to-end.
    const match = await executeDingTalkApprovalCardCallback(deps, payloadFor(row.id, DD_OP_B, {}, 'approve', CORP_B))
    expect(match.outcome).toBe('executed')
    expect(await approveRecordCount(instanceId)).toBe(1)
    expect(await cardState(row.id)).toBe('acted')
  })

  test('per-corp stored secret (env unset): a corp-B-pinned delivery signs and verifies through corp B\'s stored secret end-to-end', async () => {
    const instanceId = await newInstance()
    const row = await insertDingTalkApprovalCardDelivery(q, {
      instanceId, nodeKey: 'approval_1', recipientUserId: APPROVER, recipientDingTalkUserId: DD_OP_B, deliveryKind: 'interactive_card', integrationId: INTEGRATION_B,
      entryEpoch: await liveSeatEpoch(instanceId, 'approval_1', APPROVER),
    })
    await markDingTalkApprovalCardDeliverySent(q, row.id, 'carrier_corp_b')

    const prev = process.env.APPROVAL_CARD_LINK_SECRET
    delete process.env.APPROVAL_CARD_LINK_SECRET
    try {
      // Cross-corp identity fail-closed: corp A's operator id is NOT linked under corp B. (The
      // callback presents corp B's own corpId so the P1-2 corp gate passes and the refusal is
      // proven to come from the identity lookup, not the corp cross-check.)
      const crossCorp = await executeDingTalkApprovalCardCallback(deps, payloadFor(row.id, DD_OP, {}, 'approve', CORP_B))
      expect(crossCorp).toEqual({ outcome: 'operator_unresolved', deliveryId: row.id, reason: 'unlinked' })

      // Corp B's own linked operator executes; token threading used corp B's stored secret.
      const result = await executeDingTalkApprovalCardCallback(deps, payloadFor(row.id, DD_OP_B, {}, 'approve', CORP_B))
      expect(result.outcome).toBe('executed')
      const record = await q(
        `SELECT metadata FROM approval_records WHERE instance_id = $1 AND action = 'approve' ORDER BY created_at DESC LIMIT 1`,
        [instanceId],
      )
      expect(((record.rows[0] as { metadata: Record<string, unknown> }).metadata).cardDeliveryId).toBe(row.id)

      // The signing source MUST have been corp B's own stored secret: corp A (the freshest row,
      // i.e. what a legacy LIMIT-1 pick would return) holds a DIFFERENT secret, and a token signed
      // with it can never verify against the corp-B-pinned delivery. Sanity-pin that here.
      expect(STORED_SECRET_A).not.toBe(STORED_SECRET_B)
      const tokenA = createHmac('sha256', STORED_SECRET_A).update(row.id).digest('hex').slice(0, 32)
      const tokenB = createHmac('sha256', STORED_SECRET_B).update(row.id).digest('hex').slice(0, 32)
      expect(tokenA).not.toBe(tokenB)
    } finally {
      if (prev === undefined) delete process.env.APPROVAL_CARD_LINK_SECRET
      else process.env.APPROVAL_CARD_LINK_SECRET = prev
    }
  })
})
