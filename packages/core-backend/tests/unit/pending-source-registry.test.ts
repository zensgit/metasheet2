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
 *
 * Follow-up (gate report `impl-gate-B1-f2-logging-and-B2-rebase-20260920.md` P3-1/P3-2):
 * - P3-1: the "throwing logger never blocks degradation" test below spies on `Logger.prototype.
 *   warn` (the call-site boundary, same technique as every other test here) and makes it throw —
 *   this is an OR over the two guards the fix adds (assignment-before-log AND the log's own
 *   try/catch), so it is a defence-in-depth check, not single-axis discrimination between them.
 * - P3-2: `org` was deleted from the meta object `logSourceFailure` builds; the request's tenant
 *   now reaches the log ONLY via `Logger`'s own `mergeMeta` (as `tenant_id`), so the "attaches /
 *   omits the tenant" test below has to look past the call-site spy to observe it — it restores
 *   the mocked `warn` for that one test and spies one hop further down, at the shared winston
 *   `Logger.prototype.log` (the level-methods `create-logger.js` builds forward `self.log(level,
 *   message, mergedMeta)` to; `mergeMeta` has already run by then, unlike the `warn`-level spy the
 *   other tests use). It also asserts `org` is never fabricated at either boundary — the "省略/不
 *   虚构" NIT-2 case.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import winston from 'winston'

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

  it('never fabricates an `org` field at the call site, and lets the logger\'s own `tenant_id` injection carry the request context (or omit it when none is active) — P3-2', async () => {
    const registry = new PendingSourceRegistry()
    registry.register({ name: 'flaky-source', listPendingForUser: vi.fn().mockRejectedValue(new Error('boom')) })

    // The call-site meta (what `logSourceFailure` itself builds) never has `org` — this is the
    // "not fabricated" half, observable at the same boundary every other test in this file uses.
    await runWithRequestContext({ correlationId: 'corr-1', tenantId: 'org-42' }, () =>
      registry.listPendingForUser(VIEWER),
    )
    expect(warnSpy.mock.calls[0][1]).not.toHaveProperty('org')

    // The "attaches / omits" half lives one hop further down, inside `Logger.mergeMeta`, which the
    // call-site `warn` spy never sees (it fires before `mergeMeta` runs). Restore the real `warn`
    // implementation for just this assertion and spy on the shared winston `Logger.prototype.log`
    // instead — every level method (`.warn`, `.info`, …) that `create-logger.js` builds for a
    // 2-arg call forwards to it as `self.log(level, message, mergedMeta)`, so it's the first place
    // downstream of the call site where the merged meta (tenant_id included) is observable.
    warnSpy.mockRestore()
    const logSpy = vi.spyOn(winston.Logger.prototype, 'log').mockImplementation(() => winston.Logger.prototype)

    await runWithRequestContext({ correlationId: 'corr-2', tenantId: 'org-42' }, () =>
      registry.listPendingForUser(VIEWER),
    )
    expect(logSpy).toHaveBeenCalledTimes(1)
    const [, , mergedMeta] = logSpy.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(mergedMeta).not.toHaveProperty('org') // still never fabricated, one hop down too
    expect(mergedMeta.tenant_id).toBe('org-42') // the logger's OWN injection, not ours

    logSpy.mockClear()
    await registry.listPendingForUser(VIEWER) // no active request context this time
    expect(logSpy).toHaveBeenCalledTimes(1)
    const [, , mergedMetaNoCtx] = logSpy.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(mergedMetaNoCtx).not.toHaveProperty('org')
    expect(mergedMetaNoCtx).not.toHaveProperty('tenant_id') // omitted, not fabricated as e.g. '' or null

    logSpy.mockRestore()
  })

  it('a throwing failure-logger never turns a source outage into an aggregate crash — degradation is written before the (best-effort) log runs — P3-1', async () => {
    const registry = new PendingSourceRegistry()
    registry.register({ name: 'flaky-source', listPendingForUser: vi.fn().mockRejectedValue(new Error('boom')) })
    registry.register({ name: 'healthy-source', listPendingForUser: vi.fn().mockResolvedValue([item('h-3')]) })

    warnSpy.mockImplementation(() => {
      throw new Error('logging transport exploded')
    })

    // Must not reject: if `listPendingForUser` propagated the logger's throw, this `await` itself
    // would throw and fail the test — the assertions below only run if degradation survived it.
    const result = await registry.listPendingForUser(VIEWER)

    expect(result.sources['flaky-source']).toBe('unavailable')
    expect(result.sources['healthy-source']).toBe('ok')
    expect(result.items).toEqual([item('h-3')])
  })
})
