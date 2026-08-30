/**
 * MetaSheet bulk item-property grid — client state-machine spec.
 *
 * Taskbook: docs/development/DEVELOPMENT_TASK_METASHEET_BULK_GRID_CONSUMER_20260829.md
 *
 * These cover the UX half of N2 and §11. The data-destroying invariants (N1 serialization,
 * the authoritative pre-commit revalidation, N3-A refusal) are enforced on the server relay
 * and are tested in packages/core-backend/tests/unit/plm-bulk-import-routes.test.ts — a bug in
 * the composable cannot cause a silent wholesale property delete.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

const mocks = vi.hoisted(() => ({
  getPlmBulkGridSchema: vi.fn(),
  dryRunPlmBulkGrid: vi.fn(),
  commitPlmBulkGrid: vi.fn(),
}))

// Stubbed so the SERVICE layer itself can be exercised against a real relay response below
// (`§11 — the service layer must carry `stage`'), not only the composable against a stubbed one.
const apiMocks = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('../src/utils/api', () => apiMocks)

// Only the three NETWORK calls are stubbed. `indexBulkGridRowErrors` is deliberately the REAL
// implementation: it is the one shared row-error indexer, and re-stubbing it here would let the
// composable and the service layer drift apart again -- the composable used to carry its own
// second copy, which is exactly what this arrangement prevents.
vi.mock('../src/services/integration/workbench', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/integration/workbench')>()
  return { ...actual, ...mocks }
})

import { usePlmBulkGrid } from '../src/composables/usePlmBulkGrid'

const PROPERTIES = [
  { name: 'item_number', required: true },
  { name: 'name', required: true },
  { name: 'cost_center', required: false },
]

/**
 * N3-A: the relay establishes no match-property uniqueness, so it advertises NO candidates and
 * the grid is create-only. Fixtures mirror that rather than the declared column list.
 */
const SCHEMA_OK = {
  ok: true as const,
  properties: PROPERTIES,
  declaredColumns: PROPERTIES.map((p) => p.name),
  matchPropertyCandidates: [] as string[],
  matchPropertyReason: 'match-property-uniqueness-unestablished',
  commitEnabled: true,
}

let keyCounter = 0
const clock = { value: 1_000_000 }

function makeGrid(overrides: Record<string, unknown> = {}) {
  return usePlmBulkGrid({
    dataSourceId: ref('ds-1'),
    itemTypeId: ref('Part'),
    callerPlmToken: ref('caller-token'),
    now: () => clock.value,
    mintKey: () => `key-${++keyCounter}`,
    ...overrides,
  })
}

const READY = { ready: true, row_errors: [], would_create: 1, would_update: 0 }
const REJECTED = {
  ready: false,
  row_errors: [{ row_number: 1, property_name: 'name', error_code: 'MISSING_REQUIRED_VALUE', message: 'required' }],
}

beforeEach(() => {
  keyCounter = 0
  clock.value = 1_000_000
  mocks.getPlmBulkGridSchema.mockReset().mockResolvedValue({ ...SCHEMA_OK })
  mocks.dryRunPlmBulkGrid.mockReset().mockResolvedValue({ ok: true, report: READY })
  mocks.commitPlmBulkGrid.mockReset().mockResolvedValue({ ok: true, report: READY, mustReload: true })
})

describe('load', () => {
  it('exposes the FULL declared column set from PLM', async () => {
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])

    expect(grid.declaredColumns.value).toEqual(['item_number', 'name', 'cost_center'])
    expect(grid.commitEnabled.value).toBe(true)
  })

  it('surfaces a schema failure without leaving a half-loaded grid', async () => {
    mocks.getPlmBulkGridSchema.mockResolvedValue({ ok: false, status: 403, reason: 'not-entitled', message: '未授权' })
    const grid = makeGrid()
    const ok = await grid.load([{}])

    expect(ok).toBe(false)
    expect(grid.errorMessage.value).toBe('未授权')
    expect(grid.declaredColumns.value).toEqual([])
  })
})

