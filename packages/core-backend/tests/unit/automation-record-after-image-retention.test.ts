/** Protocol/lifecycle unit evidence, not PostgreSQL lock or retention evidence. */
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAutomationRecordAfterImageRetention, pruneAutomationRecordAfterImages,
  AutomationRecordAfterImageRetentionError } from '../../src/multitable/automation-record-after-image-retention'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
function fixture(ids: string[] = ['synthetic-outbox']) {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const trx: TransactionalQueryable = { isTransaction: true, async query(sql, params) {
    calls.push({ sql, params })
    if (sql.startsWith('SET LOCAL')) return { rows: [], rowCount: null }
    if (sql.includes('transaction_isolation')) return { rows: [{ isolation: 'read committed' }], rowCount: 1 }
    if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: '100' }], rowCount: 1 }
    if (sql.startsWith('SELECT i.outbox_id')) return { rows: ids.map(outbox_id => ({ outbox_id })), rowCount: ids.length }
    if (sql.startsWith('DELETE FROM meta_automation_record_after_images')) return { rows: [], rowCount: ids.length }
    throw new Error('Unexpected unit protocol SQL')
  } }
  const transactionCalls = vi.fn()
  const transaction = async <T>(work: (query: TransactionalQueryable) => Promise<T>): Promise<T> => {
    transactionCalls()
    return work(trx)
  }
  return { calls, trx, transaction, transactionCalls }
}
afterEach(() => { vi.restoreAllMocks() })

describe('After-image-only retention protocol', () => {
  it('uses fixed DB age/batch, locks both rows, and rechecks before the only DELETE', async () => {
    const f = fixture()
    expect(await pruneAutomationRecordAfterImages(f)).toBe(1)
    expect(f.calls.slice(0, 2).map(call => call.sql)).toEqual([
      "SET LOCAL statement_timeout = '5000ms'", "SET LOCAL lock_timeout = '200ms'",
    ])
    const selected = f.calls.find(call => call.sql.startsWith('SELECT i.outbox_id'))!
    const deleted = f.calls.find(call => call.sql.startsWith('DELETE'))!
    expect(selected.sql).toContain("c.status='done'")
    expect(selected.sql).toContain("clock_timestamp()-INTERVAL '7 days'")
    expect(selected.sql).toContain('LIMIT 200 FOR UPDATE OF c,i SKIP LOCKED')
    expect(selected.params).toEqual(['automation-record-trigger'])
    expect(deleted.sql).toContain("c.status='done'")
    expect(deleted.sql).toContain("clock_timestamp()-INTERVAL '7 days'")
    expect(deleted.params).toEqual([['synthetic-outbox'], 'automation-record-trigger'])
    expect(f.calls.filter(call => /^(?:INSERT|UPDATE|DELETE)/u.test(call.sql))).toEqual([deleted])
    expect(f.transactionCalls).toHaveBeenCalledTimes(1)
  })
  it('does not DELETE when there are no locked candidates', async () => {
    const f = fixture([])
    expect(await pruneAutomationRecordAfterImages(f)).toBe(0)
    expect(f.calls.some(call => call.sql.startsWith('DELETE'))).toBe(false)
  })
  it.each([['duplicate', 'duplicate'], Array.from({ length: 201 }, (_, index) => `synthetic-${index}`), ['']].map(ids => ({ ids })))(
    'rejects malformed or out-of-bound candidate receipts %# before deletion', async ({ ids }) => {
      const f = fixture(ids)
      await expect(pruneAutomationRecordAfterImages(f)).rejects.toBeInstanceOf(AutomationRecordAfterImageRetentionError)
      expect(f.calls.some(call => call.sql.startsWith('DELETE'))).toBe(false)
    },
  )
  it('reports missing-table/driver and commit-receipt failures with one values-free code', async () => {
    const f = fixture()
    for (const transaction of [async () => { throw new Error('synthetic-private-driver-detail') },
      async <T>(work: (trx: TransactionalQueryable) => Promise<T>) => { await work(f.trx); throw new Error('synthetic-private-commit-detail') }]) {
      let caught: unknown
      try { await pruneAutomationRecordAfterImages({ transaction }) } catch (error) { caught = error }
      expect(caught).toMatchObject({ code: 'AUTOMATION_RECORD_AFTER_IMAGE_RETENTION_UNAVAILABLE',
        message: 'AUTOMATION_RECORD_AFTER_IMAGE_RETENTION_UNAVAILABLE' })
      expect(caught).not.toHaveProperty('cause')
      expect(String(caught)).not.toContain('synthetic-private')
    }
  })
})

