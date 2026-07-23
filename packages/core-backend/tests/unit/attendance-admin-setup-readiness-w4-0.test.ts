/**
 * W4-0 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED §3/§4/§9): mock-level contract coverage
 * for `GET /api/attendance-admin/setup-readiness` and its computational core in
 * `services/AttendanceSetupReadinessAggregate.ts`.
 *
 * Real-Postgres behavioural proof (§9 W4-0-G1..G5, especially the read-only transaction actually
 * REJECTING writes — a mock cannot prove that) lives in
 * `tests/integration/attendance-setup-readiness-w4-0.db.test.ts`. This file's job is everything a
 * mock CAN prove: response shape, key-set/values-free discipline, status-code matrix, the SQL
 * text's org-anchor count, the ④ closed-set posture branches, the ⑥ deliveryRuntime/env
 * independence, the previewReady formula, and the negative meta-assertion that no first-word/regex
 * "read-only" check exists anywhere in the implementation (§9 W4-0-G2's explicit ban).
 *
 * Mutation evidence (load-bearing; PR body cross-references these by name):
 *  - move the `buildAttendanceSetupReadiness` call before `canReadAttendanceDirectoryReadiness` ⇒
 *    "403 issues ZERO aggregation" red.
 *  - drop `org_id = $1` from any org-counts CTE leg ⇒ the SQL-audit test's exact-count assertion red.
 *  - change ④'s default→ready mapping ⇒ the punch-policy-posture branch tests red.
 *  - fold ⑥'s three notify signals into one, or make previewReady read `punchPolicyPosture`/`notify`
 *    ⇒ the G4-echo / previewReady-independence tests red.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const queryMock = vi.fn()
const transactionMock = vi.fn()
const getSharedAttendanceSchedulerMock = vi.fn()

vi.mock('../../src/db/pg', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  transaction: (...args: unknown[]) => transactionMock(...args),
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}))

vi.mock('../../src/services/AttendanceScheduler', () => ({
  getSharedAttendanceScheduler: () => getSharedAttendanceSchedulerMock(),
}))

vi.mock('../../src/rbac/rbac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/rbac')>()
  return {
    ...actual,
    rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  }
})

vi.mock('../../src/rbac/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return {
    ...actual,
    isAdmin: vi.fn(async (userId: string) => userId === 'platform-admin'),
    listUserPermissions: vi.fn(async () => []),
  }
})

vi.mock('../../src/routes/admin-users', () => ({
  ensurePlatformAdmin: vi.fn(async () => null),
}))

vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({
  redeliverFailedAttendanceNotification: vi.fn(),
}))

vi.mock('../../src/services/ApprovalDirectoryOrg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/ApprovalDirectoryOrg')>()
  return { ...actual, MAX_MANAGER_CHAIN_LEVELS: 10 }
})

const { attendanceAdminRouter, ATTENDANCE_SETUP_READINESS_DEPLOYMENT_SCOPED_FIELDS } = await import(
  '../../src/routes/attendance-admin'
)
const {
  ATTENDANCE_SETUP_READINESS_STATUS_VALUES,
  ATTENDANCE_SETUP_STEP_IDS,
  ATTENDANCE_PUNCH_POLICY_CLOSED_SET_KEYS_IN,
  ATTENDANCE_PUNCH_POLICY_CLOSED_SET_KEYS_OUT,
  ATTENDANCE_PUNCH_POLICY_CLOSED_SET_DEFAULT,
  computeAttendanceSetupReadinessDeliveryRuntime,
  computeAttendanceSetupReadinessPreviewReady,
  computeAttendanceSetupReadinessStep3Ready,
  readAttendanceSetupReadinessOrgCounts,
  readAttendancePunchPolicyPosture,
  readAttendanceSetupReadinessOrgRecipientBinding,
  runAttendanceSetupReadinessReadOnly,
} = await import('../../src/services/AttendanceSetupReadinessAggregate')

const pinned = usePinnedServer()

function makeApp(user: Record<string, unknown> | null) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = user ?? undefined
    next()
  })
  app.use(attendanceAdminRouter())
  return app
}

/** Wires `transactionMock` so `SET TRANSACTION READ ONLY`, the SAVEPOINT/RELEASE SAVEPOINT pair
 *  bracketing the ④ probe (P3-1, #4541 review), and the four business reads all resolve correctly
 *  — content-DISPATCHED on SQL text rather than positional FIFO. This is deliberate, not
 *  incidental: P3-1's SAVEPOINT wrapping means `readAttendancePunchPolicyPosture` now issues THREE
 *  round-trips (SAVEPOINT / SELECT / RELEASE SAVEPOINT) that interleave with the sibling ⑥
 *  `orgRecipientBinding` read inside the SAME `Promise.all` (all four aggregation reads share one
 *  client) — a fixed positional sequence would silently feed the wrong canned row to the wrong
 *  query the moment that interleaving shifts (fragile even today, and a future change to any of the
 *  four functions' internal await count would shift it further). Dispatching on each query's own
 *  distinguishing SQL fragment is immune to call-order entirely. */