describe('§3 — branch on `ready`, never on the status code', () => {
  it('a 200 carrying ready:false is NOT a success', async () => {
    mocks.dryRunPlmBulkGrid.mockResolvedValue({ ok: true, report: REJECTED })
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])

    expect(await grid.dryRun()).toBe(false)
    expect(grid.isReady.value).toBe(false)
    expect(grid.canSubmit.value).toBe(false)
  })

  it('paints row_errors onto the right 1-based row and cell', async () => {
    mocks.dryRunPlmBulkGrid.mockResolvedValue({
      ok: true,
      report: {
        ready: false,
        row_errors: [
          { row_number: 2, property_name: 'name', error_code: 'MISSING_REQUIRED_VALUE', message: 'required' },
          { row_number: 2, property_name: 'cost_center', error_code: 'LENGTH_EXCEEDED', message: 'too long' },
        ],
      },
    })
    const grid = makeGrid()
    await grid.load([{ item_number: 'A' }, { item_number: 'B' }])
    await grid.dryRun()

    // row_number 2 -> zero-based index 1
    expect(grid.errorsForRow(0)).toHaveLength(0)
    expect(grid.errorsForRow(1)).toHaveLength(2)
    expect(grid.errorsForCell(1, 'name')).toHaveLength(1)
    expect(grid.errorsForCell(1, 'item_number')).toHaveLength(0)
  })

  it('renders an unrecognized error_code rather than dropping it (§3.1: the set is open)', async () => {
    mocks.dryRunPlmBulkGrid.mockResolvedValue({
      ok: true,
      report: { ready: false, row_errors: [{ row_number: 1, error_code: 'SOME_FUTURE_CODE', message: 'x' }] },
    })
    const grid = makeGrid()
    await grid.load([{}])
    await grid.dryRun()

    expect(grid.errorsForRow(0)[0].error_code).toBe('SOME_FUTURE_CODE')
  })
})

describe('§11 — a cell edit invalidates the verdict and mints a new key', () => {
  it('drops the ready report and re-mints the key on every edit', async () => {
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    expect(grid.isReady.value).toBe(true)
    const keyBefore = grid.idempotencyKey.value

    grid.updateCell(0, 'name', 'Bracket')

    // Reusing the key after an edit would be a 409 by design; the stale verdict described
    // different bytes and must not authorize a commit.
    expect(grid.idempotencyKey.value).not.toBe(keyBefore)
    expect(grid.report.value).toBeNull()
    expect(grid.canSubmit.value).toBe(false)
  })

  it('re-mints on adding a row too', async () => {
    const grid = makeGrid()
    await grid.load([{}])
    const keyBefore = grid.idempotencyKey.value
    grid.addRow()
    expect(grid.idempotencyKey.value).not.toBe(keyBefore)
  })
})

describe('N2-a — the freshness ritual', () => {
  it('re-runs dry-run immediately before committing', async () => {
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    mocks.dryRunPlmBulkGrid.mockClear()

    await grid.commit()

    expect(mocks.dryRunPlmBulkGrid).toHaveBeenCalledTimes(1)
    expect(mocks.commitPlmBulkGrid).toHaveBeenCalledTimes(1)
  })

  it("a server-side freshness 409 reports 'nothing was committed' and does NOT lock the grid", async () => {
    // The relay's freshness refusal is an HTTP 409 whose body ALSO carries ready:false, so it
    // looks superficially like a reject-all (a 200 + ready:false). Both mean nothing was
    // written, so the operator-visible claim must not diverge: the server's own message is
    // surfaced verbatim rather than the reject-all copy.
    //
    // `stage` is what tells the two apart from a WRITE that failed. The relay's revalidation
    // runs BEFORE the commit and never reaches the provider write, so this is provably clean --
    // and locking a provably-clean refusal would force a reload on a grid that merely needs
    // fixing. Dropping `stage` in the service layer (an earlier revision did) collapsed this
    // case into the ambiguous one.
    mocks.commitPlmBulkGrid.mockResolvedValue({
      ok: false,
      status: 409,
      reason: 'freshness-check-failed',
      stage: 'freshness-dry-run',
      message: '提交前重新校验未通过，未写入任何数据。',
      report: REJECTED,
    })
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    // client pre-check passes, so the server's own freshness check is what refuses
    const result = await grid.commit()

    expect(result).toBeNull()
    expect(grid.errorMessage.value).toContain('未写入任何数据')
    expect(grid.report.value!.ready).toBe(false)
    expect(grid.mustReload.value).toBe(false)
    expect(grid.canRetrySameSubmission.value).toBe(false)
  })

  it('a stale grid caught CLIENT-side stays recoverable (no lock), unlike a server 409', async () => {
    // This asymmetry is the reason the client pre-check exists at all -- see the comment in
    // commit(). Catching it here keeps the grid editable; reaching the server's 409 would not.
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    mocks.dryRunPlmBulkGrid.mockResolvedValue({ ok: true, report: REJECTED })

    expect(await grid.commit()).toBeNull()
    expect(mocks.commitPlmBulkGrid).not.toHaveBeenCalled()
    expect(grid.mustReload.value).toBe(false)
  })

  it('refuses to commit when the pre-commit run is not ready, and writes nothing', async () => {
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    // PLM moved underneath us between the operator's validation and the commit click.
    mocks.dryRunPlmBulkGrid.mockResolvedValue({ ok: true, report: REJECTED })

    expect(await grid.commit()).toBeNull()
    expect(mocks.commitPlmBulkGrid).not.toHaveBeenCalled()
    // Nothing was ATTEMPTED, so the grid is not locked -- the operator can fix and retry.
    expect(grid.mustReload.value).toBe(false)
  })
})