describe('Dispatcher-owned retention lifecycle (no timer)', () => {
  it('coalesces ticks, returns the actual promise, and stop drains SQL already entered', async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>()
    const transactionCalls = vi.fn()
    const transaction = async <T>(work: (trx: TransactionalQueryable) => Promise<T>): Promise<T> => {
      transactionCalls()
      entered.resolve(); await release.promise
      return work(f.trx)
    }
    const service = createAutomationRecordAfterImageRetention({ transaction })
    const first = service.tick()
    await entered.promise
    expect(service.tick()).toBe(first)
    let stopped = false
    const stopping = service.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(await service.tick()).toBe(0)
    expect(transactionCalls).toHaveBeenCalledTimes(1)
    release.resolve()
    expect(await first).toBe(1)
    await stopping
    expect(stopped).toBe(true)
    expect(await service.tick()).toBe(0)
    expect(transactionCalls).toHaveBeenCalledTimes(1)
  })
  it('stop before a scheduled microtask begins prevents any SQL', async () => {
    const f = fixture(), service = createAutomationRecordAfterImageRetention(f)
    const pending = service.tick()
    await service.stop()
    expect(await pending).toBe(0)
    expect(f.transactionCalls).not.toHaveBeenCalled()
  })
  it.each([false, true])('throttles attempts for 15 minutes including failure=%s without a background retry', async fail => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    const f = fixture()
    const transactionCalls = vi.fn()
    const transaction = async <T>(work: (trx: TransactionalQueryable) => Promise<T>): Promise<T> => {
      transactionCalls()
      if (fail) throw new Error('synthetic private failure')
      return work(f.trx)
    }
    const service = createAutomationRecordAfterImageRetention({ transaction })
    if (fail) await expect(service.tick()).rejects.toBeInstanceOf(AutomationRecordAfterImageRetentionError)
    else expect(await service.tick()).toBe(1)
    clock.mockReturnValue(900999)
    expect(await service.tick()).toBe(0)
    expect(transactionCalls).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(901000)
    if (fail) await expect(service.tick()).rejects.toBeInstanceOf(AutomationRecordAfterImageRetentionError)
    else expect(await service.tick()).toBe(1)
    expect(transactionCalls).toHaveBeenCalledTimes(2)
    await service.stop()
  })
  it('stop drains a rejected attempt while tick still exposes its fixed failure', async () => {
    const entered = deferred<void>(), release = deferred<void>()
    const service = createAutomationRecordAfterImageRetention({ transaction: async () => {
      entered.resolve(); await release.promise; throw new Error('synthetic private failure')
    } })
    const tick = service.tick()
    const observed = expect(tick).rejects.toBeInstanceOf(AutomationRecordAfterImageRetentionError)
    await entered.promise
    let finished = false
    const stopped = service.stop().then(() => { finished = true })
    await Promise.resolve(); expect(finished).toBe(false)
    release.resolve()
    await observed; await stopped
    expect(finished).toBe(true)
  })
})

it('actual host drives and explicitly drains retention without replacing recovery (AST only, not full boot)', () => {
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  function nodes<T extends ts.Node>(root: ts.Node, match: (node: ts.Node) => node is T): T[] {
    const found: T[] = []
    const visit = (node: ts.Node): void => { if (match(node)) found.push(node); ts.forEachChild(node, visit) }
    visit(root)
    return found
  }
  const calls = (root: ts.Node, expression: string) => nodes(root, ts.isCallExpression)
    .filter(node => node.expression.getText(source) === expression)
  const field = nodes(source, ts.isPropertyDeclaration).filter(node => node.name.getText(source) === 'automationRecordAfterImageRetention')
  expect(field).toHaveLength(1)
  expect(calls(field[0], 'createAutomationRecordAfterImageRetention')).toHaveLength(1)
  expect(field[0].initializer?.getText(source)).toContain('transaction: automationReadTransaction')
  const boot = calls(source, 'bootDurableDelivery')
  expect(boot).toHaveLength(1)
  const observer = boot[0].arguments[2] as ts.ObjectLiteralExpression
  for (const name of ['onTick', 'onTickError']) {
    const handler = observer.properties.filter(node => node.name?.getText(source) === name)
    expect(handler).toHaveLength(1)
    expect(calls(handler[0], 'this.automationReadRecovery.tick')).toHaveLength(1)
    expect(calls(handler[0], 'this.automationRecordAfterImageRetention.tick')).toHaveLength(1)
    expect(handler[0].getText(source)).toContain('AUTOMATION_RECORD_AFTER_IMAGE_RETENTION_UNAVAILABLE')
  }
  const stops = nodes(source, ts.isMethodDeclaration).filter(node => node.name.getText(source) === 'stopOnce')
  expect(stops).toHaveLength(1)
  const loop = calls(stops[0], 'this.durableDeliveryLoop.stop'), retention = calls(stops[0], 'this.automationRecordAfterImageRetention.stop')
  expect(loop).toHaveLength(1); expect(retention).toHaveLength(1)
  expect(loop[0].end).toBeLessThan(retention[0].pos)
  const declarations = nodes(stops[0], ts.isVariableDeclaration)
  const tasks = declarations.find(node => node.name.getText(source) === 'shutdownTasks')!
  expect(tasks.initializer?.getText(source)).toContain('automationRecordAfterImageRetentionDrain')
  const barrier = calls(stops[0], 'this.waitForShutdownBarrier').find(node => node.arguments[0]?.getText(source) === 'shutdownTasks')!
  expect(barrier.end).toBeLessThan(calls(stops[0], 'pool.end')[0].pos)
})
