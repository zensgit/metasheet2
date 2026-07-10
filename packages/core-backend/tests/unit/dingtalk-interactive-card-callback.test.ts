/**
 * B-3 callback adapter (Slice B design lock §B-3) — unit matrix.
 *
 * Pins the four owner-ratified gates in pure/unit form:
 *  1. shape: only `{outTrackId, action:'approve', operatorDingTalkUserId}` is accepted as business
 *     input; every other DingTalk event field is transport metadata (never parsed into identifiers).
 *  2. UUID gate: a non-UUID `outTrackId` is rejected BEFORE any query — the ledger is never probed
 *     with attacker-shaped ids.
 *  3. ledger-only resolution: payload `instanceId`/sheet/form fields are ignored; the approval the
 *     engine sees comes exclusively from the `dingtalk_approval_card_deliveries` row.
 *  4. identity fail-closed: unmapped / inactive / ambiguous operators produce a typed refusal
 *     outcome with NO engine call. Non-approve actions are a recorded no-op (B-4 owns card copy).
 *
 * Plus the Slice-A-style static tripwire: the callback chain must go through
 * `executeApprovalActionFromCardDelivery` and never carry a raw approvals-actions route path.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  executeDingTalkApprovalCardCallback,
  parseDingTalkApprovalCardCallback,
  type DingTalkApprovalCardCallbackResult,
} from '../../src/integrations/dingtalk/interactive-card-callback'

const DELIVERY_ID = '11111111-2222-4333-8444-555555555555'
const OPERATOR = 'dd_operator_1'

function wirePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outTrackId: DELIVERY_ID,
    userId: OPERATOR,
    userIdType: 1,
    content: JSON.stringify({ cardPrivateData: { actionIds: ['approve'], params: {} } }),
    ...overrides,
  }
}

describe('parseDingTalkApprovalCardCallback (B-3 §B-3 shape gates)', () => {
  it('rejects non-object payloads', () => {
    for (const payload of [null, undefined, 'x', 42, true, ['a']]) {
      expect(parseDingTalkApprovalCardCallback(payload)).toEqual({
        ok: false,
        outcome: 'rejected',
        reason: 'payload_not_object',
      })
    }
  })

  it('rejects a missing outTrackId', () => {
    expect(parseDingTalkApprovalCardCallback(wirePayload({ outTrackId: undefined }))).toEqual({
      ok: false,
      outcome: 'rejected',
      reason: 'missing_out_track_id',
    })
    expect(parseDingTalkApprovalCardCallback(wirePayload({ outTrackId: '   ' }))).toEqual({
      ok: false,
      outcome: 'rejected',
      reason: 'missing_out_track_id',
    })
  })

  it('UUID gate: rejects every non-UUID-shaped outTrackId without guessing', () => {
    for (const bad of [
      'not-a-uuid',
      'inst_1234567890',
      `${DELIVERY_ID}x`,
      `x${DELIVERY_ID}`,
      '11111111222243338444555555555555', // un-dashed
      '11111111-2222-4333-8444-55555555555g', // non-hex
      123 as unknown as string, // non-string
    ]) {
      const parsed = parseDingTalkApprovalCardCallback(wirePayload({ outTrackId: bad }))
      expect(parsed).toEqual({ ok: false, outcome: 'rejected', reason: 'out_track_id_not_uuid' })
    }
  })

  it('normalizes an uppercase UUID to the canonical lowercase ledger id', () => {
    const parsed = parseDingTalkApprovalCardCallback(wirePayload({ outTrackId: DELIVERY_ID.toUpperCase() }))
    expect(parsed).toMatchObject({ ok: true, callback: { outTrackId: DELIVERY_ID } })
  })

  it('accepts the ratified triple directly (pre-normalized business shape)', () => {
    const parsed = parseDingTalkApprovalCardCallback({
      outTrackId: DELIVERY_ID,
      action: 'approve',
      operatorDingTalkUserId: OPERATOR,
    })
    expect(parsed).toEqual({
      ok: true,
      callback: { outTrackId: DELIVERY_ID, action: 'approve', operatorDingTalkUserId: OPERATOR },
    })
  })

  it('accepts the DingTalk wire frame (userId + content.cardPrivateData.actionIds) with string or object content', () => {
    expect(parseDingTalkApprovalCardCallback(wirePayload())).toEqual({
      ok: true,
      callback: { outTrackId: DELIVERY_ID, action: 'approve', operatorDingTalkUserId: OPERATOR },
    })
    expect(parseDingTalkApprovalCardCallback(wirePayload({
      content: { cardPrivateData: { actionIds: ['approve'] } },
    }))).toMatchObject({ ok: true })
  })

  it('non-approve actions are a typed no-op, never heuristically mapped', () => {
    const cases: unknown[] = [
      wirePayload({ content: JSON.stringify({ cardPrivateData: { actionIds: ['reject'] } }) }),
      wirePayload({ content: JSON.stringify({ cardPrivateData: { actionIds: ['agree'] } }) }),
      wirePayload({ content: JSON.stringify({ cardPrivateData: { actionIds: ['approve', 'reject'] } }) }),
      wirePayload({ content: JSON.stringify({ cardPrivateData: { actionIds: [] } }) }),
      wirePayload({ content: JSON.stringify({ cardPrivateData: {} }) }),
      wirePayload({ content: 'not-json{{' }),
      wirePayload({ content: undefined }),
      wirePayload({ content: undefined, action: 'reject' }),
      // explicit action conflicting with the wire action list → fail-closed no-op
      wirePayload({ action: 'approve', content: JSON.stringify({ cardPrivateData: { actionIds: ['reject'] } }) }),
      // review P3-1: content PRESENT but unreadable + explicit approve → fail-closed no-op
      // (an unreadable wire frame is an uncheckable opinion, not the absence of one).
      wirePayload({ action: 'approve', content: 'not-json{{' }),
      wirePayload({ action: 'approve', content: 42 }),
      wirePayload({ action: 'approve', content: JSON.stringify(['approve']) }),
    ]
    for (const payload of cases) {
      expect(parseDingTalkApprovalCardCallback(payload)).toEqual({
        ok: false,
        outcome: 'ignored_unsupported_action',
        outTrackId: DELIVERY_ID,
      })
    }
  })

  it('rejects a missing operator id (fail-closed, no anonymous actions)', () => {
    expect(parseDingTalkApprovalCardCallback(wirePayload({ userId: undefined }))).toEqual({
      ok: false,
      outcome: 'rejected',
      reason: 'missing_operator',
    })
    expect(parseDingTalkApprovalCardCallback(wirePayload({ userId: '  ' }))).toEqual({
      ok: false,
      outcome: 'rejected',
      reason: 'missing_operator',
    })
  })

  it('rejects conflicting operator fields instead of picking one', () => {
    expect(parseDingTalkApprovalCardCallback(wirePayload({
      userId: OPERATOR,
      operatorDingTalkUserId: 'dd_other',
    }))).toEqual({ ok: false, outcome: 'rejected', reason: 'operator_conflict' })
    // duplicated-but-identical fields are fine
    expect(parseDingTalkApprovalCardCallback(wirePayload({
      userId: OPERATOR,
      operatorDingTalkUserId: OPERATOR,
    }))).toMatchObject({ ok: true })
  })

  it('rejects a non-staff operator id namespace (userIdType other than 1)', () => {
    expect(parseDingTalkApprovalCardCallback(wirePayload({ userIdType: 2 }))).toEqual({
      ok: false,
      outcome: 'rejected',
      reason: 'unsupported_operator_id_type',
    })
    expect(parseDingTalkApprovalCardCallback(wirePayload({ userIdType: '1' }))).toMatchObject({ ok: true })
    expect(parseDingTalkApprovalCardCallback(wirePayload({ userIdType: undefined }))).toMatchObject({ ok: true })
  })

  it('the parsed callback carries EXACTLY the ratified triple — transport metadata never rides along', () => {
    const parsed = parseDingTalkApprovalCardCallback(wirePayload({
      corpId: 'corp_x',
      instanceId: 'inst-hostile',
      sheetId: 'sheet-hostile',
      extension: '{"secret":"v"}',
    }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(Object.keys(parsed.callback).sort()).toEqual(['action', 'operatorDingTalkUserId', 'outTrackId'])
    }
  })
})

// ── executor: ledger-only resolution + fail-closed operator + wrapper funneling ────────────────

type QueryCall = { sql: string; params: unknown[] }

function deliveryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DELIVERY_ID,
    instance_id: 'inst_real',
    node_key: 'approval_1',
    recipient_user_id: 'u_appr',
    recipient_dingtalk_user_id: OPERATOR,
    delivery_kind: 'interactive_card',
    task_id: 'carrier-1',
    // Owner hard gate (2026-07-10): operator resolution requires a corp-pinned delivery; the
    // default fixture is pinned. The unpinned (null) case has its own refusal test below.
    integration_id: 'a1a1a1a1-2222-4333-8444-555555555555',
    card_state: 'sent',
    acted_action: null,
    acted_by: null,
    acted_at: null,
    send_status: 'sent',
    send_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function makeHarness(state: {
  deliveryRows?: Record<string, unknown>[]
  linkRows?: Record<string, unknown>[]
  dispatchError?: unknown
} = {}) {
  const calls: QueryCall[] = []
  const deliveryRows = state.deliveryRows ?? [deliveryRow()]
  const linkRows = state.linkRows ?? [
    { local_user_id: 'u_appr', local_user_name: 'Approver A', local_user_active: true },
  ]
  const query = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] })
    if (sql.includes('FROM dingtalk_approval_card_deliveries')) return { rows: deliveryRows }
    if (sql.includes('FROM directory_accounts')) return { rows: linkRows }
    if (sql.includes('FROM approval_instances')) {
      return {
        rows: [{
          id: 'inst_real',
          title: 'T',
          request_no: 'R-1',
          status: 'pending',
          current_node_key: 'approval_1',
          policy_snapshot: {},
        }],
      }
    }
    if (sql.includes("card_state = 'acted'")) {
      return { rows: [deliveryRow({ card_state: 'acted', acted_action: 'approve', acted_by: 'u_appr', acted_at: new Date().toISOString() })] }
    }
    return { rows: [] }
  }
  const dispatchAction = vi.fn(async () => {
    if (state.dispatchError) throw state.dispatchError
    return {} as never
  })
  return { calls, query, dispatchAction, deps: { query, approvals: { dispatchAction } } }
}

describe('executeDingTalkApprovalCardCallback (B-3 §B-3 execution)', () => {
  beforeEach(() => {
    vi.stubEnv('APPROVAL_CARD_LINK_SECRET', 'b3-unit-secret')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('UUID gate happens BEFORE any query: a non-UUID outTrackId never probes the ledger', async () => {
    const h = makeHarness()
    const result = await executeDingTalkApprovalCardCallback(h.deps as never, wirePayload({ outTrackId: 'not-a-uuid' }))
    expect(result).toEqual({ outcome: 'rejected', reason: 'out_track_id_not_uuid' })
    expect(h.calls).toHaveLength(0)
    expect(h.dispatchAction).not.toHaveBeenCalled()
  })

  it('non-approve action is a recorded no-op with zero DB/engine traffic', async () => {
    const h = makeHarness()
    const result = await executeDingTalkApprovalCardCallback(
      h.deps as never,
      wirePayload({ content: JSON.stringify({ cardPrivateData: { actionIds: ['reject'] } }) }),
    )
    expect(result).toEqual({ outcome: 'ignored_unsupported_action', outTrackId: DELIVERY_ID })
    expect(h.calls).toHaveLength(0)
    expect(h.dispatchAction).not.toHaveBeenCalled()
  })

  it('unknown delivery id → delivery_not_found (values-free, no engine call)', async () => {
    const h = makeHarness({ deliveryRows: [] })
    const result = await executeDingTalkApprovalCardCallback(h.deps as never, wirePayload())
    expect(result).toEqual({ outcome: 'delivery_not_found', outTrackId: DELIVERY_ID })
    expect(h.dispatchAction).not.toHaveBeenCalled()
  })

  it('LEDGER-ONLY: hostile payload instanceId is ignored — the engine sees the delivery row instance', async () => {
    const h = makeHarness()
    const result = await executeDingTalkApprovalCardCallback(
      h.deps as never,
      wirePayload({ instanceId: 'inst-hostile', sheetId: 'sheet-hostile', amount: 999999 }),
    )
    expect(result.outcome).toBe('executed')
    expect(h.dispatchAction).toHaveBeenCalledTimes(1)
    expect(h.dispatchAction.mock.calls[0][0]).toBe('inst_real')
    // No payload-supplied identifier ever reaches a query parameter.
    expect(JSON.stringify(h.calls)).not.toContain('inst-hostile')
    expect(JSON.stringify(h.calls)).not.toContain('sheet-hostile')
  })

  it('executed: funnels through the wrapper with server-side channel attribution and a role-less actor', async () => {
    const h = makeHarness()
    const result = await executeDingTalkApprovalCardCallback(h.deps as never, wirePayload())
    expect(result.outcome).toBe('executed')
    if (result.outcome === 'executed') {
      expect(result.deliveryId).toBe(DELIVERY_ID)
      expect(result.summary.approval.instanceId).toBe('inst_real')
    }
    expect(h.dispatchAction).toHaveBeenCalledWith(
      'inst_real',
      expect.objectContaining({
        action: 'approve',
        channelOrigin: { channel: 'dingtalk_card', cardDeliveryId: DELIVERY_ID },
      }),
      expect.objectContaining({ userId: 'u_appr', userName: 'Approver A', roles: [] }),
    )
  })

  it('fail-closed operator: unlinked DingTalk user → typed refusal, NO engine call', async () => {
    const h = makeHarness({ linkRows: [] })
    const result = await executeDingTalkApprovalCardCallback(h.deps as never, wirePayload())
    expect(result).toEqual({ outcome: 'operator_unresolved', deliveryId: DELIVERY_ID, reason: 'unlinked' })
    expect(h.dispatchAction).not.toHaveBeenCalled()
  })

  it('fail-closed operator: inactive local user → typed refusal, NO engine call', async () => {
    const h = makeHarness({
      linkRows: [{ local_user_id: 'u_appr', local_user_name: 'Approver A', local_user_active: false }],
    })
    const result = await executeDingTalkApprovalCardCallback(h.deps as never, wirePayload())
    expect(result).toEqual({ outcome: 'operator_unresolved', deliveryId: DELIVERY_ID, reason: 'inactive' })
    expect(h.dispatchAction).not.toHaveBeenCalled()
  })

  it('fail-closed operator: one external id mapping to TWO local users → ambiguous refusal, NO engine call', async () => {
    const h = makeHarness({
      linkRows: [
        { local_user_id: 'u_appr', local_user_name: 'A', local_user_active: true },
        { local_user_id: 'u_other', local_user_name: 'B', local_user_active: true },
      ],
    })
    const result = await executeDingTalkApprovalCardCallback(h.deps as never, wirePayload())
    expect(result).toEqual({ outcome: 'operator_unresolved', deliveryId: DELIVERY_ID, reason: 'ambiguous' })
    expect(h.dispatchAction).not.toHaveBeenCalled()
  })

  it('the same local user linked through two accounts is NOT ambiguous', async () => {
    const h = makeHarness({
      linkRows: [
        { local_user_id: 'u_appr', local_user_name: 'A', local_user_active: true },
        { local_user_id: 'u_appr', local_user_name: 'A', local_user_active: true },
      ],
    })
    const result = await executeDingTalkApprovalCardCallback(h.deps as never, wirePayload())
    expect(result.outcome).toBe('executed')
  })

  it('operator resolution is scoped to the DELIVERY row integration (per-corp pinning)', async () => {
    const h = makeHarness({ deliveryRows: [deliveryRow({ integration_id: 'f0f0f0f0-1111-4222-8333-444444444444' })] })
    await executeDingTalkApprovalCardCallback(h.deps as never, wirePayload())
    const accountLookup = h.calls.find((c) => c.sql.includes('FROM directory_accounts'))
    expect(accountLookup).toBeTruthy()
    expect(accountLookup!.params).toContain('f0f0f0f0-1111-4222-8333-444444444444')
    expect(accountLookup!.params).toContain(OPERATOR)
    // Owner hard gate (2026-07-10): the predicate must be an unconditional corp pin — no
    // `IS NULL OR` global-fallback arm may reappear in this SQL.
    expect(accountLookup!.sql).not.toMatch(/IS NULL\s+OR/i)
  })

  it('OWNER GATE: an unpinned delivery (integration_id NULL) refuses outright — no global userId lookup, no engine call', async () => {
    const h = makeHarness({ deliveryRows: [deliveryRow({ integration_id: null })] })
    const result = await executeDingTalkApprovalCardCallback(h.deps as never, wirePayload())
    expect(result).toEqual({
      outcome: 'operator_unresolved',
      deliveryId: DELIVERY_ID,
      reason: 'integration_unpinned',
    })
    // fail-closed BEFORE the lookup: the directory is never queried, the engine never dispatched.
    expect(h.calls.some((c) => c.sql.includes('FROM directory_accounts'))).toBe(false)
    expect(h.dispatchAction).not.toHaveBeenCalled()
  })

  it('missing link secret fail-closes BEFORE the engine (link_secret_unavailable)', async () => {
    vi.unstubAllEnvs()
    vi.stubEnv('APPROVAL_CARD_LINK_SECRET', '')
    const h = makeHarness()
    const result = await executeDingTalkApprovalCardCallback(h.deps as never, wirePayload())
    expect(result).toEqual({ outcome: 'link_secret_unavailable', deliveryId: DELIVERY_ID })
    expect(h.dispatchAction).not.toHaveBeenCalled()
  })

  it('already-acted delivery → stale convergence (duplicate callbacks return the real terminal state)', async () => {
    const h = makeHarness({
      deliveryRows: [deliveryRow({ card_state: 'acted', acted_action: 'approve', acted_by: 'u_appr', acted_at: new Date().toISOString() })],
    })
    const result = await executeDingTalkApprovalCardCallback(h.deps as never, wirePayload())
    expect(result.outcome).toBe('stale')
    expect(h.dispatchAction).not.toHaveBeenCalled()
  })

  it('engine rejection maps to a values-free typed outcome (code + httpStatus, never the engine message)', async () => {
    const h = makeHarness({
      dispatchError: Object.assign(new Error('Approver 张三 cannot act on 采购单 X'), { code: 'APPROVAL_NOT_ASSIGNEE', statusCode: 422 }),
    })
    const result = await executeDingTalkApprovalCardCallback(h.deps as never, wirePayload())
    expect(result.outcome).toBe('engine_rejected')
    if (result.outcome === 'engine_rejected') {
      expect(result.code).toBe('APPROVAL_NOT_ASSIGNEE')
      expect(result.httpStatus).toBe(422)
    }
    // Values-free: the engine's human message (may carry titles/names) must not ride the result.
    expect(JSON.stringify(result)).not.toContain('张三')
    expect(JSON.stringify(result)).not.toContain('采购单')
  })
})

// ── Slice-A-style static tripwire (lock §6): no raw approvals-actions route on this chain ──────

describe('B-3 static tripwire: callback chain never touches the raw approvals actions route', () => {
  const SRC = join(__dirname, '../../src/integrations/dingtalk')
  const files = ['interactive-card-callback.ts', 'interactive-card-stream.ts']

  it('modules do not contain or compose the raw route path', () => {
    for (const file of files) {
      const source = readFileSync(join(SRC, file), 'utf8')
      expect(source).not.toContain('/api/approvals/')
      expect(source).not.toContain('/actions')
    }
  })

  it('positive control: the adapter funnels through executeApprovalActionFromCardDelivery', () => {
    const source = readFileSync(join(SRC, 'interactive-card-callback.ts'), 'utf8')
    expect(source).toContain('executeApprovalActionFromCardDelivery(')
  })
})

// Type-level pin: the result union stays typed for B-4 (compile-time only).
const _typePin: DingTalkApprovalCardCallbackResult = { outcome: 'delivery_not_found', outTrackId: DELIVERY_ID }
void _typePin
