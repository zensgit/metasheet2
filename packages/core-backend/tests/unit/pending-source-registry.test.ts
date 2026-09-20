/**
 * `PendingSourceRegistry` per-source catch logging — acceptance finding F-2
 * (`todo-center-real-browser-acceptance-20260920.md` §6 P2): both `catch` blocks in
 * `pending-source-registry.ts` were bare, so a source outage produced zero backend signal (the
 * client-visible degradation to `unavailable` was — and still is — the ONLY observable effect).
 *
 * This suite is DB-independent: `PendingSourceRegistry` never touches a table itself, only the
 * `PendingSource` objects registered against it do, so a deliberately-throwing stub source is
 * enough to exercise both catches without a live server or database. Runs in the default no-DB
 * vitest project (`vitest.config.ts`), not the todo-center real-DB gate.
 *
 * Every test here first re-asserts the EXISTING fail-closed/degradation shape (source flagged
 * `unavailable`, its items dropped, sibling sources unaffected) exactly as
 * `tests/todo-center-pending-gate/todo-center-pending-gate.ts` judging criterion B already does —
 * so a regression to that contract fails here too, not just in the heavier real-DB gate — and only
 * THEN asserts the new logging behaviour, so a change that logs but silently alters degradation
 * semantics (the "不改返回值/降级语义" constraint) would be caught by the same test.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { Logger } from '../../src/core/logger'
import { runWithRequestContext } from '../../src/context/request-context'
import {
  PendingSourceRegistry,
  type PendingItem,
  type PendingViewer,
} from '../../src/services/pending-source-registry'

const VIEWER: PendingViewer = { actorId: 'user-1', roles: ['employee'], permissions: ['approvals:read'] }

function item(id: string): PendingItem {
  return {
    source: 'healthy-source',
    id,
    title: `item ${id}`,
    href: `/x/${id}`,
    updatedAt: '2026-09-20T00:00:00.000Z',
  }
}

describe('PendingSourceRegistry — per-source catch logging (acceptance finding F-2)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Spied on the PROTOTYPE (mirrors `approval-admin-capability.test.ts`'s
    // `vi.spyOn(Logger.prototype, 'error')` pattern) so the registry's module-scope `logger`
    // instance is covered without reaching into the module, and mocked out so nothing is written
    // to the real transport.
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('listPendingForUser: a throwing source stays `unavailable` (unchanged) and now logs a warn with its sourceId, message and code', async () => {
    const registry = new PendingSourceRegistry()
    const boom = Object.assign(new Error('connection refused'), { code: '42501' })
    registry.register({ name: 'flaky-source', listPendingForUser: vi.fn().mockRejectedValue(boom) })
    registry.register({ name: 'healthy-source', listPendingForUser: vi.fn().mockResolvedValue([item('h-1')]) })

    const result = await registry.listPendingForUser(VIEWER)

    // PRE-EXISTING degradation contract — must stay green. Fail-closed, discriminable, and the
    // sibling source's item is unaffected by the throwing one.
    expect(result.sources['flaky-source']).toBe('unavailable')
    expect(result.sources['healthy-source']).toBe('ok')
    expect(result.items).toEqual([item('h-1')])

    // NEW: the failure is no longer silent.
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [message, meta] = warnSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toContain('flaky-source')
    expect(meta).toMatchObject({ sourceId: 'flaky-source', error: 'connection refused', code: '42501' })
  })

  it('countPendingForUser: a throwing dedicated count method stays `unavailable` (unchanged) and logs a warn with its sourceId; no `.code` is fabricated for a plain Error', async () => {
    const registry = new PendingSourceRegistry()
    registry.register({
      name: 'flaky-count-source',
      listPendingForUser: vi.fn().mockResolvedValue([]),
      countPendingForUser: vi.fn().mockRejectedValue(new Error('pool exhausted')),
    })
    registry.register({ name: 'healthy-source', listPendingForUser: vi.fn().mockResolvedValue([item('h-2')]) })

    const result = await registry.countPendingForUser(VIEWER)

    expect(result.sources['flaky-count-source']).toBe('unavailable')
    expect(result.sources['healthy-source']).toBe('ok')
    expect(result.count).toBe(1) // only the healthy source's single item is counted, not folded into 0

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [message, meta] = warnSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toContain('flaky-count-source')
    expect(meta.sourceId).toBe('flaky-count-source')
    expect(meta.error).toBe('pool exhausted')
    expect(meta.code).toBeUndefined()
  })

  it('a non-Error throw does not crash the aggregator and is still logged with a stringified error field', async () => {
    const registry = new PendingSourceRegistry()
    registry.register({ name: 'weird-source', listPendingForUser: vi.fn().mockRejectedValue('not-an-error') })

    const result = await registry.listPendingForUser(VIEWER)

    expect(result.sources['weird-source']).toBe('unavailable')
    expect(result.items).toEqual([])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [, meta] = warnSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(meta.error).toBe('not-an-error')
  })

  it('attaches the request-scoped org (tenant) to the warn when a request context is active, and omits it when none is', async () => {
    const registry = new PendingSourceRegistry()
    registry.register({ name: 'flaky-source', listPendingForUser: vi.fn().mockRejectedValue(new Error('boom')) })

    await runWithRequestContext({ correlationId: 'corr-1', tenantId: 'org-42' }, () =>
      registry.listPendingForUser(VIEWER),
    )
    expect((warnSpy.mock.calls[0][1] as Record<string, unknown>).org).toBe('org-42')

    warnSpy.mockClear()
    await registry.listPendingForUser(VIEWER) // no active request context this time
    expect((warnSpy.mock.calls[0][1] as Record<string, unknown>).org).toBeUndefined()
  })
})
