import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  assertExactB1cControlRoster,
  assertB1cDatabaseTarget,
  isSnapshotNotAllowedError,
  readSnapshotPage,
  readSnapshotPageSequence,
  runConnectionLossControl,
  sqlServerErrorNumbers,
  type MssqlRequestLike,
  type MssqlTransactionLike,
} from './spike-b1c-sqlserver'

function requestReturning(
  rows: Array<Array<{ keyValue: number; sessionId: number }> | Error>,
): MssqlRequestLike {
  return {
    input() {
      return this
    },
    async query<T>() {
      const next = rows.shift()
      if (next instanceof Error) throw next
      return { recordset: (next ?? []) as T[] }
    },
    async batch<T>() {
      return { recordset: [] as T[] }
    },
  }
}

function transactionReturning(
  pages: Array<Array<{ keyValue: number; sessionId: number }> | Error>,
): MssqlTransactionLike & { requestCalls: number } {
  const request = requestReturning(pages)
  return {
    requestCalls: 0,
    async begin() {
      return this
    },
    async commit() {},
    async rollback() {},
    request() {
      this.requestCalls += 1
      return request
    },
  }
}

describe('B1c transaction-bound page reader', () => {
  it('reads every page through the supplied transaction and runs the mutation callback after page 1', async () => {
    const transaction = transactionReturning([
      [
        { keyValue: 10, sessionId: 41 },
        { keyValue: 20, sessionId: 41 },
        { keyValue: 30, sessionId: 41 },
      ],
      [
        { keyValue: 40, sessionId: 41 },
        { keyValue: 50, sessionId: 41 },
      ],
    ])
    const afterFirstPage = vi.fn(async () => undefined)
    const result = await readSnapshotPageSequence(
      transaction,
      3,
      afterFirstPage,
    )
    expect(result).toEqual({
      keys: [10, 20, 30, 40, 50],
      sessionIds: [41, 41],
      pageSizes: [3, 2],
    })
    expect(transaction.requestCalls).toBe(2)
    expect(afterFirstPage).toHaveBeenCalledTimes(1)
  })

  it('fails closed on invalid bounds, empty pages, or a page spanning sessions', async () => {
    await expect(
      readSnapshotPage(transactionReturning([]), -1, 3),
    ).rejects.toThrow(/invalid page bounds/)
    await expect(
      readSnapshotPage(transactionReturning([[]]), 0, 3),
    ).rejects.toThrow(/unexpected empty page/)
    await expect(
      readSnapshotPage(
        transactionReturning([
          [
            { keyValue: 10, sessionId: 41 },
            { keyValue: 20, sessionId: 42 },
          ],
        ]),
        0,
        3,
      ),
    ).rejects.toThrow(/crossed SQL Server sessions/)
  })
})

describe('B1c connection-loss posture', () => {
  it('constructs exactly one transaction and rejects both the next page and commit without resnapshot', async () => {
    let factoryCalls = 0
    const transaction = transactionReturning([
      [
        { keyValue: 10, sessionId: 51 },
        { keyValue: 20, sessionId: 51 },
        { keyValue: 30, sessionId: 51 },
      ],
      new Error('connection killed'),
    ])
    transaction.commit = vi.fn(async () => {
      throw new Error('transaction aborted')
    })
    const killSession = vi.fn(async () => true)
    const result = await runConnectionLossControl(
      () => {
        factoryCalls += 1
        return transaction
      },
      5,
      killSession,
    )
    expect(result).toEqual({
      killedSessionAbsent: true,
      pageAfterLossRejected: true,
      commitAfterLossRejected: true,
      transactionFactoryCalls: 1,
    })
    expect(factoryCalls).toBe(1)
    expect(killSession).toHaveBeenCalledWith(51)
  })

  it('does not report a loss proof if the same transaction can keep reading or commit', async () => {
    const transaction = transactionReturning([
      [
        { keyValue: 10, sessionId: 51 },
        { keyValue: 20, sessionId: 51 },
        { keyValue: 30, sessionId: 51 },
      ],
      [
        { keyValue: 40, sessionId: 51 },
        { keyValue: 50, sessionId: 51 },
      ],
    ])
    const result = await runConnectionLossControl(
      () => transaction,
      5,
      async () => false,
    )
    expect(result.killedSessionAbsent).toBe(false)
    expect(result.pageAfterLossRejected).toBe(false)
    expect(result.commitAfterLossRejected).toBe(false)
  })

  it('does not let arbitrary page and commit failures stand in for a confirmed killed session', async () => {
    const transaction = transactionReturning([
      [
        { keyValue: 10, sessionId: 51 },
        { keyValue: 20, sessionId: 51 },
        { keyValue: 30, sessionId: 51 },
      ],
      new Error('unrelated timeout'),
    ])
    transaction.commit = vi.fn(async () => {
      throw new Error('unrelated transaction error')
    })
    const result = await runConnectionLossControl(
      () => transaction,
      5,
      async () => false,
    )
    expect(result).toEqual({
      killedSessionAbsent: false,
      pageAfterLossRejected: true,
      commitAfterLossRejected: true,
      transactionFactoryCalls: 1,
    })
  })
})

