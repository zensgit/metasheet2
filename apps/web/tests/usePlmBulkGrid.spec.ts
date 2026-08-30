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

vi.mock('../src/services/integration/workbench', () => mocks)

import { usePlmBulkGrid } from '../src/composables/usePlmBulkGrid'

const PROPERTIES = [
  { name: 'item_number', required: true },
  { name: 'name', required: true },
  { name: 'cost_center', required: false },
]

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
  mocks.getPlmBulkGridSchema.mockReset().mockResolvedValue({
    ok: true,
    properties: PROPERTIES,
    declaredColumns: PROPERTIES.map((p) => p.name),
    commitEnabled: true,
  })
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

  it("a server-side freshness 409 reports 'nothing was committed', not a phantom write", async () => {
    // The relay's freshness refusal is an HTTP 409 whose body ALSO carries ready:false, so it
    // looks superficially like a reject-all (a 200 + ready:false). Both mean nothing was
    // written, so the operator-visible claim must not diverge: the server's own message is
    // surfaced verbatim rather than the reject-all copy.
    mocks.commitPlmBulkGrid.mockResolvedValue({
      ok: false,
      status: 409,
      reason: 'freshness-check-failed',
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
    // Conservative: an unclean commit locks the grid even though nothing was written.
    expect(grid.mustReload.value).toBe(true)
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
    mocks.getPlmBulkGridSchema.mockResolvedValue({
      ok: true, properties: PROPERTIES, declaredColumns: PROPERTIES.map((p) => p.name), commitEnabled: false,
    })
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

describe('N3-A — match property', () => {
  it('defaults to create-only (no match_property sent)', async () => {
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    await grid.dryRun()

    expect(mocks.dryRunPlmBulkGrid).toHaveBeenCalledWith('ds-1', 'Part', expect.anything(), 'caller-token', undefined)
  })

  it('forwards a chosen match property', async () => {
    const grid = makeGrid()
    await grid.load([{ item_number: 'P-001' }])
    grid.matchProperty.value = 'item_number'
    await grid.dryRun()

    expect(mocks.dryRunPlmBulkGrid).toHaveBeenCalledWith('ds-1', 'Part', expect.anything(), 'caller-token', 'item_number')
  })
})