describe('N2-b — no stale resubmission after a failed, partial or ambiguous commit', () => {
  it('locks the grid after a rejected commit and keeps it locked', async () => {
    mocks.commitPlmBulkGrid.mockResolvedValue({
      ok: false, status: 409, reason: 'idempotency_conflict', message: 'reused',
    })
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    await grid.commit()

    expect(grid.mustReload.value).toBe(true)
    expect(grid.canSubmit.value).toBe(false)
    // Re-validating must NOT unlock it: only a real reload can.
    mocks.dryRunPlmBulkGrid.mockResolvedValue({ ok: true, report: READY })
    await grid.dryRun()
    expect(grid.canSubmit.value).toBe(false)
  })

  it('locks the grid when the commit throws (the AMBIGUOUS case — the write may have landed)', async () => {
    mocks.commitPlmBulkGrid.mockRejectedValue(new Error('network down'))
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()

    expect(await grid.commit()).toBeNull()
    expect(grid.mustReload.value).toBe(true)
    expect(grid.canSubmit.value).toBe(false)
  })

  it('locks the grid on a reject-all commit (a 200 that wrote nothing)', async () => {
    mocks.commitPlmBulkGrid.mockResolvedValue({ ok: true, report: REJECTED, mustReload: true })
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    const result = await grid.commit()

    expect(result!.ready).toBe(false)
    // §10 forbids partial retry: fix and resubmit the WHOLE grid after a fresh load.
    expect(grid.mustReload.value).toBe(true)
    expect(grid.canSubmit.value).toBe(false)
  })

  it('a reload is the ONLY thing that unlocks the grid', async () => {
    mocks.commitPlmBulkGrid.mockResolvedValue({ ok: false, status: 502, reason: 'x', message: 'boom' })
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    await grid.commit()
    expect(grid.mustReload.value).toBe(true)

    await grid.load([{ item_number: 'P-001' }])
    expect(grid.mustReload.value).toBe(false)
    // ...but the reload also cleared the verdict, so a fresh validation is still required.
    expect(grid.isReady.value).toBe(false)
    expect(grid.canSubmit.value).toBe(false)
  })
})

describe('N2-c — the local buffer is never treated as PLM state', () => {
  it('marks a successful commit as requiring a re-read', async () => {
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    const result = await grid.commit()

    expect(result!.ready).toBe(true)
    expect(grid.mustReload.value).toBe(true)
  })
})

describe('N2-d — session staleness', () => {
  it('disables commit once the grid has been open past the threshold', async () => {
    const grid = makeGrid({ stalenessMs: 60_000 })
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    expect(grid.canSubmit.value).toBe(true)

    clock.value += 61_000
    // Wall-clock time is not a reactive dependency, so the staleness computed only re-evaluates
    // when something ticks it. The panel does this on an interval; here we tick explicitly.
    grid.refreshStaleness()
    expect(grid.isStale.value).toBe(true)
    expect(grid.canSubmit.value).toBe(false)
  })

  it('commit() refuses a stale grid even if NOTHING ever ticked (the backstop)', async () => {
    // The bug this guards: a `computed` reading Date.now() is cached against its reactive deps,
    // and time is not one. Without the direct re-check in commit(), a grid whose interval never
    // fired -- a background tab, a panel that forgot to tick -- would still commit stale data.
    const grid = makeGrid({ stalenessMs: 60_000 })
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    expect(grid.canSubmit.value).toBe(true)

    clock.value += 61_000
    // Deliberately NO refreshStaleness() call: canSubmit is still stale-cached as true.
    expect(grid.canSubmit.value).toBe(true)

    expect(await grid.commit()).toBeNull()
    expect(mocks.commitPlmBulkGrid).not.toHaveBeenCalled()
    expect(grid.errorMessage.value).toContain('已过期')
  })

  it('a reload restarts the clock', async () => {
    const grid = makeGrid({ stalenessMs: 60_000 })
    await grid.load([{ item_number: 'P-001' }])
    clock.value += 61_000
    grid.refreshStaleness()
    expect(grid.isStale.value).toBe(true)

    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    expect(grid.isStale.value).toBe(false)
    expect(grid.canSubmit.value).toBe(true)
  })
})