describe('B1c dedicated database guard', () => {
  it('accepts only the fixed B1c database', () => {
    expect(() => assertB1cDatabaseTarget('b1c_spike_sqlserver')).not.toThrow()
    expect(() => assertB1cDatabaseTarget('b1b_spike_sqlserver')).toThrow(
      /refusing to target/,
    )
    expect(() => assertB1cDatabaseTarget('master')).toThrow(
      /refusing to target/,
    )
  })
})

describe('B1c executable entry point', () => {
  it('fails instead of skip-green when no SQL Server host is configured', () => {
    const childEnv = { ...process.env }
    delete childEnv.MSSQL_HOST
    delete childEnv.MSSQL_SERVER
    const result = spawnSync(
      path.join(process.cwd(), 'node_modules/.bin/tsx'),
      [path.join(process.cwd(), 'scripts/spike-b1c-sqlserver.ts')],
      {
        encoding: 'utf8',
        env: childEnv,
      },
    )
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('[skip]')
    expect(result.stderr).toContain(
      '[failed] B1c SQL Server snapshot page-sequence spike',
    )
  })
})

describe('B1c SQL Server error and control vocabularies', () => {
  it('finds the exact SQL Server number through the node-mssql originalError chain', () => {
    const original = Object.assign(new Error('driver text'), { number: 3952 })
    const wrapped = Object.assign(new Error('wrapper text'), {
      originalError: original,
    })
    expect(sqlServerErrorNumbers(wrapped)).toEqual([3952])
    expect(isSnapshotNotAllowedError(wrapped)).toBe(true)
    expect(
      sqlServerErrorNumbers(Object.assign(new Error(), { number: 3951 })),
    ).toEqual([3951])
    expect(
      isSnapshotNotAllowedError(Object.assign(new Error(), { number: 3951 })),
    ).toBe(false)
  })

  it('does not invoke hostile accessors while reading an error chain', () => {
    const hostile = Object.defineProperty({}, 'originalError', {
      get() {
        throw new Error('must not escape')
      },
    })
    expect(sqlServerErrorNumbers(hostile)).toEqual([])
  })

  it('requires the exact frozen control roster in order', () => {
    const ids = [
      'B1C-WRITE-OPT-IN',
      'B1C-DEDICATED-DATABASE',
      'B1C-SNAPSHOT-OFF-NEGATIVE',
      'B1C-FOREIGN-SESSION-CONTROL',
      'B1C-SEQUENCE-DISCRIMINATOR',
    ]
    expect(() => assertExactB1cControlRoster(ids)).not.toThrow()
    expect(() => assertExactB1cControlRoster(ids.slice(1))).toThrow(
      /frozen B1c roster/,
    )
    expect(() =>
      assertExactB1cControlRoster([...ids, 'B1C-UNDECLARED']),
    ).toThrow(/frozen B1c roster/)
  })
})
