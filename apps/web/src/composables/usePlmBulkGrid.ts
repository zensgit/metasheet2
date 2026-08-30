/**
 * MetaSheet bulk item-property maintenance grid — client state machine.
 *
 * Taskbook: docs/development/DEVELOPMENT_TASK_METASHEET_BULK_GRID_CONSUMER_20260829.md
 *
 * This composable owns the parts of N2 and §11 that are genuinely client-side state, and
 * nothing else. The data-destroying invariants (N1 serialization, N2-a's pre-commit
 * revalidation, N3-A's uniqueness precondition) are enforced on the SERVER relay so a bug in
 * this file cannot cause a silent wholesale property delete — see
 * packages/core-backend/src/routes/plm-bulk-import.ts. What lives here is the UX half:
 *
 *   N2-b  after ANY failed, partial or ambiguous commit the grid is LOCKED until it is
 *         reloaded from PLM. `canSubmit` goes false and stays false; there is deliberately no
 *         way to clear `mustReload` other than a real reload.
 *   N2-c  after a successful commit the local edit buffer is discarded, never displayed as if
 *         it were PLM state.
 *   N2-d  a grid left open past a threshold must be reloaded before commit is enabled.
 *   §11   a NEW Idempotency-Key is minted on every cell edit. Reusing one after an edit is a
 *         409 by design, so that an uncertain outcome can never be resolved by silently
 *         writing something different under the same key.
 *
 * §8: the dry-run report is component-local and MUST NOT be written into a sheet cell, a
 * store shared across viewers, or any server-side record. MetaSheet is collaborative; one
 * user's report rendered for another is a privilege leak that Pact cannot catch.
 */
import { computed, ref, type Ref } from 'vue'
import {
  commitPlmBulkGrid,
  dryRunPlmBulkGrid,
  getPlmBulkGridSchema,
  type PlmBulkGridProperty,
  type PlmBulkGridReport,
  type PlmBulkGridRowError,
} from '../services/integration/workbench'

export type PlmBulkGridRow = Record<string, unknown>

/** Default N2-d staleness threshold: 15 minutes. A product choice; the prompt is not optional. */
export const DEFAULT_STALENESS_MS = 15 * 60 * 1000

export interface UsePlmBulkGridOptions {
  dataSourceId: Ref<string> | (() => string)
  itemTypeId: Ref<string> | (() => string)
  /** The caller's own PLM credential (§2, Family I). Read per call, never cached here. */
  callerPlmToken: Ref<string> | (() => string)
  stalenessMs?: number
  /** Injectable for tests. */
  now?: () => number
  mintKey?: () => string
}

function read(source: Ref<string> | (() => string)): string {
  return typeof source === 'function' ? source() : source.value
}