function mockTransactionQueries(resolvedValues: {
  directoryLinked?: { rows: unknown[] }
  orgCounts?: { rows: unknown[] }
  punchPolicy?: { rows: unknown[] }
  orgRecipientBinding?: { rows: unknown[] }
}) {
  transactionMock.mockImplementationOnce(async (handler: (client: { query: (...a: unknown[]) => Promise<unknown> }) => Promise<unknown>) => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (/^SET TRANSACTION READ ONLY/i.test(sql)) return { rows: [] }
      // SAVEPOINT / RELEASE SAVEPOINT / ROLLBACK TO SAVEPOINT (P3-1) — no business row, always a
      // no-op ack.
      if (/SAVEPOINT/i.test(sql)) return { rows: [] }
      if (/FROM system_configs/.test(sql)) return resolvedValues.punchPolicy ?? { rows: [] }
      if (/bound_recipient_count/.test(sql)) return resolvedValues.orgRecipientBinding ?? { rows: [{ bound_recipient_count: 0 }] }
      if (/AS ready/.test(sql)) return resolvedValues.directoryLinked ?? { rows: [{ ready: false }] }
      return resolvedValues.orgCounts ?? { rows: [OK_COUNTS_ROW] } // org-counts CTE (member_scope ...)
    })
    return handler({ query: clientQuery })
  })
}

const OK_COUNTS_ROW = {
  org_active_member_count: 3,
  group_count: 2,
  groups_with_members: 1,
  shift_count: 2,
  scheduled_shift_group_count: 0,
  active_rotation_rule_count: 0,
  approval_flow_count: 1,
}

describe('value domain (§3/§7 exhaustiveness)', () => {
  it('is exactly the seven locked values, in the locked order', () => {
    expect(ATTENDANCE_SETUP_READINESS_STATUS_VALUES).toEqual([
      'ready',
      'missing',
      'forbidden',
      'unknown',
      'manual_review_required',
      'unsupported',
      'db_not_ready',
    ])
  })

  it('exposes exactly the seven canonical step ids, in wizard order', () => {
    expect(ATTENDANCE_SETUP_STEP_IDS).toEqual([
      'attendance-admin-user-access',
      'attendance-admin-groups',
      'attendance-admin-shifts',
      'attendance-admin-settings',
      'attendance-admin-approval-flows',
      'attendance-admin-notification-deliveries',
      'preview',
    ])
  })
})

describe('readAttendanceSetupReadinessOrgCounts (org-anchor SQL audit, §4.2 追加门禁2)', () => {
  beforeEach(() => queryMock.mockReset())

  it('issues a single query with org_id = $1 exactly 7 times and one positional param', async () => {
    queryMock.mockResolvedValueOnce({ rows: [OK_COUNTS_ROW] })
    const result = await readAttendanceSetupReadinessOrgCounts('org-a', queryMock as never)
    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    const orgIdMatches = sql.match(/org_id\s*=\s*\$1/g) ?? []
    // Mutation target ②: dropping any leg's org_id filter drops this count below 7.
    expect(orgIdMatches).toHaveLength(7)
    expect(params).toEqual(['org-a'])
    expect(sql).not.toMatch(/\$2/)
    expect(result).toEqual({
      orgActiveMemberCount: 3,
      groupCount: 2,
      groupsWithMembers: 1,
      shiftCount: 2,
      scheduledShiftGroupCount: 0,
      activeRotationRuleCount: 0,
      approvalFlowCount: 1,
    })
  })

  it('scopes ① to BOTH user_orgs.is_active AND users.is_active (RD-3 double filter)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [OK_COUNTS_ROW] })
    await readAttendanceSetupReadinessOrgCounts('org-a', queryMock as never)
    const [sql] = queryMock.mock.calls[0] as [string]
    expect(sql).toMatch(/uo\.is_active\s*=\s*true/)
    expect(sql).toMatch(/u\.is_active\s*=\s*true/)
  })

  it('scopes ③ activeRotationRuleCount to is_active = true (not all rotation rules)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [OK_COUNTS_ROW] })
    await readAttendanceSetupReadinessOrgCounts('org-a', queryMock as never)
    const [sql] = queryMock.mock.calls[0] as [string]
    expect(sql).toMatch(/attendance_rotation_rules[\s\S]*?is_active\s*=\s*true/)
  })

  it('returns no PII/identifying columns — counts only', async () => {
    queryMock.mockResolvedValueOnce({ rows: [OK_COUNTS_ROW] })
    await readAttendanceSetupReadinessOrgCounts('org-a', queryMock as never)
    const [sql] = queryMock.mock.calls[0] as [string]
    expect(sql).not.toMatch(/name|email|mobile|phone|user_id\s*[,)]/i)
  })
})

