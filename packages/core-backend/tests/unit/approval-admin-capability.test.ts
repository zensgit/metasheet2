/**
 * P1b round 2, item (1) — `GET /api/approvals/admin/capability`.
 *
 * The defect this closes: the admin batch-transfer page gated itself on a TOKEN-derived admin flag
 * (`getAccessSnapshot().isAdmin`) while the approval list scope's admin arm is DB-derived
 * (`users.is_active AND (is_admin OR role = 'admin')`). A principal admitted by the first but not
 * the second was served a subset of the picked approver's queue and the page stated, as fact, that
 * the approver had nothing to transfer.
 *
 * These tests pin the SERVER half: the route answers the DB predicate, it answers it for a caller
 * whose token says admin but whose `users` row does not, it is not behind a permission guard (which
 * would fold the permission axis back in), and a lookup failure is NEVER folded into `false`.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'
import {
  APPROVAL_ADMIN_CAPABILITY_PREDICATE,
  isApprovalAdministrator,
} from '../../src/services/approval-admin-capability'

const authState = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
}))

const pgState = vi.hoisted(() => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

vi.mock('../../src/db/pg', () => ({
  pool: pgState.pool,
  query: pgState.pool.query,
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!authState.user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.user = authState.user as never
    next()
  },
}))

vi.mock('../../src/rbac/service', () => ({
  userHasPermission: vi.fn().mockResolvedValue(false),
  isAdmin: vi.fn().mockResolvedValue(false),
  listUserPermissions: vi.fn().mockResolvedValue([]),
  invalidateUserPerms: vi.fn(),
  getPermCacheStatus: vi.fn().mockReturnValue({ size: 0 }),
}))

vi.mock('../../src/rbac/namespace-admission', () => ({
  isPermissionAllowedByNamespaceAdmission: vi.fn().mockResolvedValue(true),
  filterPermissionCodesByNamespaceAdmission: vi.fn().mockImplementation(
    (_userId: string, codes: string[]) => Promise.resolve(codes),
  ),
}))

const CAPABILITY_PATH = '/api/approvals/admin/capability'

/**
 * Everything a captured `Logger.error(...)` call would carry into the emitted record, flattened into
 * one searchable string. Used by both disclosure tests below so they cannot drift apart.
 *
 * AN ERROR ARGUMENT IS SERIALIZED TWO WAYS, and the second is not redundant. `Logger.error(msg, err)`
 * folds the error into what it emits, so reading only the message argument would call a "fix" clean
 * that had merely moved the interpolation into the second argument — hence `name`/`message`/`stack`,
 * which `JSON.stringify` cannot see because they are not enumerable. But a driver's `code` (and
 * anything else assigned onto the error, which is how every case below is built) IS an own
 * enumerable property, and the first form cannot see THAT. A record that leaked the raw `.code`
 * through a nested error object read as clean until this line was widened.
 */
function capturedLogRecord(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls
    .map((call) => call
      .map((arg) => (arg instanceof Error
        ? `${arg.name}:${arg.message}:${arg.stack ?? ''}:${JSON.stringify(arg)}`
        : typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' '))
    .join('\n')
}

/**
 * The code the fixed message actually carries, read back out of the emitted line. Compared WHOLE:
 * `toContain('… (UNCLASSIFIED)')` would still pass on a record that had also appended a fragment of
 * a refused value somewhere else in the same line.
 */
function emittedErrorCode(record: string): string | undefined {
  return /approval admin capability lookup failed \(([^)]*)\)/.exec(record)?.[1]
}