describe('maker-checker affordance (client hint only)', () => {
  it('hides commit when the deployment/account does not enable it', async () => {
    mocks.getPlmBulkGridSchema.mockResolvedValue({ ...SCHEMA_OK, commitEnabled: false })
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()

    // The maker loop still works for an engineer -- only the write affordance is withheld.
    expect(grid.isReady.value).toBe(true)
    expect(grid.canSubmit.value).toBe(false)
  })

  it('commit() is a no-op when canSubmit is false (the button is not the only guard)', async () => {
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    // never validated -> not ready
    expect(await grid.commit()).toBeNull()
    expect(mocks.commitPlmBulkGrid).not.toHaveBeenCalled()
  })
})

describe('N3-A — the grid is create-only', () => {
  it('sends no match_property, and surfaces the relay reason for offering none', async () => {
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()

    expect(mocks.dryRunPlmBulkGrid).toHaveBeenCalledWith('ds-1', 'Part', expect.anything(), 'caller-token', undefined)
    expect(grid.matchPropertyCandidates.value).toEqual([])
    expect(grid.matchPropertyReason.value).toBe('match-property-uniqueness-unestablished')
  })

  it('never offers a declared column as a candidate just because it is declared', async () => {
    // The defect this pins: the candidate list is NOT declaredColumns. Deriving it from the
    // column set advertises an update mode whose uniqueness precondition was never checked
    // against the tenant's items -- and PLM's match is a bare .first().
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])

    expect(grid.declaredColumns.value.length).toBeGreaterThan(0)
    expect(grid.matchPropertyCandidates.value).toEqual([])
  })

  it('clears a match property that the relay does not list as a candidate, on reload', async () => {
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    // Whatever set it -- a stale session, a host view, a future candidate list that shrank.
    grid.matchProperty.value = 'item_number'

    await grid.load()
    expect(grid.matchProperty.value).toBe('')
  })

  it('still forwards a match property a caller sets directly — so the relay is seen to refuse it', async () => {
    // The seam stays wired: the refusal is the RELAY's (and tested there). Silently dropping it
    // client-side would turn an intended update into a create, which is the opposite silent
    // damage; the client must let the request through and let it be refused.
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    grid.matchProperty.value = 'item_number'
    await grid.dryRun()

    expect(mocks.dryRunPlmBulkGrid).toHaveBeenCalledWith('ds-1', 'Part', expect.anything(), 'caller-token', 'item_number')
  })
})

/**
 * §11: "On a network failure or timeout with no response: retry with the SAME key. That is the
 * case the key exists for."
 *
 * That sentence was unsatisfiable before this: N2-b locks the grid on an ambiguous commit, the
 * only exit is `load()`, and `load()` re-minted unconditionally. Under create-only — N3-A's
 * mandated mode — a lost response then meant the operator resubmitted identical rows under a NEW
 * key, the provider's idempotency cache was never consulted, and every row was created TWICE.
 */
