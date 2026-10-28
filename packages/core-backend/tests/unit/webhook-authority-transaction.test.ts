/**
 * Delivery-check permits (U16).
 *
 * Delivery checks are bounded per process: with every permit held, another delivery check waits at most
 * the configured time and then fails (the caller treats that as a failed check). The delivery-history read
 * does not take a permit, so it is answered even while deliveries hold them all. A released permit is
 * reused. Runs with one permit and a short wait, set before the module loads; the database is a stub that
 * answers the few statements involved.
 */
import { afterAll, describe, expect, test, vi } from 'vitest'

const saved = vi.hoisted(() => {
  const value = {
    concurrency: process.env.WEBHOOK_DELIVERY_CHECK_CONCURRENCY,
    wait: process.env.WEBHOOK_DELIVERY_CHECK_WAIT_MS,
  }
  process.env.WEBHOOK_DELIVERY_CHECK_CONCURRENCY = '1'
  process.env.WEBHOOK_DELIVERY_CHECK_WAIT_MS = '80'
  return value
})

vi.mock('../../src/multitable/recovery-authorization-stability', () => ({
  loadDatabaseFreshRecoveryAccess: async (_q: unknown, userId: string) => ({ userId, permissions: ['multitable:read'], isAdminRole: false }),
}))

vi.mock('../../src/multitable/permission-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/permission-service')>()
  return {
    ...actual,
    resolveSheetCapabilitiesForAccess: async (_q: unknown, _sheetId: string, access: unknown) => ({
      access,
      capabilities: { canRead: true, canManageAutomation: true },
      capabilityOrigin: { source: 'global-rbac', hasSheetAssignments: false },
      sheetLiveness: 'live',
    }),
  }
})

import { runWebhookDeliveryCheck } from '../../src/multitable/webhook-authority-transaction'
import { authorizeWebhookOwnerCurrentAccess } from '../../src/multitable/webhook-delivery-authority'

function fakeDb() {
  const respond = async (cq: { sql: string }) => {
    if (cq.sql.includes('SELECT 1 AS ok')) return { rows: [{ ok: 1 }] }
    if (cq.sql.includes('FROM users')) {
      return { rows: [{ is_active: true, role: 'user', activation_status: 'activated', must_change_password: false }] }
    }
    return { rows: [] }
  }
  return {
    transaction: () => {
      const builder: Record<string, unknown> = {}
      builder.setIsolationLevel = () => builder
      builder.setAccessMode = () => builder
      builder.execute = async (fn: (trx: unknown) => Promise<unknown>) => fn({ executeQuery: respond })
      return builder
    },
  } as never
}

/** Holds the only permit until `release()` is called. */
function holdPermit() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const held = runWebhookDeliveryCheck(fakeDb(), async () => {
    await gate
    return 'held'
  })
  return { release, held }
}

afterAll(() => {
  for (const [key, value] of [
    ['WEBHOOK_DELIVERY_CHECK_CONCURRENCY', saved.concurrency],
    ['WEBHOOK_DELIVERY_CHECK_WAIT_MS', saved.wait],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('U16 delivery-check permits', () => {
  test('U16.busy with every permit held, a delivery check fails after the wait', async () => {
    const h = holdPermit()
    try {
      const outcome = await runWebhookDeliveryCheck(fakeDb(), async () => 'second').then(
        () => 'completed',
        (err: { code?: string }) => err?.code,
      )
      expect(outcome, 'U16.busy').toBe('WEBHOOK_DELIVERY_CHECK_BUSY')
    } finally {
      h.release()
    }
    expect(await h.held, 'U16.busy.heldCompletes').toBe('held')
  })

  test('U16.unbounded an unbounded read runs while every permit is held', async () => {
    const h = holdPermit()
    try {
      await expect(runWebhookDeliveryCheck(fakeDb(), async () => 'read', { bounded: false }), 'U16.unbounded').resolves.toBe('read')
    } finally {
      h.release()
      await h.held
    }
  })

  test('U16.historyUnbounded the delivery-history access check is answered while deliveries hold every permit', async () => {
    const h = holdPermit()
    try {
      const result = await authorizeWebhookOwnerCurrentAccess(fakeDb(), { id: 'wh1', createdBy: 'owner1', sheetId: 'sheet1' })
      expect(result, 'U16.historyUnbounded').toEqual({ ok: true })
    } finally {
      h.release()
      await h.held
    }
  })

  test('U16.release a released permit is reused', async () => {
    const h = holdPermit()
    h.release()
    await h.held
    await expect(runWebhookDeliveryCheck(fakeDb(), async () => 'next'), 'U16.release').resolves.toBe('next')
  })
})