function defaultMintKey(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID()
  return `bulk-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

export function usePlmBulkGrid(options: UsePlmBulkGridOptions) {
  const now = options.now ?? (() => Date.now())
  const mintKey = options.mintKey ?? defaultMintKey
  const stalenessMs = options.stalenessMs ?? DEFAULT_STALENESS_MS

  const properties = ref<PlmBulkGridProperty[]>([])
  const declaredColumns = ref<string[]>([])
  const rows = ref<PlmBulkGridRow[]>([])
  const report = ref<PlmBulkGridReport | null>(null)
  const matchProperty = ref<string>('')
  const commitEnabled = ref(false)
  const loading = ref(false)
  const submitting = ref(false)
  const errorMessage = ref('')
  const loadedAt = ref<number | null>(null)
  const idempotencyKey = ref<string>(mintKey())

  /**
   * N2-b. Set by ANY commit that did not cleanly succeed — including an ambiguous one (a
   * network failure with no response, where the write may or may not have landed). Cleared
   * ONLY by `load()`. This is the flag that makes stale resubmission impossible.
   */
  const mustReload = ref(false)

  /**
   * Reactive clock tick for N2-d.
   *
   * A `computed` that reads `now()` directly would be WRONG: Vue caches it against its
   * reactive dependencies, and wall-clock time is not one, so it would be evaluated once and
   * never re-evaluated as the session aged — N2-d's prompt would never fire in a live grid,
   * only in a test that happened to construct it late. `refreshStaleness()` bumps this ref
   * (the panel calls it on an interval), which is what makes the computed re-run.
   *
   * `commit()` additionally re-checks staleness against `now()` directly, so the guard holds
   * even if nothing ever ticks.
   */
  const clockTick = ref(0)

  function refreshStaleness(): void {
    clockTick.value += 1
  }

  function staleAt(at: number): boolean {
    if (loadedAt.value === null) return false
    return at - loadedAt.value > stalenessMs
  }

  const isStale = computed(() => {
    // Establish the dependency so a tick invalidates the cache.
    void clockTick.value
    return staleAt(now())
  })

  /** N2-d: an expired session must be reloaded before the commit affordance returns. */
  const needsRefreshBeforeCommit = computed(() => mustReload.value || isStale.value)

  const rowErrorIndex = computed(() => {
    const index = new Map<number, PlmBulkGridRowError[]>()
    for (const entry of report.value?.row_errors ?? []) {
      const bucket = index.get(entry.row_number)
      if (bucket) bucket.push(entry)
      else index.set(entry.row_number, [entry])
    }
    return index
  })

  /** `row_number` is 1-based over data rows, matching the serialized file the server built. */
  function errorsForRow(rowIndex: number): PlmBulkGridRowError[] {
    return rowErrorIndex.value.get(rowIndex + 1) ?? []
  }

  function errorsForCell(rowIndex: number, column: string): PlmBulkGridRowError[] {
    return errorsForRow(rowIndex).filter((entry) => entry.property_name === column)
  }

  const isReady = computed(() => report.value?.ready === true)

  /**
   * The commit affordance. Client-side ONLY — the server relay and ultimately Yuantus's
   * `require_admin_user` are the authoritative gate (§1: the manifest is a UI hint and NEVER
   * an authorization source). A non-admin who forces this button still gets a provider 403.
   */
  const canSubmit = computed(() =>
    isReady.value
    && !needsRefreshBeforeCommit.value
    && commitEnabled.value
    && !submitting.value
    && rows.value.length > 0,
  )

  /**
   * §11: any cell edit invalidates both the last verdict and the current key. The report is
   * dropped because it described DIFFERENT bytes; the key is re-minted because reusing it
   * after an edit is a conflict by design.
   */
  function markEdited(): void {
    report.value = null
    idempotencyKey.value = mintKey()
  }

  function updateCell(rowIndex: number, column: string, value: unknown): void {
    const row = rows.value[rowIndex]
    if (!row) return
    rows.value[rowIndex] = { ...row, [column]: value }
    markEdited()
  }

  function addRow(): void {
    // Create-only rows are legitimate; delete is NOT (§10: a row's delete affordance must not
    // exist, because the channel has no delete semantics).
    rows.value = [...rows.value, {}]
    markEdited()
  }

  async function load(seedRows?: PlmBulkGridRow[]): Promise<boolean> {
    loading.value = true
    errorMessage.value = ''
    try {
      const schema = await getPlmBulkGridSchema(read(options.dataSourceId), read(options.itemTypeId), read(options.callerPlmToken))
      if (!schema.ok) {
        errorMessage.value = schema.message
        return false
      }
      properties.value = schema.properties
      declaredColumns.value = schema.declaredColumns
      commitEnabled.value = schema.commitEnabled
      if (seedRows) rows.value = seedRows.map((row) => ({ ...row }))
      // A genuine reload is the ONLY thing that clears the N2-b lock and restarts the clock.
      mustReload.value = false
      loadedAt.value = now()
      report.value = null
      idempotencyKey.value = mintKey()
      return true
    } finally {
      loading.value = false
    }
  }

  async function dryRun(): Promise<boolean> {
    if (submitting.value) return false
    submitting.value = true
    errorMessage.value = ''
    try {
      const result = await dryRunPlmBulkGrid(
        read(options.dataSourceId),
        read(options.itemTypeId),
        rows.value,
        read(options.callerPlmToken),
        matchProperty.value || undefined,
      )
      if (!result.ok) {
        errorMessage.value = result.message
        report.value = result.report ?? null
        return false
      }
      // A 200 whose `ready` is false is a TOTAL REJECTION, not a success. Branch on `ready`.
      report.value = result.report
      return result.report.ready
    } finally {
      submitting.value = false
    }
  }

  /**
   * N2-a: the freshness ritual. Re-runs dry-run from the state about to be committed and
   * requires `ready` from THAT run before committing. The server relay performs the same
   * revalidation independently — this is the UX half, and neither is a lock: the window is
   * narrowed to one round trip, not eliminated. The UI must say so.
   */
  async function commit(): Promise<PlmBulkGridReport | null> {
    // Re-check against the wall clock, not only the cached computed: a grid that went stale
    // while the operator was reading it must not commit just because nothing ticked.
    if (staleAt(now())) {
      refreshStaleness()
      errorMessage.value = '表格已过期，请重新加载后再提交。'
      return null
    }
    if (!canSubmit.value) return null
    submitting.value = true
    errorMessage.value = ''
    try {
      const fresh = await dryRunPlmBulkGrid(
        read(options.dataSourceId),
        read(options.itemTypeId),
        rows.value,
        read(options.callerPlmToken),
        matchProperty.value || undefined,
      )
      if (!fresh.ok || !fresh.report.ready) {
        report.value = fresh.ok ? fresh.report : (fresh.report ?? null)
        errorMessage.value = fresh.ok
          ? '提交前重新校验未通过，未写入任何数据。请修正后重试。'
          : fresh.message
        // Not a failed WRITE -- nothing was attempted -- so the grid is not locked here.
        return null
      }

      const result = await commitPlmBulkGrid(
        read(options.dataSourceId),
        read(options.itemTypeId),
        rows.value,
        read(options.callerPlmToken),
        idempotencyKey.value,
        matchProperty.value || undefined,
      )
      if (!result.ok) {
        // N2-b: ANY non-clean commit locks the grid until a reload. This deliberately covers
        // the ambiguous case (no response) as well as an outright rejection: after an
        // uncertain write the local buffer can no longer be trusted to describe PLM.
        mustReload.value = true
        errorMessage.value = result.message
        report.value = result.report ?? null
        return null
      }
      report.value = result.report
      if (!result.report.ready) {
        // Reject-all: a 200 that wrote NOTHING. Fix and resubmit the whole grid with a fresh
        // load and a new key (§10: no partial retry).
        mustReload.value = true
        errorMessage.value = '整批被拒绝，未写入任何数据。请重新加载并修正后整批重交。'
        return result.report
      }
      // N2-c: never display the local edit buffer as if it were PLM state.
      mustReload.value = true
      return result.report
    } catch (err) {
      // An exception here is the ambiguous case: the write may or may not have landed.
      mustReload.value = true
      errorMessage.value = err instanceof Error ? err.message : String(err)
      return null
    } finally {
      submitting.value = false
    }
  }

  return {
    properties,
    declaredColumns,
    rows,
    report,
    matchProperty,
    commitEnabled,
    loading,
    submitting,
    errorMessage,
    mustReload,
    idempotencyKey,
    isStale,
    refreshStaleness,
    needsRefreshBeforeCommit,
    isReady,
    canSubmit,
    errorsForRow,
    errorsForCell,
    updateCell,
    addRow,
    markEdited,
    load,
    dryRun,
    commit,
  }
}