describe('§11 — an ambiguous commit can be retried under the SAME key', () => {
  it('carries the key through the whole recovery walk: ambiguous commit -> load -> dryRun -> commit', async () => {
    mocks.commitPlmBulkGrid.mockResolvedValue({
      ok: false, status: 502, reason: 'provider-unavailable', stage: 'commit', message: 'PLM 无响应',
    })
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    const submittedKey = grid.idempotencyKey.value

    await grid.commit()
    expect(grid.mustReload.value).toBe(true)
    expect(grid.canRetrySameSubmission.value).toBe(true)

    // The recovery the UI actually walks. No seed rows: the rows must not move, or the bytes
    // change and the key would rightly conflict.
    await grid.load()
    expect(grid.idempotencyKey.value).toBe(submittedKey)

    // Re-validating must not disturb the key either -- dryRun is not an edit.
    mocks.commitPlmBulkGrid.mockResolvedValue({ ok: true, report: READY, mustReload: true })
    await grid.dryRun()
    expect(grid.idempotencyKey.value).toBe(submittedKey)

    await grid.commit()
    // THE assertion: the retry reaches the provider under the ORIGINAL key, so a write that had
    // already landed replays its cached report instead of creating every row a second time.
    expect(mocks.commitPlmBulkGrid).toHaveBeenLastCalledWith(
      'ds-1', 'Part', expect.anything(), 'caller-token', submittedKey, undefined,
    )
  })

  it('treats a thrown commit the same way (no response at all)', async () => {
    mocks.commitPlmBulkGrid.mockRejectedValue(new Error('network down'))
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    const submittedKey = grid.idempotencyKey.value

    await grid.commit()
    expect(grid.canRetrySameSubmission.value).toBe(true)
    expect(grid.errorMessage.value).toContain('提交结果未知')

    await grid.load()
    expect(grid.idempotencyKey.value).toBe(submittedKey)
  })

  it('re-mints instead when the refusal is DEFINITIVE — nothing was written and the key is spent', async () => {
    // The 409 case is the sharp one: idempotency_conflict means the provider saw the key and
    // refused because the bytes changed. Reusing it could only conflict again.
    for (const status of [400, 403, 409, 422]) {
      mocks.commitPlmBulkGrid.mockResolvedValue({
        ok: false, status, reason: 'provider-rejected', stage: 'commit', message: 'no',
      })
      const grid = makeGrid()
      await grid.load([{ item_number: 'P-001' }])
      await grid.dryRun()
      const submittedKey = grid.idempotencyKey.value

      await grid.commit()
      expect(grid.canRetrySameSubmission.value, `status ${status}`).toBe(false)
      expect(grid.idempotencyKey.value, `status ${status}`).not.toBe(submittedKey)
    }
  })

  it('drops a parked retry key the moment a cell changes — a changed grid is a NEW submission', async () => {
    mocks.commitPlmBulkGrid.mockResolvedValue({
      ok: false, status: 502, reason: 'provider-unavailable', stage: 'commit', message: 'PLM 无响应',
    })
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    const submittedKey = grid.idempotencyKey.value
    await grid.commit()
    expect(grid.canRetrySameSubmission.value).toBe(true)

    grid.updateCell(0, 'name', 'Bracket')
    expect(grid.canRetrySameSubmission.value).toBe(false)

    await grid.load()
    // Different bytes, so the same key would be a 409 by design. A fresh key is correct here.
    expect(grid.idempotencyKey.value).not.toBe(submittedKey)
  })

  it('re-seeding rows on reload re-mints, because the submission is no longer the same one', async () => {
    mocks.commitPlmBulkGrid.mockResolvedValue({
      ok: false, status: 502, reason: 'provider-unavailable', stage: 'commit', message: 'PLM 无响应',
    })
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    const submittedKey = grid.idempotencyKey.value
    await grid.commit()

    await grid.load([{ item_number: 'P-999' }])
    expect(grid.idempotencyKey.value).not.toBe(submittedKey)
    expect(grid.canRetrySameSubmission.value).toBe(false)
  })

  it('a clean commit parks nothing', async () => {
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()
    await grid.commit()

    expect(grid.canRetrySameSubmission.value).toBe(false)
  })
})

/**
 * The composable tests above stub `commitPlmBulkGrid`, so they prove what the composable does
 * GIVEN a `stage` — never that the service layer actually produces one. Without this block,
 * deleting the `stage` pass-through in `failure()` leaves every test above green while the
 * provably-clean freshness refusal silently collapses back into the ambiguous case.
 *
 * So these exercise the REAL service functions against a real relay response shape, with only
 * the HTTP boundary stubbed.
 */