describe('GET /api/approvals/admin/capability', () => {
  let app: Express
  const pinned = usePinnedServer()

  beforeEach(async () => {
    vi.resetModules()
    authState.user = null
    pgState.pool.query.mockReset()
    pgState.pool.query.mockResolvedValue({ rows: [], rowCount: 0 })
    pgState.pool.connect.mockReset()

    const { approvalsRouter } = await import('../../src/routes/approvals')
    app = express()
    app.use(express.json())
    app.use(approvalsRouter())
    pinned.setApp(app)
  })

  it('requires authentication', async () => {
    const res = await request(pinned.url()).get(CAPABILITY_PATH)
    expect(res.status).toBe(401)
  })

  it('answers TRUE when the users row satisfies the list scope predicate', async () => {
    authState.user = { id: 'u-db-admin', permissions: [] }
    pgState.pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 })

    const res = await request(pinned.url()).get(CAPABILITY_PATH)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, data: { isApprovalAdmin: true } })
  })

  it('answers FALSE for a TOKEN-only admin whose users row does not satisfy it', async () => {
    // The exact principal the P2 finding names: role/permission claims that make the web client's
    // `getAccessSnapshot().isAdmin` true, with no matching `users`-table admin columns.
    authState.user = {
      id: 'u-token-admin',
      role: 'admin',
      roles: ['admin'],
      permissions: ['*:*', 'users:write', 'approvals:admin'],
    }
    pgState.pool.query.mockResolvedValue({ rows: [], rowCount: 0 })

    const res = await request(pinned.url()).get(CAPABILITY_PATH)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, data: { isApprovalAdmin: false } })
  })

  it('binds the CALLER id and reads the users columns the list scope arm reads', async () => {
    authState.user = { id: 'u-caller', permissions: [] }
    await request(pinned.url()).get(CAPABILITY_PATH)

    expect(pgState.pool.query).toHaveBeenCalledTimes(1)
    const [sql, params] = pgState.pool.query.mock.calls[0] as [string, unknown[]]
    expect(params).toEqual(['u-caller'])
    expect(sql).toContain('FROM users')
    expect(sql).toContain('is_active = TRUE')
    expect(sql).toContain("is_admin = TRUE OR role = 'admin'")
    // Never the token: no claim value may reach the statement.
    expect(sql).not.toContain('approvals:admin')
  })

  it('is NOT behind a permission guard — a caller with no permissions gets an answer, not a 403', async () => {
    authState.user = { id: 'u-none', permissions: [] }
    const res = await request(pinned.url()).get(CAPABILITY_PATH)
    expect(res.status).toBe(200)
    expect(res.body.data.isApprovalAdmin).toBe(false)
  })

  it('answers 500 (never `false`) when the lookup fails', async () => {
    authState.user = { id: 'u-db-admin', permissions: [] }
    pgState.pool.query.mockRejectedValue(new Error('connection reset'))

    const res = await request(pinned.url()).get(CAPABILITY_PATH)
    expect(res.status).toBe(500)
    expect(res.body?.ok).toBe(false)
    expect(res.body?.error?.code).toBe('APPROVAL_ADMIN_CAPABILITY_FAILED')
    // "Could not determine" must not be reported as a statement about the caller's rights.
    expect(JSON.stringify(res.body)).not.toContain('isApprovalAdmin')
  })

  // Round-4 item 4. The failure PATH is the disclosure path: a driver message is assembled from
  // whatever the driver was holding — hosts, ports, connection URIs with credentials, and for a
  // constraint violation the offending row — and the earlier revision interpolated it verbatim into
  // a log line. Nothing above catches that: every assertion there is about the RESPONSE, and the
  // response was already generic.
  it('logs a fixed message with a restricted code — never the driver’s error text', async () => {
    // A marker no legitimate log line could contain, standing in for whatever a real driver would
    // have put in the same position.
    const MARKER = 'zzsyntheticsecretzz'
    const { Logger } = await import('../../src/core/logger')
    // Spied on the PROTOTYPE, so the router's module-scope instance is covered without reaching
    // into it, and mocked out so nothing is written to the real transport either.
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    try {
      authState.user = { id: 'u-db-admin', permissions: [] }
      pgState.pool.query.mockRejectedValue(
        Object.assign(new Error(`connection to 10.0.0.1:5432 failed: password=${MARKER}`), { code: 'ECONNREFUSED' }),
      )

      const res = await request(pinned.url()).get(CAPABILITY_PATH)

      // The existing envelope is unchanged: a generic code, and no marker anywhere in it.
      expect(res.status).toBe(500)
      expect(res.body?.error?.code).toBe('APPROVAL_ADMIN_CAPABILITY_FAILED')
      expect(JSON.stringify(res.body)).not.toContain(MARKER)

      // EVERY argument of every call is inspected, not just the message — see `capturedLogRecord`
      // for why an Error argument is serialized both by its non-enumerable fields and by
      // `JSON.stringify`, and which regression each half catches.
      expect(errorSpy).toHaveBeenCalled()
      const emitted = capturedLogRecord(errorSpy)
      expect(emitted).not.toContain(MARKER)
      expect(emitted).not.toContain('10.0.0.1')
      // POSITIVE CONTROL: this is not passing because nothing useful was logged. The fixed message
      // and the driver's own bounded code — the part an operator can act on — are both there.
      expect(emitted).toContain('approval admin capability lookup failed')
      expect(emitted).toContain('ECONNREFUSED')
    } finally {
      errorSpy.mockRestore()
    }
  })

  // Round-5 item 3. The test above proves the MESSAGE is not interpolated; this one is about the
  // `code` itself, which is interpolated and therefore has to be bounded by SHAPE rather than by
  // length. The earlier revision stripped the disallowed characters and kept the remainder, so a
  // driver that had put free text in `.code` still reached the log — as one run, separators gone,
  // truncated at 40. Truncating a disclosure is not removing it. The rule now is whole-value: a
  // code either matches an allowed shape and is emitted unchanged, or it is replaced in full by a
  // constant, so no fragment of a rejected value is ever manufactured into the line.
  it('replaces an out-of-shape error code with a constant, never a fragment of it', async () => {
    const { Logger } = await import('../../src/core/logger')
    const MARKER = 'zzsyntheticsecretzz'
    // 60 characters, one alphanumeric run: the shape a length cap alone would have truncated into
    // the log rather than refused. It contains the marker, so "the run did not survive" is checked
    // against a value no legitimate code could contain.
    const LONG_RUN = `A${MARKER}0123456789abcdefghijklmnopqrstuvwxyz0123456789`
    expect(LONG_RUN.length).toBeGreaterThan(40)

    const cases: Array<{ what: string; thrown: unknown; expectCode: string; absent?: string[] }> = [
      // The two REFUSALS. `expectCode` is the constant, compared WHOLE against the code the line
      // actually carries — that comparison is what catches "a fragment of a refused value reached
      // the code position", which is the strip-and-cap behaviour this rule replaced.
      //
      // `absent` covers the REST OF THE RECORD, which the code comparison says nothing about: a
      // value reaching the log through some OTHER argument (an `err` folded in as
      // `Logger.error(msg, err)`, a debugging meta object carrying the raw code). Measured, not
      // assumed — that regression leaves the emitted code at the constant and is caught here and
      // nowhere else; see `capturedLogRecord` for the serialization it needs to be visible at all.
      //
      // A previous revision also listed a hand-written reconstruction of the OLD implementation's
      // stripped output. It was transcribed wrong — one digit short — so it could never have
      // matched anything, and its comment asserted a provenance it did not have. A reconstruction
      // of a different implementation is not evidence about this one, so it is gone rather than
      // corrected; the whole-value code comparison above is what covers that regression.
      {
        what: 'a long alphanumeric run',
        thrown: Object.assign(new Error('boom'), { code: LONG_RUN }),
        expectCode: 'UNCLASSIFIED',
        absent: [MARKER, LONG_RUN],
      },
      {
        what: 'free text with separators',
        thrown: Object.assign(new Error('boom'), { code: `connect ECONNREFUSED 10.0.0.1:5432 password=${MARKER}` }),
        expectCode: 'UNCLASSIFIED',
        // The two secrets this input carries — a host and a credential — named directly.
        absent: [MARKER, '10.0.0.1'],
      },
      { what: 'an object where a code should be', thrown: Object.assign(new Error('boom'), { code: { toString: () => MARKER } }), expectCode: 'UNCLASSIFIED', absent: [MARKER] },
      // The POSITIVE CONTROLS, and they are what make the two refusals meaningful: this is not
      // passing because the function returns a constant for everything. A SQLSTATE and an errno —
      // the two things a real failure on this route actually carries — reach the log verbatim.
      { what: 'a PostgreSQL SQLSTATE', thrown: Object.assign(new Error('boom'), { code: '42P01' }), expectCode: '42P01' },
      { what: 'a Node errno', thrown: Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }), expectCode: 'ETIMEDOUT' },
      // No `code` at all: the error's own name, which is the documented fallback.
      { what: 'no code, only a name', thrown: new TypeError('boom'), expectCode: 'TypeError' },
    ]

    for (const testCase of cases) {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
      try {
        authState.user = { id: 'u-db-admin', permissions: [] }
        pgState.pool.query.mockRejectedValue(testCase.thrown)

        const res = await request(pinned.url()).get(CAPABILITY_PATH)
        expect(res.status, testCase.what).toBe(500)
        expect(JSON.stringify(res.body), testCase.what).not.toContain(MARKER)

        const emitted = capturedLogRecord(errorSpy)

        // The message is fixed in every case — the code is the only thing that varies, and it is
        // compared whole rather than by containment (see `emittedErrorCode`).
        expect(emittedErrorCode(emitted), testCase.what).toBe(testCase.expectCode)
        for (const forbidden of testCase.absent ?? []) {
          expect(emitted, `${testCase.what}: ${forbidden.slice(0, 24)}`).not.toContain(forbidden)
        }
      } finally {
        errorSpy.mockRestore()
      }
    }
  })
})

