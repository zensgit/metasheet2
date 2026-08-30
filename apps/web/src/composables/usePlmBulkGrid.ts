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
  indexBulkGridRowErrors,
  type PlmBulkGridProperty,
  type PlmBulkGridReport,
  type PlmBulkGridRowError,
  type PlmBulkGridSubmitResult,
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

/**
 * Statuses on which the relay has told us, definitively, that NOTHING was written: a request
 * the relay or the provider rejected outright. Everything else after a commit attempt —
 * 5xx, a transport failure, an unreadable body — leaves the outcome UNKNOWN.
 *
 * The 409 is in this set on purpose: `idempotency_conflict` means the provider recognised the
 * key and refused because the bytes changed, so the key is spent and nothing was written.
 */
const COMMIT_DEFINITELY_NOT_WRITTEN = new Set([400, 401, 403, 404, 409, 413, 422])

/**
 * §11's discriminator. "Did the write land?" — and the honest answer is often "unknown".
 *
 * `commitPlmBulkGrid` returns `{ok: false}` for every non-2xx rather than throwing, so the
 * commonest ambiguous case (the relay was reached, the provider was not) arrives in the normal
 * result branch and NOT in a `catch`. Classifying on "did we throw" would therefore mint a new
 * key for exactly the case §11 says to reuse one — and a lost response over a create-only grid
 * would then create every row a second time.
 *
 * A refusal at the freshness stage is provably clean: the relay re-runs dry-run BEFORE the
 * commit and never reaches the write.
 */
export function commitOutcomeIsAmbiguous(result: PlmBulkGridSubmitResult & { ok: false }): boolean {
  if (result.stage === 'freshness-dry-run') return false
  return !COMMIT_DEFINITELY_NOT_WRITTEN.has(result.status)
}