describe('§11 — the service layer must carry `stage` off the relay response', () => {
  async function realWorkbench() {
    return vi.importActual<typeof import('../src/services/integration/workbench')>(
      '../src/services/integration/workbench',
    )
  }

  function relayResponds(status: number, body: Record<string, unknown>) {
    apiMocks.apiFetch.mockReset().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })
  }

  it('propagates stage:"freshness-dry-run" from the relay 409 — the provably-clean refusal', async () => {
    const { commitPlmBulkGrid } = await realWorkbench()
    relayResponds(409, {
      error: '提交前重新校验未通过',
      reason: 'freshness-check-failed',
      stage: 'freshness-dry-run',
      ready: false,
      row_errors: [],
    })

    const result = await commitPlmBulkGrid('ds-1', 'Part', [{}], 'caller-token', 'key-x')
    expect(result.ok).toBe(false)
    expect((result as { stage?: string }).stage).toBe('freshness-dry-run')
  })

  it('propagates stage:"commit" — the case where the write WAS attempted', async () => {
    const { commitPlmBulkGrid } = await realWorkbench()
    relayResponds(502, { error: 'PLM unavailable', reason: 'provider-unavailable', stage: 'commit' })

    const result = await commitPlmBulkGrid('ds-1', 'Part', [{}], 'caller-token', 'key-x')
    expect((result as { stage?: string }).stage).toBe('commit')
  })

  it('classifies those two responses the way §11 requires', async () => {
    // Ties the service layer's output to the composable's discriminator with the SAME shared
    // function the composable calls, so one mutation cannot fire on only one side.
    const { commitPlmBulkGrid } = await realWorkbench()
    const { commitOutcomeIsAmbiguous } = await vi.importActual<
      typeof import('../src/composables/usePlmBulkGrid')
    >('../src/composables/usePlmBulkGrid')

    relayResponds(409, { reason: 'freshness-check-failed', stage: 'freshness-dry-run', ready: false, row_errors: [] })
    const fresh = await commitPlmBulkGrid('ds-1', 'Part', [{}], 'caller-token', 'key-x')
    expect(commitOutcomeIsAmbiguous(fresh as never)).toBe(false)

    // THE case that makes `stage` load-bearing rather than decorative: the relay's OWN
    // pre-commit revalidation could not reach PLM. Same 502 as an ambiguous commit, but the
    // write was never attempted -- so status alone gets this wrong and only `stage` gets it
    // right. (The relay emits exactly this: relayProviderError + stage 'freshness-dry-run'.)
    relayResponds(502, { reason: 'provider-unavailable', stage: 'freshness-dry-run' })
    const freshUnreachable = await commitPlmBulkGrid('ds-1', 'Part', [{}], 'caller-token', 'key-x')
    expect(commitOutcomeIsAmbiguous(freshUnreachable as never)).toBe(false)

    relayResponds(502, { reason: 'provider-unavailable', stage: 'commit' })
    const unknown = await commitPlmBulkGrid('ds-1', 'Part', [{}], 'caller-token', 'key-x')
    expect(commitOutcomeIsAmbiguous(unknown as never)).toBe(true)
  })

  it('reads the relay schema route’s EMPTY match-candidate list rather than inventing one', async () => {
    const { getPlmBulkGridSchema } = await realWorkbench()
    relayResponds(200, {
      properties: PROPERTIES,
      declared_columns: PROPERTIES.map((p) => p.name),
      match_property_candidates: [],
      match_property_reason: 'match-property-uniqueness-unestablished',
      commit_enabled: true,
    })

    const schema = await getPlmBulkGridSchema('ds-1', 'Part', 'caller-token')
    expect(schema.ok).toBe(true)
    const okSchema = schema as Extract<typeof schema, { ok: true }>
    expect(okSchema.declaredColumns).toEqual(['item_number', 'name', 'cost_center'])
    expect(okSchema.matchPropertyCandidates).toEqual([])
  })

  it('falls back to NO candidates when the relay omits the field — never to declaredColumns', async () => {
    // The asymmetric-default test. A missing declared_columns falls back to the property names,
    // because a short column list is N1's silent delete. A missing candidate list falls back to
    // EMPTY, because guessing candidates re-advertises the unchecked update mode.
    const { getPlmBulkGridSchema } = await realWorkbench()
    relayResponds(200, { properties: PROPERTIES, commit_enabled: true })

    const schema = await getPlmBulkGridSchema('ds-1', 'Part', 'caller-token')
    const okSchema = schema as Extract<typeof schema, { ok: true }>
    expect(okSchema.declaredColumns).toEqual(['item_number', 'name', 'cost_center'])
    expect(okSchema.matchPropertyCandidates).toEqual([])
  })
})
