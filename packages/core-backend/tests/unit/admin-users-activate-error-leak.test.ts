import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * HTTP-LEVEL LEAK CONTROL for `POST /api/admin/users/:id/activate`.
 *
 * Unlike `admin-users-activate-error-closure.test.ts` (static syntax) this file is a BEHAVIOUR
 * test: it drives the real registered route handler, lets the real `mapActivateError` +
 * `jsonError` build the real response body, and then walks that body.
 *
 * The scenario is the owner's: an UNKNOWN but LEGAL-PREFIX code (`ACTIVATE_*`-shaped, never
 * authored by `throwCoded`) carrying schema-shaped driver text. Under the deleted prefix test
 * this returned `500 / ACTIVATE_DB_FAILURE / column "secret_col" does not exist`.
 *
 * The walk is recursive over the ENTIRE body — every nested object, every array element, every
 * key AND every value — because "assert the message field is safe" only proves the message field
 * is safe. An absence assertion is worthless without a positive control, so the walker is first
 * shown to FIND the needle when the needle is present (including nested inside an array).
 */

const state = vi.hoisted(() => ({
  authUser: { id: 'admin-1', role: 'admin' } as { id: string; role: string },
  activateImpl: (() => {
    throw new Error('activateImpl not configured')
  }) as () => Promise<unknown>,
}))

const activateMocks = vi.hoisted(() => ({
  activatePendingUser: vi.fn(async () => state.activateImpl()),
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, _res: Response, next: (error?: unknown) => void) => {
    req.user = state.authUser as never
    next()
  },
}))

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(async (handler: (client: { query: () => Promise<unknown> }) => Promise<unknown>) =>
    handler({ query: async () => ({ rows: [] }) })),
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async () => true),
  listUserPermissions: vi.fn(async () => []),
  invalidateUserPerms: vi.fn(),
}))

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn() }))

vi.mock('../../src/auth/user-activate', () => ({
  activatePendingUser: activateMocks.activatePendingUser,
  isActivateMode: (value: unknown) =>
    value === 'temp_password' || value === 'sso' || value === 'admin_no_password',
}))

import { adminUsersRouter } from '../../src/routes/admin-users'

const ACTIVATE_PATH = '/api/admin/users/:id/activate'

/** The forged failure: an ACTIVATE_-shaped code that `throwCoded` never authors. */
const FORGED_CODE = 'ACTIVATE_DB_FAILURE'
/** Schema-shaped driver text. Every fragment is searched for independently. */
const DRIVER_TEXT = 'column "secret_col" of relation "user_orgs" does not exist'
const DRIVER_FRAGMENTS = ['secret_col', 'user_orgs', 'does not exist', 'relation', 'column']

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      this.headersSent = true
      return this
    },
  } as unknown as Response & { statusCode: number; body: unknown; headersSent: boolean }
}

async function invokeActivate(userId: string) {
  const router = adminUsersRouter()
  const layer = router.stack.find(
    (entry) => entry.route?.path === ACTIVATE_PATH && entry.route?.methods?.post,
  )
  if (!layer?.route?.stack) throw new Error(`Route POST ${ACTIVATE_PATH} not registered`)

  const req = {
    method: 'POST',
    url: ACTIVATE_PATH,
    headers: {},
    query: {},
    params: { id: userId },
    body: { mode: 'sso' },
    user: undefined,
  } as unknown as Request
  const res = createMockResponse()

  for (const routeLayer of layer.route.stack) {
    await new Promise<void>((resolve, reject) => {
      try {
        const maybePromise = routeLayer.handle(req, res, (error?: unknown) => {
          if (error) reject(error)
          else resolve()
        })
        if (maybePromise && typeof maybePromise.then === 'function') {
          Promise.resolve(maybePromise).then(() => resolve()).catch(reject)
        } else if (routeLayer.handle.length < 3) {
          resolve()
        }
      } catch (error) {
        reject(error)
      }
    })
  }
  return res
}

/**
 * Recursively visit EVERY string reachable in `value` — object values, object KEYS, array
 * elements at any depth — and return each occurrence of `needle` with the path that reached it.
 */
function findStringOccurrences(value: unknown, needle: string, path = '$'): string[] {
  const hits: string[] = []
  const seen = new Set<unknown>()

  const visit = (node: unknown, at: string) => {
    if (typeof node === 'string') {
      if (node.toLowerCase().includes(needle.toLowerCase())) hits.push(`${at} = ${JSON.stringify(node)}`)
      return
    }
    if (node === null || typeof node !== 'object') {
      // numbers / booleans / undefined / symbols stringify to nothing that can carry the needle,
      // except via String(); check that form too so a numeric-looking leak is not missed.
      if (node !== null && node !== undefined && String(node).toLowerCase().includes(needle.toLowerCase())) {
        hits.push(`${at} = ${String(node)}`)
      }
      return
    }
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      node.forEach((element, index) => visit(element, `${at}[${index}]`))
      return
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key.toLowerCase().includes(needle.toLowerCase())) hits.push(`${at}.<key:${key}>`)
      visit(child, `${at}.${key}`)
    }
  }

  visit(value, path)
  return hits
}