describe('isApprovalAdministrator', () => {
  function fakeDb(rows: unknown[]) {
    const calls: Array<[string, unknown[]]> = []
    return {
      calls,
      db: {
        query: (sql: string, params?: unknown[]) => {
          calls.push([sql, params ?? []])
          return Promise.resolve({ rows, rowCount: rows.length })
        },
      },
    }
  }

  it('maps a returned row to true and no row to false', async () => {
    const withRow = fakeDb([{ '?column?': 1 }])
    await expect(isApprovalAdministrator(withRow.db as never, 'u1')).resolves.toBe(true)
    const withoutRow = fakeDb([])
    await expect(isApprovalAdministrator(withoutRow.db as never, 'u1')).resolves.toBe(false)
  })

  it('refuses an unusable viewer id without querying at all', async () => {
    const blank = fakeDb([{ '?column?': 1 }])
    await expect(isApprovalAdministrator(blank.db as never, '   ')).resolves.toBe(false)
    expect(blank.calls).toHaveLength(0)
  })

  it('PROPAGATES a lookup failure rather than fail-closing to false', async () => {
    const exploding = {
      query: () => Promise.reject(new Error('relation "users" does not exist')),
    }
    await expect(isApprovalAdministrator(exploding as never, 'u1')).rejects.toThrow(/users/)
  })
})

