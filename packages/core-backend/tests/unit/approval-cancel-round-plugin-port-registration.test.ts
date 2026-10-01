import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Cancel-round product entry (C2 gate r1, P3-1) — the plugin's registration guard for the entry port.
 *
 * plugin-attendance registers the cancel-round routes only when core lends it
 * `services.approvalCancelRoundEntry` with ALL SIX methods; with any one of them missing it registers
 * NONE of the routes (fail-closed: no entry rather than a half-wired one that answers 500 from an
 * `undefined` call). The UUID harness pins the positive direction; this file pins the neutral one,
 * parameterised over the six methods. The positive control keeps the six negative cases from
 * passing vacuously (a guard that registered nothing at all would satisfy them).
 *
 * Routes are matched by path token rather than a fixed list, so a route added later under the same
 * token is counted by the negative cases as well.
 */

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')

const PORT_METHODS = [
  'canReadDocument',
  'readRoundSummary',
  'launch',
  'decide',
  'withdraw',
  'listSeatedPendingRounds',
] as const

const EXPECTED_CANCEL_ROUND_ROUTES = [
  'GET /api/attendance/cancel-rounds/pending',
  'GET /api/attendance/requests/:id/cancel-round',
  'POST /api/attendance/requests/:id/cancel-round',
  'POST /api/attendance/requests/:id/cancel-round/actions',
  'POST /api/attendance/requests/:id/cancel-round/withdraw',
]

const CANCEL_ROUND_PATH_TOKENS = ['cancel-round', 'cancelround', 'cancel_round']

function isCancelRoundRoute(key: string): boolean {
  const lower = key.toLowerCase()
  return CANCEL_ROUND_PATH_TOKENS.some((token) => lower.includes(token))
}

function unreachable(): () => Promise<never> {
  return vi.fn(async () => {
    throw new Error('cancel-round entry port must not be reached in the registration harness')
  })
}

function portWithout(missing: (typeof PORT_METHODS)[number] | null): Record<string, unknown> {
  const port: Record<string, unknown> = {}
  for (const method of PORT_METHODS) {
    if (method !== missing) port[method] = unreachable()
  }
  return port
}

async function registeredRouteKeys(port: Record<string, unknown> | null): Promise<string[]> {
  const keys: string[] = []
  const db = {
    __w4CanonicalTrx: true as const,
    query: vi.fn(async () => {
      throw new Error('db disabled in registration harness')
    }),
    transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(db)),
  }
  await attendancePlugin.activate({
    api: {
      database: db,
      events: { emit: vi.fn() },
      http: {
        addRoute(method: string, path: string) {
          keys.push(`${method.toUpperCase()} ${path}`)
        },
      },
    },
    services: port ? { approvalCancelRoundEntry: port } : {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })
  return keys
}

const originalAsyncEnabled = process.env.ATTENDANCE_IMPORT_ASYNC_ENABLED

afterEach(async () => {
  await attendancePlugin.deactivate()
  if (originalAsyncEnabled === undefined) delete process.env.ATTENDANCE_IMPORT_ASYNC_ENABLED
  else process.env.ATTENDANCE_IMPORT_ASYNC_ENABLED = originalAsyncEnabled
  vi.restoreAllMocks()
})

describe('plugin-attendance registers the cancel-round routes only with the complete six-method entry port', () => {
  it('positive control: with all six methods, exactly the five cancel-round routes register', async () => {
    process.env.ATTENDANCE_IMPORT_ASYNC_ENABLED = 'false'
    const keys = await registeredRouteKeys(portWithout(null))
    // Non-vacuity: the plugin did register its other routes in this harness.
    expect(keys.length).toBeGreaterThan(EXPECTED_CANCEL_ROUND_ROUTES.length)
    expect(keys.filter(isCancelRoundRoute).sort()).toEqual(EXPECTED_CANCEL_ROUND_ROUTES)
  })

  it.each(PORT_METHODS)('without `%s`, none of the cancel-round routes registers', async (missing) => {
    process.env.ATTENDANCE_IMPORT_ASYNC_ENABLED = 'false'
    const keys = await registeredRouteKeys(portWithout(missing))
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter(isCancelRoundRoute)).toEqual([])
  })

  it('a method present but not a function counts as missing', async () => {
    process.env.ATTENDANCE_IMPORT_ASYNC_ENABLED = 'false'
    const port = { ...portWithout(null), listSeatedPendingRounds: 'not-a-function' }
    const keys = await registeredRouteKeys(port)
    expect(keys.filter(isCancelRoundRoute)).toEqual([])
  })

  it('with no port lent at all, none of the cancel-round routes registers', async () => {
    process.env.ATTENDANCE_IMPORT_ASYNC_ENABLED = 'false'
    const keys = await registeredRouteKeys(null)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter(isCancelRoundRoute)).toEqual([])
  })
})
