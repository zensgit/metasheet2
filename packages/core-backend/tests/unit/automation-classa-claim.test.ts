/**
 * #4196 Class-A same-transaction idempotency claim — executor wiring (unit).
 *
 * Proves the claim-then-skip-on-duplicate contract for the four Class-A actions
 * (update/create/delete/lock_record) with a MOCKED transaction that records claims and controls their
 * outcome. This is the fast local proof; the real-DB crash-injection golden
 * (`tests/integration/multitable-4196-classa-claim-realdb.test.ts`) proves the same against a real schema.
 *
 * The mock's `deps.transaction` routes the callback's `query` through `handleSql`, which:
 *   - answers the `pg_current_xact_id()` probe with a STABLE xid (models one ongoing transaction, so the
 *     ledger's `assertInTransaction` guard passes — exactly as a real pg transaction would);
 *   - answers the ledger claim INSERT with a controllable rowCount (1 = 'claimed', 0 = 'duplicate');
 *   - counts the ACTUAL record mutation (UPDATE/INSERT/DELETE meta_records) — the write spy.
 *
 * When `deps.transaction` is present the claim gate is active iff the runtime flag is ON; with the flag OFF
 * the Class-A path must be byte-identical to baseline (no claim, one mutation) — asserted below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AutomationExecutor,
  type ActionJobLifecycle,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { deriveActionKey } from '../../src/multitable/automation-action-idempotency'
import { EventBus } from '../../src/integration/events/event-bus'

const FLAG = 'AUTOMATION_CLASSA_CLAIM_ENABLED'
const STABLE_XID = '424242'

interface MockState {
  claimParams: unknown[][] // params array of every ledger-claim INSERT (kind, root, action_key, action_type)
  recordMutations: number // real meta_records UPDATE/INSERT/DELETE — the write spy
  revisionInserts: number
  probeCalls: number
  /** 1 → the claim is WON ('claimed'); 0 → a prior apply holds it ('duplicate'). */
  claimRowCount: number
}

function makeState(): MockState {
  return { claimParams: [], recordMutations: 0, revisionInserts: 0, probeCalls: 0, claimRowCount: 1 }
}

function makeHandleSql(state: MockState) {
  return async (sql: unknown, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    const s = String(sql)
    if (/pg_current_xact_id/i.test(s)) {
      state.probeCalls++
      return { rows: [{ xid: STABLE_XID }], rowCount: 1 }
    }
    if (/meta_automation_action_applied/i.test(s)) {
      state.claimParams.push(params ?? [])
      return { rows: [], rowCount: state.claimRowCount } // 1 = claimed, 0 = duplicate
    }
    if (/meta_record_revisions/i.test(s)) {
      state.revisionInserts++
      return { rows: [], rowCount: 1 }
    }
    if (/UPDATE\s+meta_records|INSERT\s+INTO\s+meta_records|DELETE\s+FROM\s+meta_records/i.test(s)) {
      state.recordMutations++
      // UPDATE ... RETURNING version, data → give the revision path a row to work from.
      return { rows: [{ version: 2, data: {} }], rowCount: 1 }
    }
    if (/SELECT[\s\S]*FROM\s+meta_records/i.test(s)) {
      // lock-check SELECT — an unlocked, existing row so update/delete proceed.
      return { rows: [{ locked: false, locked_by: null, created_by: 'user_1', version: 1, data: {} }], rowCount: 1 }
    }
    if (/FROM\s+meta_fields/i.test(s)) return { rows: [], rowCount: 0 } // rich-longtext sanitize: no longText fields
    return { rows: [], rowCount: 1 }
  }
}

/** deps with BOTH queryFn (autocommit helpers) and a transaction that routes through the same handler. */
function makeDeps(state: MockState): AutomationDeps {
  const handle = makeHandleSql(state)
  return {
    eventBus: new EventBus(),
    queryFn: vi.fn(handle),
    transaction: vi.fn(async (handler) => handler({ query: vi.fn(handle) })),
  }
}

/** deps WITHOUT a transaction (autocommit fallback) — the legacy shape the gate's (b) condition excludes. */
function makeAutocommitDeps(state: MockState): AutomationDeps {
  const handle = makeHandleSql(state)
  return { eventBus: new EventBus(), queryFn: vi.fn(handle) }
}