describe('computeAttendanceSetupReadinessStep3Ready (§3③ errata formula)', () => {
  it('false when shiftCount=0 regardless of other signals', () => {
    expect(computeAttendanceSetupReadinessStep3Ready(0, 0, 0)).toBe(false)
    expect(computeAttendanceSetupReadinessStep3Ready(0, 1, 5)).toBe(false)
  })
  it('true when shiftCount>0 and no scheduled-shift group exists', () => {
    expect(computeAttendanceSetupReadinessStep3Ready(2, 0, 0)).toBe(true)
  })
  it('false when a scheduled-shift group exists but no active rotation rule does', () => {
    expect(computeAttendanceSetupReadinessStep3Ready(2, 1, 0)).toBe(false)
  })
  it('true when a scheduled-shift group exists AND an active rotation rule does', () => {
    expect(computeAttendanceSetupReadinessStep3Ready(2, 1, 1)).toBe(true)
  })
})

describe('computeAttendanceSetupReadinessPreviewReady (§3.2 / §9 W4-0-G4)', () => {
  const base = {
    orgActiveMemberCount: 1,
    groupCount: 1,
    groupsWithMembers: 1,
    shiftCount: 1,
    scheduledShiftGroupCount: 0,
    activeRotationRuleCount: 0,
    approvalFlowCount: 1,
  }

  it('true when ①②③⑤ all ready', () => {
    expect(computeAttendanceSetupReadinessPreviewReady(base)).toBe(true)
  })

  it.each([
    ['orgActiveMemberCount', 0],
    ['groupCount', 0],
    ['groupsWithMembers', 0],
    ['shiftCount', 0],
    ['approvalFlowCount', 0],
  ] as const)('false when %s drops to %d', (field, value) => {
    expect(computeAttendanceSetupReadinessPreviewReady({ ...base, [field]: value })).toBe(false)
  })

  // §9 W4-0-G4: the function signature itself cannot see punchPolicyPosture or notify — the
  // strongest possible "④/⑥ never gate previewReady" proof (a compile-time, not just runtime, one).
  it('the input type structurally excludes punchPolicyPosture and notify (④/⑥ cannot gate)', () => {
    const keys = Object.keys(base)
    expect(keys).not.toContain('punchPolicyPosture')
    expect(keys).not.toContain('notify')
  })
})