export function usePlmBulkGrid(options: UsePlmBulkGridOptions) {
  const now = options.now ?? (() => Date.now())
  const mintKey = options.mintKey ?? defaultMintKey
  const stalenessMs = options.stalenessMs ?? DEFAULT_STALENESS_MS

  const properties = ref<PlmBulkGridProperty[]>([])
  const declaredColumns = ref<string[]>([])
  const rows = ref<PlmBulkGridRow[]>([])
  const report = ref<PlmBulkGridReport | null>(null)
  /**
   * N3-A: the seam, parked at create-only. The relay refuses any submission carrying a
   * `match_property` (its uniqueness cannot be established for the ItemType in the tenant), and
   * `matchPropertyCandidates` comes back empty, so the panel offers nothing to set this to.
   * Kept as state rather than deleted because it is the single knob the owner's N3 disposition
   * turns — and because a client that sets it anyway must be seen to be refused.
   */
  const matchProperty = ref<string>('')
  const matchPropertyCandidates = ref<string[]>([])
  const matchPropertyReason = ref<string>('')
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
   * §11: "On a network failure or timeout with no response: retry with the SAME key. That is
   * the case the key exists for."
   *
   * That sentence is unsatisfiable without this ref. N2-b locks the grid after an ambiguous
   * commit, the only way out of the lock is `load()`, and `load()` used to re-mint the key
   * unconditionally — so the same-key retry §11 mandates could not physically be expressed.
   * Under create-only (N3-A's mandated mode) that meant a lost response led to an operator
   * resubmitting identical rows under a NEW key: the provider's idempotency cache is never
   * consulted, and EVERY ROW IS CREATED TWICE.
   *
   * So: an ambiguous commit parks its key here, `load()` restores it when the rows have not
   * moved, and any edit clears it — because a changed cell is a different submission and
   * reusing the key would be a 409 by design.
   */
  const pendingRetryKey = ref<string>('')

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

  /**
   * True while a submission of UNKNOWN outcome is parked for a same-key retry (§11). The panel
   * has to say so: reloading and resubmitting is normally a fresh submission, and this is the
   * one case where it must be byte-identical instead.
   */
  const canRetrySameSubmission = computed(() => pendingRetryKey.value !== '')

  // ONE indexer, shared with the service layer -- not a second local re-derivation.
  const rowErrorIndex = computed(() => indexBulkGridRowErrors(report.value))

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
    // A changed cell is a DIFFERENT submission, so any parked same-key retry is void: reusing
    // that key now would be a 409 by design (§11), which is the point of the design.
    pendingRetryKey.value = ''
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
      matchPropertyCandidates.value = schema.matchPropertyCandidates
      matchPropertyReason.value = schema.matchPropertyReason
      // N3-A: with no candidate the grid is create-only. Clearing here means a stale selection
      // can never survive a reload into a submission the relay would refuse anyway.
      if (!schema.matchPropertyCandidates.includes(matchProperty.value)) matchProperty.value = ''
      commitEnabled.value = schema.commitEnabled
      if (seedRows) rows.value = seedRows.map((row) => ({ ...row }))
      // A genuine reload is the ONLY thing that clears the N2-b lock and restarts the clock.
      mustReload.value = false
      loadedAt.value = now()
      report.value = null
      // §11 same-key retry. Preserved ONLY for a reload that re-reads the schema and leaves the
      // rows alone -- passing `seedRows` replaces them, which changes the bytes and therefore
      // demands a new key. Everything else re-mints.
      if (!seedRows && pendingRetryKey.value) {
        idempotencyKey.value = pendingRetryKey.value
      } else {
        pendingRetryKey.value = ''
        idempotencyKey.value = mintKey()
      }
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
    // Captured BEFORE the try so the catch can park it. The catch is the no-response case, and
    // §11 says that is exactly the case the key exists for -- it must not be out of scope there.
    const submittedKey = idempotencyKey.value
    submitting.value = true
    errorMessage.value = ''
    try {
      // DELIBERATE, not redundant with the server's own N2-a revalidation.
      //
      // The server relay re-runs dry-run authoritatively and refuses with a 409
      // (`freshness-check-failed`) if it is not ready. But reaching THAT 409 is a commit
      // ATTEMPT, and this composable locks the grid (`mustReload`) on any non-clean commit —
      // so an operator whose grid merely went stale would be forced through a full reload.
      // Checking here first keeps that case RECOVERABLE: a stale grid caught client-side
      // paints its row errors and stays editable. The server check remains the authority; this
      // one exists to avoid punishing the common case. Cost is one extra round trip per click.
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
        submittedKey,
        matchProperty.value || undefined,
      )
      if (!result.ok) {
        report.value = result.report ?? null
        errorMessage.value = result.message
        if (result.stage === 'freshness-dry-run') {
          // The relay's OWN pre-commit revalidation refused; the write was never attempted, so
          // this is not a failed commit at all. Locking here would force a reload for a grid
          // that merely needs fixing, which is the case N2-b is not about.
          return null
        }
        // N2-b: every other non-clean commit locks the grid until a reload.
        mustReload.value = true
        if (commitOutcomeIsAmbiguous(result)) {
          // §11: the write MAY have landed. Park the key so the reload can retry the identical
          // submission under it -- the provider then replays its cached report instead of
          // writing a second time.
          pendingRetryKey.value = submittedKey
          errorMessage.value = `${result.message}（提交结果未知，可能已写入。请重新加载后用同一幂等键原样重交，切勿改动后重交。）`
        } else {
          // A definitive refusal: nothing was written and this key is spent.
          pendingRetryKey.value = ''
          idempotencyKey.value = mintKey()
        }
        return null
      }
      report.value = result.report
      // A response arrived, so nothing is ambiguous from here on: no key is parked.
      pendingRetryKey.value = ''
      if (!result.report.ready) {
        // Reject-all: a 200 that wrote NOTHING. Fix and resubmit the whole grid with a fresh
        // load and a new key (§10: no partial retry).
        mustReload.value = true
        idempotencyKey.value = mintKey()
        errorMessage.value = '整批被拒绝，未写入任何数据。请重新加载并修正后整批重交。'
        return result.report
      }
      // N2-c: never display the local edit buffer as if it were PLM state.
      mustReload.value = true
      return result.report
    } catch (err) {
      // A throw is the other ambiguous case -- no response at all, so the write may or may not
      // have landed. Same treatment as an ambiguous status: lock, and park the key for §11.
      mustReload.value = true
      pendingRetryKey.value = submittedKey
      errorMessage.value = `${err instanceof Error ? err.message : String(err)}（提交结果未知，可能已写入。请重新加载后用同一幂等键原样重交。）`
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
    matchPropertyCandidates,
    matchPropertyReason,
    commitEnabled,
    loading,
    submitting,
    errorMessage,
    mustReload,
    idempotencyKey,
    pendingRetryKey,
    canRetrySameSubmission,
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