function ruleWith(action: { type: string; config: Record<string, unknown> }, overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule_ca',
    name: 'Class-A rule',
    sheetId: 'sheet_1',
    trigger: { type: 'record.created', config: {} },
    actions: [action as never],
    enabled: true,
    createdBy: 'user_1',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as AutomationRule
}

const TRIGGER = { recordId: 'rec_1', sheetId: 'sheet_1', actorId: 'user_1', data: {} }

beforeEach(() => {
  delete process.env[FLAG]
})
afterEach(() => {
  delete process.env[FLAG]
  vi.restoreAllMocks()
})

describe('#4196 Class-A claim — flag ON, first run claims and mutates once', () => {
  for (const action of [
    { type: 'update_record', config: { fields: { status: 'done' } } },
    { type: 'create_record', config: { sheetId: 'sheet_1', data: { title: 'x' } } },
    { type: 'delete_record', config: {} },
    { type: 'lock_record', config: { locked: true } },
  ]) {
    it(`${action.type}: claim WON → one mutation, one ledger claim keyed on the top-level step-key + own execution id`, async () => {
      process.env[FLAG] = 'true'
      const state = makeState()
      state.claimRowCount = 1 // claimed
      const exec = await new AutomationExecutor(makeDeps(state)).execute(ruleWith(action), TRIGGER)

      expect(exec.steps[0]?.status).toBe('success')
      expect(exec.steps[0]?.alreadyApplied).toBeUndefined()
      expect(state.recordMutations).toBe(1) // the write ran exactly once
      expect(state.claimParams).toHaveLength(1)

      // The claim rode a real (mocked) transaction: assertInTransaction probed pg_current_xact_id twice.
      expect(state.probeCalls).toBeGreaterThanOrEqual(2)

      // Identity: kind='execution', root = this execution's own id (no parent), action_key = §2.1 triple
      // over the SAME top-level step-key ('0') the fingerprint/job plane uses.
      const [kind, root, actionKey, actionType] = state.claimParams[0] as [string, string, string, string]
      expect(kind).toBe('execution')
      expect(root).toBe(exec.id)
      expect(actionType).toBe(action.type)
      expect(actionKey).toBe(
        deriveActionKey({ structuralPath: '0', actionType: action.type, canonicalConfig: action.config }),
      )
    })
  }
})

describe('#4196 Class-A claim — flag ON, replay (duplicate) skips the mutation entirely', () => {
  for (const action of [
    { type: 'update_record', config: { fields: { status: 'done' } } },
    { type: 'create_record', config: { sheetId: 'sheet_1', data: { title: 'x' } } },
    { type: 'delete_record', config: {} },
    { type: 'lock_record', config: { locked: true } },
  ]) {
    it(`${action.type}: claim DUPLICATE → NO mutation, NO revision, step marked alreadyApplied`, async () => {
      process.env[FLAG] = 'true'
      const state = makeState()
      state.claimRowCount = 0 // duplicate — a prior apply already holds the claim
      const exec = await new AutomationExecutor(makeDeps(state)).execute(ruleWith(action), TRIGGER)

      expect(exec.status).toBe('success')
      expect(exec.steps[0]?.status).toBe('success') // still a success so the execution proceeds
      expect(exec.steps[0]?.alreadyApplied).toBe(true) // …but distinguishably a skip
      expect(state.claimParams).toHaveLength(1) // the claim was attempted
      expect(state.recordMutations).toBe(0) // the mutation was NOT run — zero second effect
      expect(state.revisionInserts).toBe(0) // and no revision was fabricated
    })
  }
})

describe('#4196 Class-A claim — flag OFF is byte-identical to baseline (no claim)', () => {
  for (const action of [
    { type: 'update_record', config: { fields: { status: 'done' } } },
    { type: 'create_record', config: { sheetId: 'sheet_1', data: { title: 'x' } } },
    { type: 'delete_record', config: {} },
    { type: 'lock_record', config: { locked: true } },
  ]) {
    it(`${action.type}: flag OFF → claim never invoked, mutation runs once, no alreadyApplied marker`, async () => {
      // Flag unset (default OFF). deps.transaction IS present — proving it is the FLAG, not the missing
      // transaction, that keeps the claim dormant here.
      const state = makeState()
      const exec = await new AutomationExecutor(makeDeps(state)).execute(ruleWith(action), TRIGGER)

      expect(exec.steps[0]?.status).toBe('success')
      expect(exec.steps[0]?.alreadyApplied).toBeUndefined()
      expect(state.claimParams).toHaveLength(0) // NO claim INSERT ever ran
      expect(state.probeCalls).toBe(0) // NO xid probe ran
      expect(state.recordMutations).toBe(1) // the write ran exactly once, as before this slice
    })
  }
})

