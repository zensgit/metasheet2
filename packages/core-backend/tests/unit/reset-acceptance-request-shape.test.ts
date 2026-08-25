import { describe, expect, it } from 'vitest'

import { parseRecoveryAnchorRequest } from '../../src/multitable/exact-anchor-recovery-route'
import { buildResetPreviewBody, buildResetExecuteBody } from '../../scripts/reset-acceptance.mjs'

/**
 * Pin `packages/core-backend/scripts/reset-acceptance.mjs`'s exact request-body shapes against the
 * ROUTE'S OWN `parseRecoveryAnchorRequest` — imported directly, never re-typed — so the harness can
 * never silently drift back to the pre-exact-anchor `asOf` contract without this test going red.
 *
 * Context: the route refuses ANY nonblank `asOf` (even alongside a valid id) with
 * `exact-anchor-required`, before the D2 sheet-admin gate and before any DB access
 * (`exact-anchor-recovery-route.ts`'s `parseRecoveryAnchorRequest`). EXECUTE is a SEPARATE, TOKEN-ONLY
 * surface (`univer-meta.ts`'s `handleExactAnchorExecute`, ~L10705) that never runs its body through this
 * parser at all — it rejects `historyBatchId` / `anchorOperationId` / `mode` outright and refuses any
 * nonblank `asOf` with its own inline check. Preview and execute bodies are therefore asserted with two
 * DIFFERENT criteria below, not one shared "parses ok" expectation.
 */
describe('reset-acceptance.mjs request-body shape (pinned against parseRecoveryAnchorRequest)', () => {
  it('buildResetPreviewBody(historyBatchId) parses as a valid history-batch anchor request', () => {
    const body = buildResetPreviewBody('batch-abc-123')
    expect(body).toEqual({ historyBatchId: 'batch-abc-123' })
    expect(parseRecoveryAnchorRequest(body)).toEqual({
      ok: true,
      request: { kind: 'history-batch', historyBatchId: 'batch-abc-123' },
    })
  })

  it('buildResetPreviewBody never carries asOf, anchorOperationId, or any other key', () => {
    const body = buildResetPreviewBody('batch-xyz') as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['historyBatchId'])
    expect(Object.prototype.hasOwnProperty.call(body, 'asOf')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(body, 'anchorOperationId')).toBe(false)
  })

  it('buildResetExecuteBody({previewIdentity, confirm}) carries ONLY previewIdentity + confirm — the route\'s TOKEN-ONLY execute contract rejects historyBatchId/anchorOperationId/mode/asOf outright', () => {
    const body = buildResetExecuteBody({ previewIdentity: 'tok-1', confirm: 'reset' }) as Record<string, unknown>
    expect(body).toEqual({ previewIdentity: 'tok-1', confirm: 'reset' })
    for (const forbidden of ['asOf', 'historyBatchId', 'anchorOperationId', 'mode']) {
      expect(Object.prototype.hasOwnProperty.call(body, forbidden)).toBe(false)
    }
  })

  it('buildResetExecuteBody omits confirm entirely when not supplied (scenario (c): missing-confirm 400, not a blank-string confirm)', () => {
    const body = buildResetExecuteBody({ previewIdentity: 'tok-2' }) as Record<string, unknown>
    expect(body).toEqual({ previewIdentity: 'tok-2' })
    expect(Object.prototype.hasOwnProperty.call(body, 'confirm')).toBe(false)
  })

  it('regression guard: a body carrying asOf (the pre-migration contract) is refused exact-anchor-required — reintroducing it into the harness must turn this red', () => {
    expect(parseRecoveryAnchorRequest({ asOf: '2026-01-01T00:00:00.000Z' })).toEqual({
      ok: false,
      reason: 'exact-anchor-required',
    })
    // Co-present with a valid id: asOf still wins the refusal (exact-authority only, never silently ignored).
    expect(
      parseRecoveryAnchorRequest({ asOf: '2026-01-01T00:00:00.000Z', historyBatchId: 'batch-abc-123' }),
    ).toEqual({ ok: false, reason: 'exact-anchor-required' })
  })

  it('regression guard: an empty body (no id at all) is refused exact-anchor-required, matching the flag-off probe\'s pre-parse short-circuit expectations', () => {
    expect(parseRecoveryAnchorRequest({})).toEqual({ ok: false, reason: 'exact-anchor-required' })
  })
})