describe('readAttendancePunchPolicyPosture (§3④ / §3.1 closed set)', () => {
  beforeEach(() => queryMock.mockReset())

  // P3-1 (#4541 review): the probe now brackets its SELECT with SAVEPOINT/RELEASE SAVEPOINT — queue
  // the bracketing acks around the given SELECT resolution so every test below still only has to
  // state the SELECT's own result.
  function mockPostureProbe(selectResolvedValue: { rows: unknown[] }) {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SAVEPOINT
    queryMock.mockResolvedValueOnce(selectResolvedValue) // SELECT value FROM system_configs
    queryMock.mockResolvedValueOnce({ rows: [] }) // RELEASE SAVEPOINT
  }

  it('no system_configs row ⇒ default', async () => {
    mockPostureProbe({ rows: [] })
    expect(await readAttendancePunchPolicyPosture(queryMock as never)).toBe('default')
  })

  it('row equals normalized defaults exactly ⇒ default', async () => {
    mockPostureProbe({
      rows: [
        {
          value: JSON.stringify({
            punchPolicy: {
              unscheduled: { mode: 'allow' },
              merge: { internalWinsOnIn: false, externalWinsOnOut: false },
              outdoor: { requireApproval: false, requireNote: false, requirePhoto: false, approvalFlowId: '' },
            },
            ipAllowlist: [],
            geoFence: null,
            minPunchIntervalMinutes: 1,
            // Negative control (G5): an unrelated key changing must NOT flip the posture.
            holidaySync: { lastRun: '2026-07-21T00:00:00.000Z' },
          }),
        },
      ],
    })
    expect(await readAttendancePunchPolicyPosture(queryMock as never)).toBe('default')
  })

  it('G5 negative control: only annualLeavePolicy differs ⇒ still default', async () => {
    mockPostureProbe({
      rows: [
        {
          value: JSON.stringify({
            punchPolicy: {
              unscheduled: { mode: 'allow' },
              merge: { internalWinsOnIn: false, externalWinsOnOut: false },
              outdoor: { requireApproval: false, requireNote: false, requirePhoto: false, approvalFlowId: '' },
            },
            ipAllowlist: [],
            geoFence: null,
            minPunchIntervalMinutes: 1,
            annualLeavePolicy: { enabled: true },
          }),
        },
      ],
    })
    expect(await readAttendancePunchPolicyPosture(queryMock as never)).toBe('default')
  })

  it('G5 positive control: unscheduled.mode differs ⇒ customized', async () => {
    mockPostureProbe({
      rows: [
        {
          value: JSON.stringify({
            punchPolicy: {
              unscheduled: { mode: 'block' },
              merge: { internalWinsOnIn: false, externalWinsOnOut: false },
              outdoor: { requireApproval: false, requireNote: false, requirePhoto: false, approvalFlowId: '' },
            },
            ipAllowlist: [],
            geoFence: null,
            minPunchIntervalMinutes: 1,
          }),
        },
      ],
    })
    expect(await readAttendancePunchPolicyPosture(queryMock as never)).toBe('customized')
  })

  it('row exists but has no punchPolicy key ⇒ unknown (pre-S0 / corrupted shape)', async () => {
    mockPostureProbe({ rows: [{ value: JSON.stringify({ foo: 'bar' }) }] })
    expect(await readAttendancePunchPolicyPosture(queryMock as never)).toBe('unknown')
  })

  it('malformed JSON ⇒ unknown (fail-closed, not a throw), and the savepoint is rolled back (P3-1)', async () => {
    mockPostureProbe({ rows: [{ value: '{not json' }] })
    expect(await readAttendancePunchPolicyPosture(queryMock as never)).toBe('unknown')
    // The SELECT itself succeeded (it's the synchronous JSON.parse afterward that throws) — the
    // catch block still issues ROLLBACK TO SAVEPOINT unconditionally, never RELEASE, for any error
    // caught in this scope.
    expect(queryMock).toHaveBeenCalledTimes(3)
    expect((queryMock.mock.calls[2] as [string])[0]).toMatch(/^ROLLBACK TO SAVEPOINT/)
  })

  it('legacy 038-JSONB shape (driver returns an already-parsed object) ⇒ handled, not thrown', async () => {
    mockPostureProbe({
      rows: [
        {
          value: {
            punchPolicy: {
              unscheduled: { mode: 'allow' },
              merge: { internalWinsOnIn: false, externalWinsOnOut: false },
              outdoor: { requireApproval: false, requireNote: false, requirePhoto: false, approvalFlowId: '' },
            },
            ipAllowlist: [],
            geoFence: null,
            minPunchIntervalMinutes: 1,
          },
        },
      ],
    })
    expect(await readAttendancePunchPolicyPosture(queryMock as never)).toBe('default')
  })

  it('a successful probe SAVEPOINTs then RELEASEs — never leaves an open savepoint (P3-1)', async () => {
    mockPostureProbe({ rows: [] })
    await readAttendancePunchPolicyPosture(queryMock as never)
    expect(queryMock).toHaveBeenCalledTimes(3)
    expect((queryMock.mock.calls[0] as [string])[0]).toMatch(/^SAVEPOINT /)
    expect((queryMock.mock.calls[2] as [string])[0]).toMatch(/^RELEASE SAVEPOINT /)
    // Same savepoint name on both ends of the bracket.
    const savepointName = (queryMock.mock.calls[0] as [string])[0].replace(/^SAVEPOINT /, '')
    expect((queryMock.mock.calls[2] as [string])[0]).toBe(`RELEASE SAVEPOINT ${savepointName}`)
  })

  it('query throws ⇒ unknown, and the shared transaction is recovered via ROLLBACK TO SAVEPOINT, not left aborted (P3-1)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SAVEPOINT
    queryMock.mockRejectedValueOnce(new Error('SECRET_DETAIL boom')) // SELECT throws
    queryMock.mockResolvedValueOnce({ rows: [] }) // ROLLBACK TO SAVEPOINT
    expect(await readAttendancePunchPolicyPosture(queryMock as never)).toBe('unknown')
    // Mutation target (P3-1): removing the ROLLBACK TO SAVEPOINT call would leave the shared
    // transaction aborted for every subsequent read sharing this connection (the sibling ⑥
    // orgRecipientBinding read, in production) — assert it was actually issued, using the SAME
    // savepoint name SAVEPOINT itself opened.
    expect(queryMock).toHaveBeenCalledTimes(3)
    const savepointName = (queryMock.mock.calls[0] as [string])[0].replace(/^SAVEPOINT /, '')
    expect((queryMock.mock.calls[2] as [string])[0]).toBe(`ROLLBACK TO SAVEPOINT ${savepointName}`)
  })

  it('cannot even open a SAVEPOINT (shared transaction already aborted upstream) ⇒ unknown, no further query attempted', async () => {
    queryMock.mockRejectedValueOnce(new Error('current transaction is aborted'))
    expect(await readAttendancePunchPolicyPosture(queryMock as never)).toBe('unknown')
    // Fail-closed immediately — no SELECT, no ROLLBACK TO SAVEPOINT attempt against a connection
    // that cannot even take a savepoint.
    expect(queryMock).toHaveBeenCalledTimes(1)
  })
})

/** Locates the literal body text of `const DEFAULT_SETTINGS = { ... }` in the live plugin source —
 *  shared by both the key-NAME (existing) and key-VALUE (P3-2, #4541 review) reconciliation tests
 *  below, via brace-depth counting (handles arbitrarily nested objects/arrays inside the block). */
function readDefaultSettingsBlock(): string {
  const pluginPath = path.resolve(__dirname, '../../../../plugins/plugin-attendance/index.cjs')
  const source = readFileSync(pluginPath, 'utf8')
  const startIdx = source.indexOf('const DEFAULT_SETTINGS = {')
  if (startIdx < 0) throw new Error('DEFAULT_SETTINGS not found in plugin source')
  const blockStart = source.indexOf('{', startIdx)
  let depth = 0
  let endIdx = -1
  for (let i = blockStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        endIdx = i
        break
      }
    }
  }
  if (endIdx <= blockStart) throw new Error('could not find the matching closing brace for DEFAULT_SETTINGS')
  return source.slice(blockStart + 1, endIdx)
}