describe('#4196 Class-A claim — gate condition (b): no claim on the autocommit fallback even with flag ON', () => {
  it('flag ON but deps.transaction ABSENT → claim never invoked (would throw in assertInTransaction otherwise)', async () => {
    process.env[FLAG] = 'true'
    const state = makeState()
    const exec = await new AutomationExecutor(makeAutocommitDeps(state)).execute(
      ruleWith({ type: 'update_record', config: { fields: { status: 'done' } } }),
      TRIGGER,
    )
    // The autocommit path must be untouched: the mutation runs, but the claim (and its xid probe, which
    // would throw here) never runs — so the legacy/test path is preserved.
    expect(exec.steps[0]?.status).toBe('success')
    expect(exec.steps[0]?.alreadyApplied).toBeUndefined()
    expect(state.claimParams).toHaveLength(0)
    expect(state.probeCalls).toBe(0)
    expect(state.recordMutations).toBe(1)
  })
})

describe('#4196 Class-A claim — retry lineage root threads into the claim key', () => {
  it('execute(rule, event, factory, rootExecutionId) → claim keys on the PASSED root, not the new execution id', async () => {
    process.env[FLAG] = 'true'
    const state = makeState()
    const exec = await new AutomationExecutor(makeDeps(state)).execute(
      ruleWith({ type: 'update_record', config: { fields: { status: 'done' } } }),
      TRIGGER,
      undefined,
      'axe_original_root', // a retry threads the ORIGINAL execution's root
    )
    expect(exec.id).not.toBe('axe_original_root') // a fresh execution id…
    const [, root] = state.claimParams[0] as [string, string]
    expect(root).toBe('axe_original_root') // …but the claim keys on the lineage root
  })
})

describe('#4196 Class-A claim — nested branch child claims on the BRANCH step-key identity', () => {
  function noopLifecycle(): ActionJobLifecycle {
    return {
      onExecutionStarted: vi.fn(async () => {}),
      onStart: vi.fn(async () => {}),
      onSettled: vi.fn(async () => {}),
      onSkipped: vi.fn(async () => {}),
    }
  }

  const parallelRule = () =>
    ruleWith(
      {
        type: 'parallel_branch',
        config: {
          joinMode: 'all',
          branches: [
            { key: 'b1', actions: [{ type: 'update_record', config: { fields: { status: 'branch-done' } } }] },
          ],
        },
      },
      { executionMode: 'workflow_job_v1' },
    )

  const CHILD_KEY = deriveActionKey({
    structuralPath: '0.parallel.b1.0',
    actionType: 'update_record',
    canonicalConfig: { fields: { status: 'branch-done' } },
  })

  it('first run → branch child claims once on `0.parallel.b1.0`, mutation runs once', async () => {
    process.env[FLAG] = 'true'
    const state = makeState()
    state.claimRowCount = 1
    await new AutomationExecutor(makeDeps(state)).execute(parallelRule(), TRIGGER, () => noopLifecycle())

    expect(state.claimParams).toHaveLength(1)
    expect((state.claimParams[0] as string[])[2]).toBe(CHILD_KEY) // the BRANCH step-key identity flowed through
    expect(state.recordMutations).toBe(1)
  })

  it('replay (duplicate) → branch child mutation skipped', async () => {
    process.env[FLAG] = 'true'
    const state = makeState()
    state.claimRowCount = 0 // duplicate
    await new AutomationExecutor(makeDeps(state)).execute(parallelRule(), TRIGGER, () => noopLifecycle())

    expect(state.claimParams).toHaveLength(1)
    expect((state.claimParams[0] as string[])[2]).toBe(CHILD_KEY)
    expect(state.recordMutations).toBe(0) // the branch-child write did NOT run on replay
  })
})
