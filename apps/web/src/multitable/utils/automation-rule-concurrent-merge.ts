// G-B2-23: shared "fetch N rules' data concurrently, write the ref once" helpers for
// MetaAutomationManager.vue (rule stats + rule last-run chips). Framework-free and
// state-free so both call sites — and their unit tests — exercise the exact same merge
// logic instead of each hand-rolling their own accumulation.

/**
 * Fold a batch of `[ruleId, value]` entries into a previous snapshot in a single pass.
 *
 * The bug this guards against: applying entries one at a time by re-spreading the SAME
 * base — e.g. `entries.forEach(([id, v]) => { next = { ...prev, [id]: v } })`, or
 * equivalently issuing one `ruleStats.value = { ...prev, [id]: v }` assignment per
 * resolved fetch where `prev` was captured once up front — recomputes from the same
 * stale snapshot every time. Each write clobbers the one before it instead of building
 * on it, so only the LAST entry in the batch survives; every earlier one is silently
 * dropped. `mergeRuleEntries` spreads `prev` exactly once into a single accumulator and
 * folds every entry into THAT accumulator, so entries never overwrite each other and the
 * order they arrive in doesn't matter. Do not "simplify" this back into a per-entry
 * re-spread — the matrix test below (`loses none of N entries...`) is written to catch
 * exactly that regression.
 */
export function mergeRuleEntries<T>(
  prev: Readonly<Record<string, T>>,
  entries: ReadonlyArray<readonly [ruleId: string, value: T]>,
): Record<string, T> {
  const next: Record<string, T> = { ...prev }
  for (const [ruleId, value] of entries) {
    next[ruleId] = value
  }
  return next
}

/**
 * Fetch `fetchOne(ruleId)` for every id in `ruleIds` concurrently (not the previous
 * serial `for (const rule of rules) await loadOne(rule.id)` loop, which paid one
 * request's round-trip latency per rule) and fold the results into `prev` via
 * `mergeRuleEntries` in one final assignment.
 *
 * A rejecting fetch is swallowed and simply excluded from the result — matches the
 * previous per-rule try/catch semantics ("one bad rule's stats/logs fetch must not
 * blank out data already fetched for the others"). Uses `Promise.allSettled` rather
 * than `Promise.all` for exactly this reason: `Promise.all` would reject the whole
 * batch (and thus write nothing) the moment any single rule's fetch fails.
 */
export async function loadRuleEntriesConcurrently<T>(
  prev: Readonly<Record<string, T>>,
  ruleIds: readonly string[],
  fetchOne: (ruleId: string) => Promise<T>,
): Promise<Record<string, T>> {
  const settled = await Promise.allSettled(ruleIds.map((ruleId) => fetchOne(ruleId)))
  const entries: Array<readonly [string, T]> = []
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      entries.push([ruleIds[index], result.value] as const)
    }
  })
  return mergeRuleEntries(prev, entries)
}