describe('§9 W4-0-G5: closed-set reconciliation against the LIVE plugin source text', () => {
  it('IN ∪ OUT equals every DEFAULT_SETTINGS top-level key in plugins/plugin-attendance/index.cjs', () => {
    const block = readDefaultSettingsBlock()
    const liveKeys = new Set<string>()
    // Top-level keys are 2-space-indented `key:` lines (object or scalar values alike).
    for (const line of block.split('\n')) {
      const m = /^  ([a-zA-Z][a-zA-Z0-9]*):/.exec(line)
      if (m) liveKeys.add(m[1])
    }
    expect(liveKeys.size).toBeGreaterThan(0)
    const classified = new Set([...ATTENDANCE_PUNCH_POLICY_CLOSED_SET_KEYS_IN, ...ATTENDANCE_PUNCH_POLICY_CLOSED_SET_KEYS_OUT])
    // Mutation target ③: adding a new DEFAULT_SETTINGS key without classifying it here reds this.
    expect([...liveKeys].sort()).toEqual([...classified].sort())
    // No key double-classified.
    expect(ATTENDANCE_PUNCH_POLICY_CLOSED_SET_KEYS_IN.length + ATTENDANCE_PUNCH_POLICY_CLOSED_SET_KEYS_OUT.length).toBe(
      classified.size,
    )
  })

  it('the closed-set IN list is exactly the §3.1 four keys', () => {
    expect([...ATTENDANCE_PUNCH_POLICY_CLOSED_SET_KEYS_IN].sort()).toEqual(
      ['geoFence', 'ipAllowlist', 'minPunchIntervalMinutes', 'punchPolicy'].sort(),
    )
  })

  // P3-2 (#4541 review): the key-NAME reconciliation above only proves every DEFAULT_SETTINGS key is
  // classified IN/OUT of the closed set — it says nothing about whether `ATTENDANCE_PUNCH_POLICY_
  // CLOSED_SET_DEFAULT` (the independently-pinned VALUE mirror `readAttendancePunchPolicyPosture`
  // actually compares against) still matches the plugin's own literal VALUES for those four IN keys.
  // This test closes that gap: it parses the LIVE plugin source text for each IN key's own literal
  // value and deep-diffs it against the mirror, so a value-only drift on EITHER side (the plugin's
  // default changes, or the mirror is edited without following) reds here even though the key-NAME
  // test above stays green.
  it('the closed-set default MIRROR matches the LIVE plugin literal values, key-by-key (P3-2)', () => {
    const block = readDefaultSettingsBlock()

    // Extract the literal source text for one top-level `key: <value>,` entry inside `block`, using
    // the SAME brace/bracket-depth-counting technique as `readDefaultSettingsBlock` above
    // (generalized to stop at a depth-0 comma, or the block's end) — never a hand-rolled
    // per-shape regex, so a nested object/array inside the value is handled uniformly.
    function extractValueSource(key: string): string {
      const marker = new RegExp(`\\n  ${key}:\\s*`)
      const m = marker.exec(block)
      if (!m) throw new Error(`key not found in DEFAULT_SETTINGS: ${key}`)
      const start = m.index + m[0].length
      let d = 0
      let end = block.length
      for (let i = start; i < block.length; i++) {
        const ch = block[i]
        if (ch === '{' || ch === '[') d++
        else if (ch === '}' || ch === ']') d--
        else if (ch === ',' && d === 0) {
          end = i
          break
        }
      }
      return block.slice(start, end).trim()
    }

    // Evaluated as a JS literal (not JSON.parse) because the source uses single-quoted strings
    // (e.g. `mode: 'allow'`) — this reads a literal out of THIS repo's own static source file (not
    // untrusted input), the standard idiom for "parse a value straight out of source text" that a
    // JSON-only parser cannot handle.
    function evalLiteral(src: string): unknown {
      // eslint-disable-next-line no-new-func
      return new Function(`"use strict"; return (${src});`)()
    }

    const liveClosedSetDefault = {
      punchPolicy: evalLiteral(extractValueSource('punchPolicy')),
      ipAllowlist: evalLiteral(extractValueSource('ipAllowlist')),
      geoFence: evalLiteral(extractValueSource('geoFence')),
      minPunchIntervalMinutes: evalLiteral(extractValueSource('minPunchIntervalMinutes')),
    }

    // Mutation target (P3-2): a change to EITHER side (the plugin's own DEFAULT_SETTINGS literal, or
    // ATTENDANCE_PUNCH_POLICY_CLOSED_SET_DEFAULT) without updating the other reds this — e.g.
    // minPunchIntervalMinutes silently drifting from 1 to some other value on only one side.
    expect(liveClosedSetDefault).toEqual(ATTENDANCE_PUNCH_POLICY_CLOSED_SET_DEFAULT)
  })
})

