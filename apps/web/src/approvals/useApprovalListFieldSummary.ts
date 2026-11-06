import { reactive } from 'vue'
import { useLocale } from '../composables/useLocale'
import type { FormSchema, UnifiedApprovalDTO } from '../types/approval'
import { getTemplate } from './api'
import { collectFormUserIds, formatSummaryLine, summaryFields } from './detailField'
import { ensureUserNamesResolved, getResolvedUserName } from './directoryResolve'

/** The row fields the summary line reads (list rows and the pane's detail row both fit). */
export type SummaryRow = Pick<UnifiedApprovalDTO, 'templateId'>
  & Partial<Pick<UnifiedApprovalDTO, 'formSnapshot' | 'summarySchema' | 'formSchema'>>

/**
 * The schema a row's summary line is built from, in order:
 *   1. `row.summarySchema` — the list DTO's per-row schema taken from the instance's OWN pinned
 *      template version (labels, options and the summary-field config of that version, trimmed by
 *      the server to the fields present in this row's snapshot). Old instances keep their version's
 *      labels and config after the template is renamed or reconfigured.
 *   2. `row.formSchema` — the frozen schema a DETAIL DTO carries (the master-detail pane can render
 *      the single-fetch detail when the row is not on the loaded page). Same version semantics.
 *   3. The LIVE template schema from the `templateId` cache — ONLY for rows that carry neither
 *      (bridged / external rows, or rows with no pinned version). This is the legacy path and keeps
 *      its live-label drift caveat (see the composable doc below).
 */
export function rowSummarySchema(
  schemas: Map<string, FormSchema> | undefined,
  row: SummaryRow | null | undefined,
): FormSchema | undefined {
  if (!row) return undefined
  if (row.summarySchema) return row.summarySchema
  if (row.formSchema) return row.formSchema
  return row.templateId ? schemas?.get(row.templateId) : undefined
}

/** True when the row already carries a version-pinned schema, so no live template fetch is needed. */
function rowCarriesPinnedSchema(row: SummaryRow): boolean {
  return Boolean(row.summarySchema || row.formSchema)
}

/**
 * B2-01 (待办列表关键字段摘要) — row-level glue: resolve the row's schema (`rowSummarySchema`), then
 * build the summary line via `summaryFields`/`formatSummaryLine`. Exported standalone (not only
 * reachable via the composable below) so `ApprovalMobileList.vue` — which receives the cache as a
 * plain `templateSchemas` prop, not the composable instance — shares the exact same glue instead of
 * re-deriving it. Returns `''` whenever there is no schema (no pinned version and no cached live
 * template: not fetched / still in flight / fetch failed), or no eligible field, so a caller can gate
 * rendering with a plain truthy `v-if`.
 */
export function resolveRowSummaryLine(
  schemas: Map<string, FormSchema> | undefined,
  row: SummaryRow,
  isZh: boolean,
  limit = 3,
): string {
  const schema = rowSummarySchema(schemas, row)
  if (!schema) return ''
  // Test report 2026-10-08 T4b: a `user` (人员) field in the summary renders the directory-resolved
  // name (ensured by `ensureLoadedForRows` below), never the stored id.
  return formatSummaryLine(summaryFields(schema, row.formSnapshot, limit, isZh, getResolvedUserName), isZh)
}

/**
 * B2-01 (待办列表关键字段摘要) — lazy per-templateId `FormSchema` cache backing the approval
 * list's row summary line, shared by `ApprovalCenterView`'s desktop table (all four tabs) and
 * `ApprovalMobileList`'s card list so the fetch + cache lives in exactly one place per view
 * session.
 *
 * VERSION SEMANTICS: platform rows carry `summarySchema` from the list endpoint itself, read from
 * each instance's pinned template version in ONE batched query per page (no per-row and no
 * per-template fetch). Those rows never touch this cache, so a template rename or a changed summary
 * config does not re-interpret instances started on an earlier version.
 *
 * LIVE FALLBACK (legacy rows only): a row with a `templateId` but no pinned schema still gets the
 * LIVE template via `getTemplate(id)` — the SAME `approvals:read` permission every list viewer
 * already needs. For those rows the old caveat remains: if the template's labels/options were edited
 * after the instance was created, the line can show today's label for yesterday's value. It is a
 * DISPLAY-ONLY line; the detail view always renders from the instance's FROZEN `formSchema`.
 *
 * A templateId is fetched AT MOST ONCE per view session regardless of outcome — `attempted` tracks
 * both successes and failures, so a deleted/broken template is not re-hit on every list reload or
 * tab switch. A failed fetch is swallowed silently: the affected rows simply render without a
 * summary (never a thrown error, never a toast).
 */
export function useApprovalListFieldSummary() {
  const schemas: Map<string, FormSchema> = reactive(new Map())
  // O-8 / F8-1: the summary line follows the shell locale (read at render time, so a locale switch
  // re-renders it through the same reactive dependency the template already tracks).
  const { isZh } = useLocale()
  const attempted = new Set<string>()
  const inflight = new Map<string, Promise<void>>()

  function loadOne(templateId: string): Promise<void> {
    const existing = inflight.get(templateId)
    if (existing) return existing
    const promise = getTemplate(templateId)
      .then((detail) => {
        schemas.set(templateId, detail.formSchema)
      })
      .catch(() => {
        // Silent by design — see the module doc comment above.
      })
      .finally(() => {
        attempted.add(templateId)
        inflight.delete(templateId)
      })
    inflight.set(templateId, promise)
    return promise
  }

  /**
   * Fetch the schema for every DISTINCT `templateId` among `rows` not already attempted this
   * session. Safe to call repeatedly (e.g. on every list reload/tab switch) — already-attempted
   * ids are skipped, and concurrent calls sharing a not-yet-settled id share the same in-flight
   * fetch instead of double-firing.
   */
  async function ensureLoadedForRows(rows: SummaryRow[]): Promise<void> {
    // Only rows WITHOUT a version-pinned schema need the live template (legacy fallback).
    const distinctIds = new Set(
      rows
        .filter((row) => !rowCarriesPinnedSchema(row))
        .map((row) => row.templateId)
        .filter((id): id is string => !!id && !attempted.has(id)),
    )
    await Promise.all(Array.from(distinctIds, (id) => loadOne(id)))
    // T4b: once the schemas are in, queue the member ids of the rows' top-level `user` values for
    // the shared batch resolve, so the summary line can show names. Runs here (an async side effect
    // the caller's watch triggers), never from the render-time `summaryLineFor`.
    ensureUserNamesResolved(rows.flatMap((row) => summaryUserIdsFor(row)))
  }

  /**
   * T4b — the member ids a row's summary line names: its top-level `user` values, read against the
   * same schema the line uses (`rowSummarySchema`: the row's pinned version first, the CACHED live
   * template only as the legacy fallback; this never fetches a template). It reads the reactive
   * cache, so a caller's watch over it re-fires once a fallback schema lands (gate r1 P3-4: the
   * master-detail pane's row).
   */
  function summaryUserIdsFor(row: SummaryRow | null | undefined): string[] {
    const schema = rowSummarySchema(schemas, row)
    return row && schema ? collectFormUserIds(schema, row.formSnapshot ?? null, { includeDetailColumns: false }) : []
  }

  function summaryLineFor(row: SummaryRow): string {
    return resolveRowSummaryLine(schemas, row, isZh.value)
  }

  return { schemas, ensureLoadedForRows, summaryLineFor, summaryUserIdsFor }
}