describe('the capability predicate agrees with the two existing DB-backed admin arms', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = join(here, '..', '..', 'src')

  function read(rel: string): string {
    return readFileSync(join(src, rel), 'utf8')
  }

  const CANONICAL_ARM_TAIL = `is_active = TRUE AND (is_admin = TRUE OR role = 'admin')`

  // The arm is EXTRACTED rather than searched for inside the whole source: a whole-file
  // `toContain` reports the entire file on failure and can be satisfied by a DOCBLOCK restating
  // the arm instead of by the executed SQL. Both existing sites alias the `users` table; the
  // capability query does not, so aliases are stripped from the extracted span only.
  const ADMIN_ARM_RE = /FROM users(?: \w+)? WHERE (?:\w+\.)?id = \S+ AND (?:\w+\.)?is_active = TRUE AND \((?:\w+\.)?is_admin = TRUE OR (?:\w+\.)?role = 'admin'\)/g

  function extractAdminArms(source: string): string[] {
    const collapsed = source.replace(/\s+/g, ' ')
    return (collapsed.match(ADMIN_ARM_RE) ?? [])
      .map((arm) => arm.replace(/^FROM users \w+ /, 'FROM users ').replace(/\b\w+\./g, ''))
  }

  it('the capability predicate is byte-identical to the condition both arms apply', () => {
    expect(APPROVAL_ADMIN_CAPABILITY_PREDICATE).toBe(CANONICAL_ARM_TAIL)
  })

  it('the list scope arm 5 still applies exactly that condition', () => {
    const arms = extractAdminArms(read('services/ApprovalBridgeService.ts'))
    // Exactly one — a second site would mean the file grew another admin arm to keep in step.
    expect(arms).toHaveLength(1)
    expect(arms[0].endsWith(CANONICAL_ARM_TAIL)).toBe(true)
  })

  it('the per-instance readability arm 5 still applies exactly that condition', () => {
    const arms = extractAdminArms(read('services/approval-instance-readability.ts'))
    expect(arms).toHaveLength(1)
    expect(arms[0]).toBe(`FROM users WHERE id = $2 AND ${CANONICAL_ARM_TAIL}`)
  })

  it('positive control: the extractor finds nothing when the condition is not the canonical one', () => {
    const decoy = `EXISTS (SELECT 1 FROM users scope_admin WHERE scope_admin.id = $1\n  AND scope_admin.is_active = TRUE\n  AND (scope_admin.is_admin = TRUE OR scope_admin.role = 'superuser'))`
    expect(extractAdminArms(decoy)).toEqual([])
    // …and finds it when it is, so the empty result above is a real refusal, not a broken regex.
    const genuine = decoy.replace("'superuser'", "'admin'")
    expect(extractAdminArms(genuine)).toEqual([`FROM users WHERE id = $1 AND ${CANONICAL_ARM_TAIL}`])
  })
})