// §4.5 names three contract-test requirements: (1) zero env-value/credential leakage — covered by
// the route test's `JSON.stringify(data)).not.toMatch(/ATTENDANCE_[A-Z_]/)` assertion below; (2)
// "缺 port 时聚合端点仍 200 且 notify={deliveryRuntime:'unknown',…}" (missing port ⇒ still 200,
// fail-closed to unknown); (3) "不得由 deliveries 表推断" — covered by the SQL-shape assertions
// below (the query never touches `attendance_notification_deliveries`) and the real-DB G4 describe.
// Requirement (2) is explicitly N/A-BY-CONSTRUCTION for this slice, not silently skipped: this
// module has exactly one production import path for the scheduler port
// (`import { getSharedAttendanceScheduler } from './AttendanceScheduler'` at the top of
// `AttendanceSetupReadinessAggregate.ts`) with no conditional/optional wiring — there is no runtime
// state in which that import resolves but the function is "missing", so a test simulating a missing
// port would have nothing to exercise beyond re-asserting the null-check branch already covered by
// "deliveryRuntime = not_ready when the scheduler is not started (null)" below. If a future slice
// ever makes the port pluggable/optional, this comment is the marker to add the real test then.
describe('§4.5 notify readiness (⑥ three independent signals, §9 W4-0-G4)', () => {
  beforeEach(() => {
    queryMock.mockReset()
    getSharedAttendanceSchedulerMock.mockReset()
  })

  it('deliveryRuntime = not_ready when the scheduler is not started (null)', () => {
    getSharedAttendanceSchedulerMock.mockReturnValue(null)
    expect(computeAttendanceSetupReadinessDeliveryRuntime()).toBe('not_ready')
  })

  it('deliveryRuntime = unknown (never ready) when the scheduler IS started', () => {
    getSharedAttendanceSchedulerMock.mockReturnValue({ started: true })
    expect(computeAttendanceSetupReadinessDeliveryRuntime()).toBe('unknown')
  })

  it('deliveryRuntime does not read ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED at all', () => {
    const original = process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED
    process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED = 'true'
    getSharedAttendanceSchedulerMock.mockReturnValue(null)
    try {
      // Mutation target ④: reading the env var here (worker-enabled-but-scheduler-down ⇒ 'ready')
      // would flip this to something other than 'not_ready'.
      expect(computeAttendanceSetupReadinessDeliveryRuntime()).toBe('not_ready')
    } finally {
      if (original === undefined) delete process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED
      else process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED = original
    }
  })

  it('orgRecipientBinding: org-scoped join covering BOTH wired channels (dingtalk+wecom, §4.5(ii) "企微同型"), boundRecipientCount/hasAnyBoundRecipient only', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ bound_recipient_count: 2 }] })
    const result = await readAttendanceSetupReadinessOrgRecipientBinding('org-a', queryMock as never)
    expect(result).toEqual({ boundRecipientCount: 2, hasAnyBoundRecipient: true })
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/i\.org_id\s*=\s*\$1/)
    // Mutation target: pinning either leg back to a single literal 'dingtalk' (dropping wecom
    // coverage, or letting a.provider/i.provider mismatch) reds this.
    expect(sql).toMatch(/provider\s+IN\s*\(\s*'dingtalk'\s*,\s*'wecom'\s*\)/)
    expect(sql).toMatch(/i\.provider\s*=\s*a\.provider/)
    expect(sql).toMatch(/link_status\s*=\s*'linked'/)
    // Mutation target: dropping either guard lets a NULL-local_user_id link or a duplicate binding
    // for the same local user inflate the count.
    expect(sql).toMatch(/local_user_id\s+IS\s+NOT\s+NULL/)
    expect(sql).toMatch(/COUNT\(\s*DISTINCT\s+l\.local_user_id\s*\)/)
    expect(params).toEqual(['org-a'])
    expect(sql).not.toMatch(/external_user_id|name|email/i)
  })

  it('orgRecipientBinding: zero rows ⇒ hasAnyBoundRecipient=false', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ bound_recipient_count: 0 }] })
    const result = await readAttendanceSetupReadinessOrgRecipientBinding('org-a', queryMock as never)
    expect(result).toEqual({ boundRecipientCount: 0, hasAnyBoundRecipient: false })
  })
})

describe('runAttendanceSetupReadinessReadOnly (structural wiring — real rejection proof is the .db.test.ts)', () => {
  it('issues SET TRANSACTION READ ONLY as the FIRST statement inside the transaction', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] })
    const runTransaction = vi.fn(async (handler: (c: { query: typeof clientQuery }) => Promise<unknown>) =>
      handler({ query: clientQuery }),
    )
    await runAttendanceSetupReadinessReadOnly(async () => 'done', runTransaction as never)
    expect(clientQuery.mock.calls[0]?.[0]).toBe('SET TRANSACTION READ ONLY')
  })

  it('propagates the transaction result', async () => {
    const runTransaction = vi.fn(async (handler: (c: { query: () => Promise<{ rows: unknown[] }> }) => Promise<unknown>) =>
      handler({ query: async () => ({ rows: [] }) }),
    )
    const result = await runAttendanceSetupReadinessReadOnly(async () => ({ ok: true }), runTransaction as never)
    expect(result).toEqual({ ok: true })
  })
})