describe('activate error surface — HTTP-level leak control (behaviour, not syntax)', () => {
  beforeEach(() => {
    state.authUser = { id: 'admin-1', role: 'admin' }
    activateMocks.activatePendingUser.mockClear()
  })

  it('POSITIVE CONTROL: the walker finds the needle nested in arrays, objects, and keys', () => {
    // Without this, an absence assertion would pass against a walker that simply never descends.
    const planted = {
      ok: false,
      error: {
        code: 'X',
        message: 'safe',
        details: [
          { harmless: 1 },
          { nested: { deeper: [{ leak: DRIVER_TEXT }] } },
        ],
      },
    }
    for (const fragment of DRIVER_FRAGMENTS) {
      expect(
        findStringOccurrences(planted, fragment),
        `POSITIVE CONTROL FAILED: the recursive walker did not find '${fragment}' where it was `
        + 'deliberately planted, so its absence result on the real response proves nothing.',
      ).not.toEqual([])
    }
    // and it finds a needle hidden in a KEY, not only in a value
    expect(findStringOccurrences({ a: { secret_col: 'x' } }, 'secret_col')).not.toEqual([])
    // and it descends bare arrays at the root
    expect(findStringOccurrences([[[DRIVER_TEXT]]], 'secret_col')).not.toEqual([])
    // control on the control: a needle that is genuinely absent is reported absent
    expect(findStringOccurrences(planted, 'no_such_token_anywhere')).toEqual([])
  })

  it('an unknown but legal-prefix code with driver text leaks NOWHERE in the response body', () => {
    state.activateImpl = () => {
      throw Object.assign(new Error(DRIVER_TEXT), { code: FORGED_CODE })
    }

    return invokeActivate('user-1').then((res) => {
      // Recursive walk of the ENTIRE body FIRST — see the note in the authored-reason case: an
      // exact-shape assertion placed ahead of it would abort the test before the walk ran.
      for (const fragment of DRIVER_FRAGMENTS) {
        expect(
          findStringOccurrences(res.body, fragment),
          `DRIVER TEXT LEAK: '${fragment}' reached the client. Full body: ${JSON.stringify(res.body)}`,
        ).toEqual([])
      }

      // The forged code must not survive either — it is legal-PREFIX, not legal.
      expect(
        findStringOccurrences(res.body, FORGED_CODE),
        `The forged code '${FORGED_CODE}' appears in the response body. A prefix test is back.`,
      ).toEqual([])

      // Owner ruling: unknown → 500 / ACTIVATE_FAILED / fixed generic message.
      expect(res.statusCode).toBe(500)
      expect(res.body).toEqual({
        ok: false,
        error: { code: 'ACTIVATE_FAILED', message: 'Activation failed', details: undefined },
      })
    })
  })

  it('the same walk over an AUTHORED reason: ruled status, our message, still no driver text', () => {
    // ACTIVATE_RACE is one of the three the owner ruled on and one of the three that had no
    // coverage before this change. Its thrown message is replaced by ours even though the code
    // IS authored — the response path reads error.message for nobody.
    state.activateImpl = () => {
      throw Object.assign(new Error(DRIVER_TEXT), { code: 'ACTIVATE_RACE' })
    }

    return invokeActivate('user-1').then((res) => {
      // The WALK RUNS FIRST, deliberately. A preceding exact-shape assertion would throw before
      // the walk ever executed, so the walk would never be the thing that catches a regression —
      // it would just be dead weight behind a sibling guard. (Found by mutation: restoring the
      // `error.message` read reddened only the shape assertion until this was reordered.)
      for (const fragment of DRIVER_FRAGMENTS) {
        expect(
          findStringOccurrences(res.body, fragment),
          `DRIVER TEXT LEAK on an authored reason: '${fragment}' reached the client. `
          + `Full body: ${JSON.stringify(res.body)}`,
        ).toEqual([])
      }

      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual({
        ok: false,
        error: {
          code: 'ACTIVATE_RACE',
          message: 'User is no longer pending activation',
          details: undefined,
        },
      })
    })
  })

  it('the other two newly-ruled reasons answer 409 over HTTP as well', () => {
    const cases: Array<[string, number, string]> = [
      ['ACTIVATE_INTEGRATION_INACTIVE', 409, 'Directory integration is not active; cannot activate'],
      ['ACTIVATE_SOURCE_MISSING', 409, 'No linked active directory account for activation'],
    ]
    return cases.reduce(
      (chain, [code, status, message]) => chain.then(async () => {
        state.activateImpl = () => {
          throw Object.assign(new Error(DRIVER_TEXT), { code })
        }
        const res = await invokeActivate('user-1')
        expect({ status: res.statusCode, body: res.body }).toEqual({
          status,
          body: { ok: false, error: { code, message, details: undefined } },
        })
      }),
      Promise.resolve(),
    )
  })
})
