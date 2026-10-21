/**
 * Read transaction for subscription webhook delivery checks.
 *
 * Every read that decides one (webhook, event) delivery runs inside ONE `REPEATABLE READ READ ONLY`
 * transaction on its own pooled connection, so all of them see the same snapshot (for example: "the record
 * is live" and "the record is not denied to the owner" are answered from the same view).
 *
 * - Isolation cannot be raised inside a transaction that has already started, so this always opens a new
 *   transaction; it never joins a caller's transaction.
 * - A statement error inside a transaction aborts it, and later statements fail. A caught error therefore
 *   cannot be "recovered" into an allow: the closing sentinel statement must succeed, otherwise the whole
 *   check throws and the caller treats it as a failed check (no delivery).
 * - Delivery checks are bounded per process: each holds one permit for the life of its transaction only
 *   (released on commit or rollback, never held across an HTTP attempt). Waiting longer than the limit
 *   throws, which the caller treats as a failed check. Interactive reads (`bounded: false`) do not take a
 *   permit, so a burst of deliveries cannot turn them into errors.
 */
import { CompiledQuery, type Kysely } from 'kysely'
import type { Database } from '../db/types'
import type { QueryFn } from './permission-service'

const DEFAULT_PERMITS = 8
const DEFAULT_WAIT_MS = 10_000

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const PERMITS = positiveIntFromEnv('WEBHOOK_DELIVERY_CHECK_CONCURRENCY', DEFAULT_PERMITS)
const WAIT_MS = positiveIntFromEnv('WEBHOOK_DELIVERY_CHECK_WAIT_MS', DEFAULT_WAIT_MS)

export class WebhookDeliveryCheckBusyError extends Error {
  readonly code = 'WEBHOOK_DELIVERY_CHECK_BUSY'
  constructor() {
    super('webhook delivery check is busy')
    this.name = 'WebhookDeliveryCheckBusyError'
  }
}

let available = PERMITS
const waiters: Array<() => void> = []

async function acquirePermit(): Promise<void> {
  if (available > 0) {
    available -= 1
    return
  }
  await new Promise<void>((resolve, reject) => {
    const grant = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      const index = waiters.indexOf(grant)
      if (index >= 0) waiters.splice(index, 1)
      reject(new WebhookDeliveryCheckBusyError())
    }, WAIT_MS)
    waiters.push(grant)
  })
}

function releasePermit(): void {
  const next = waiters.shift()
  if (next) {
    next()
    return
  }
  available += 1
}

/**
 * Run `fn` with a `QueryFn` bound to a fresh `REPEATABLE READ READ ONLY` transaction. Resolves with `fn`'s
 * result only when the closing sentinel statement succeeds; any error (including a busy permit wait) throws.
 */
export async function runWebhookDeliveryCheck<T>(
  db: Kysely<Database>,
  fn: (query: QueryFn) => Promise<T>,
  options: { bounded?: boolean } = {},
): Promise<T> {
  const bounded = options.bounded !== false
  if (bounded) await acquirePermit()
  try {
    return await db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const query: QueryFn = async (text, params) => {
          const result = await trx.executeQuery(CompiledQuery.raw(text, params ?? []))
          return {
            rows: result.rows as unknown[],
            rowCount: result.numAffectedRows !== undefined ? Number(result.numAffectedRows) : result.rows.length,
          }
        }
        const value = await fn(query)
        // Sentinel: fails if any earlier statement aborted the transaction (even if its error was caught).
        const sentinel = await query('SELECT 1 AS ok')
        if ((sentinel.rows[0] as { ok?: unknown } | undefined)?.ok !== 1) {
          throw new Error('webhook delivery check sentinel failed')
        }
        return value
      })
  } finally {
    if (bounded) releasePermit()
  }
}