/** Strips block comments, line comments, and string literals so a source-scan regex only ever
 *  inspects live CODE — never this very test file's own docblocks (which quote the banned pattern
 *  BY NAME, in prose, precisely to explain why it is banned) or an unrelated string constant. */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

describe('§9 W4-0-G2 negative meta-assertion: no first-word/regex read-only check anywhere', () => {
  it('the aggregate module contains no prefix/regex "is this SQL a SELECT" guard (code only, comments/strings stripped)', () => {
    const modulePath = path.resolve(__dirname, '../../src/services/AttendanceSetupReadinessAggregate.ts')
    const code = stripCommentsAndStrings(readFileSync(modulePath, 'utf8'))
    // Mutation target: re-introducing a `.startsWith('SELECT'` / `.toUpperCase().startsWith(` /
    // `/^SELECT/`-shaped guard anywhere in this file's CODE must red this test — the design lock
    // names this pattern as the exact thing killed in review (a frozen predecessor's
    // `assertSelectOnlyReadinessSql`), and forbids re-introducing it.
    expect(code).not.toMatch(/\.startsWith\(/)
    expect(code).not.toMatch(/toUpperCase\(\)/)
  })

  it('the route file contains no prefix/regex "is this SQL a SELECT" guard either (code only)', () => {
    const routePath = path.resolve(__dirname, '../../src/routes/attendance-admin.ts')
    const code = stripCommentsAndStrings(readFileSync(routePath, 'utf8'))
    // As strong as the aggregate-module leg above (not just the stripped-template-literal-arg
    // shape): a re-introduced `sql.trim().toUpperCase().startsWith('SELECT')`-style guard using a
    // quoted string literal (not a template literal) or any `.startsWith(` call at all — plus the
    // three named helper functions the frozen predecessor used — must all red this test. The route
    // file is production "implementation" exactly as much as the aggregate module (§9 W4-0-G2's ban
    // covers "the implementation", not one file within it) and today's stripped code has zero
    // legitimate `.startsWith(`/`toUpperCase()` occurrences, so there is no false-positive risk.
    expect(code).not.toMatch(/\.startsWith\(/)
    expect(code).not.toMatch(/toUpperCase\(\)/)
    expect(code).not.toMatch(/isSelectOnly|assertSelectOnly|isReadOnlySql/i)
  })
})

describe('GET /api/attendance-admin/setup-readiness (route)', () => {
  beforeEach(() => {
    queryMock.mockReset()
    transactionMock.mockReset()
    getSharedAttendanceSchedulerMock.mockReset()
    getSharedAttendanceSchedulerMock.mockReturnValue(null)
  })

  it('400 when orgId is missing', async () => {
    const app = makeApp({ id: 'delegated-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/setup-readiness')
    expect(res.status).toBe(400)
    expect(res.body?.error?.code).toBe('ORG_ID_REQUIRED')
  })

  it('401 when unauthenticated', async () => {
    const app = makeApp(null)
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/setup-readiness?orgId=org-a')
    expect(res.status).toBe(401)
  })

  it('403 for a foreign-org delegated admin — and issues ZERO aggregation (transaction never opened)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // user_orgs membership check: not a member
    const app = makeApp({ id: 'foreign-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/setup-readiness?orgId=org-b')
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('FORBIDDEN')
    // Mutation target ①: moving the aggregation call before the authz check makes this fail.
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('200 for an org member, with the §4.2-locked 13-key set EXACTLY, and a values-free payload', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // user_orgs membership: member
    mockTransactionQueries({
      directoryLinked: { rows: [{ ready: true }] },
      orgCounts: { rows: [OK_COUNTS_ROW] },
      punchPolicy: { rows: [] }, // no row => default
      orgRecipientBinding: { rows: [{ bound_recipient_count: 0 }] },
    })
    const app = makeApp({ id: 'delegated-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/setup-readiness?orgId=org-a')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const data = res.body.data
    // §4.2-locked 13 keys, verbatim — EXACT, not a subset/superset. Mutation target (P2, #4541
    // review): a prior revision carried a 14th `viewerIsPlatformAdmin` key the pure discriminator
    // module never consumed; re-adding ANY 14th key here (that one or another) reds this.
    expect(Object.keys(data).sort()).toEqual(
      [
        'directoryLinked',
        'orgActiveMemberCount',
        'groupCount',
        'groupsWithMembers',
        'shiftCount',
        'scheduledShiftGroupCount',
        'activeRotationRuleCount',
        'hasRotationRules',
        'approvalFlowCount',
        'punchPolicyPosture',
        'notify',
        'previewReady',
        'perStep',
      ].sort(),
    )
    expect(Object.keys(data.notify).sort()).toEqual(['deliveryRuntime', 'orgRecipientBinding', 'recipientScopeConfig'].sort())
    expect(Object.keys(data.notify.orgRecipientBinding).sort()).toEqual(['boundRecipientCount', 'hasAnyBoundRecipient'].sort())
    expect(data.notify.recipientScopeConfig).toBe('unsupported')
    expect(data.punchPolicyPosture).toBe('default')
    expect(data.previewReady).toBe(true) // OK_COUNTS_ROW satisfies ①②③⑤
    expect(Object.keys(data.perStep).sort()).toEqual([...ATTENDANCE_SETUP_STEP_IDS].sort())
    // §4.2 `perStep.effectiveTime: {source, posture, effectiveAt?}` — each perStep ENTRY nests
    // under an `effectiveTime` key (not a flat {source,posture} record); mutation target: flattening
    // this back out reds every assertion in this loop.
    for (const stepId of ATTENDANCE_SETUP_STEP_IDS) {
      const entry = data.perStep[stepId]
      expect(Object.keys(entry)).toEqual(['effectiveTime'])
      expect(entry.effectiveTime).toHaveProperty('source')
      expect(entry.effectiveTime).toHaveProperty('posture')
    }
    // Values-free: no raw env-var NAMES (uppercase-with-underscore, e.g. the notify env flags) or
    // credentials anywhere. (perStep[*].effectiveTime.source table-name identifiers like
    // "attendance_groups" are the sanctioned §4.2 contract, not an env leak — hence the
    // uppercase-only pattern here.)
    expect(JSON.stringify(data)).not.toMatch(/ATTENDANCE_[A-Z_]/)
    expect(JSON.stringify(data)).not.toMatch(/password|secret|token/i)
  })

  it('platform-admin bypass (single-column-labeled — NOT a substitute for the membership case): orgId=org-b (foreign) ⇒ 200, zero user_orgs query', async () => {
    // No user_orgs query at all: the platform-admin shortcut in canReadAttendanceDirectoryReadiness
    // returns true before ever touching user_orgs (attendance-admin.ts, hasLegacyAdminClaim/isRbacAdmin).
    mockTransactionQueries({
      directoryLinked: { rows: [{ ready: false }] },
      orgCounts: { rows: [OK_COUNTS_ROW] },
      punchPolicy: { rows: [] },
      orgRecipientBinding: { rows: [{ bound_recipient_count: 0 }] },
    })
    const app = makeApp({ id: 'platform-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/setup-readiness?orgId=org-b')
    expect(res.status).toBe(200)
    // This 200 for a foreign org is the DESIGNED bypass, not proof of the org-membership door — the
    // membership-door proof is case 2 above (403) and the real-DB two-org matrix (G1).
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('503 DB_NOT_READY when the schema is not ready', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    transactionMock.mockImplementationOnce(async () => {
      const err = new Error('relation "attendance_groups" does not exist') as Error & { code?: string }
      err.code = '42P01'
      throw err
    })
    const app = makeApp({ id: 'delegated-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/setup-readiness?orgId=org-a')
    expect(res.status).toBe(503)
    expect(res.body?.error?.code).toBe('DB_NOT_READY')
  })

  it('500 returns a generic message — never raw DB/driver text (values-free)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    transactionMock.mockRejectedValueOnce(new Error('SECRET_DETAIL leak boom'))
    const app = makeApp({ id: 'delegated-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/setup-readiness?orgId=org-a')
    expect(res.status).toBe(500)
    expect(res.body?.error?.code).toBe('SETUP_READINESS_FAILED')
    expect(JSON.stringify(res.body)).not.toContain('SECRET_DETAIL')
  })

  it('§9 W4-0-G4 echo: deliveryRuntime=not_ready with worker-env=true but scheduler down (route-level)', async () => {
    const original = process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED
    process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED = 'true'
    getSharedAttendanceSchedulerMock.mockReturnValue(null)
    try {
      queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      mockTransactionQueries({
        directoryLinked: { rows: [{ ready: false }] },
        orgCounts: { rows: [OK_COUNTS_ROW] },
        punchPolicy: { rows: [] },
        orgRecipientBinding: { rows: [{ bound_recipient_count: 0 }] },
      })
      const app = makeApp({ id: 'delegated-admin' })
      pinned.setApp(app)
      const res = await request(pinned.url()).get('/api/attendance-admin/setup-readiness?orgId=org-a')
      expect(res.body.data.notify.deliveryRuntime).toBe('not_ready')
      expect(res.body.data.previewReady).toBe(true) // unaffected by notify (§3.2)
    } finally {
      if (original === undefined) delete process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED
      else process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED = original
    }
  })

  it('§4.2 deployment-scoped field registry matches the design lock text exactly', () => {
    expect([...ATTENDANCE_SETUP_READINESS_DEPLOYMENT_SCOPED_FIELDS].sort()).toEqual(
      ['punchPolicyPosture', 'notify.deliveryRuntime', 'notify.recipientScopeConfig'].sort(),
    )
  })
})
