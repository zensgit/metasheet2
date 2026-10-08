import { reactive } from 'vue'
import { useLocale } from '../composables/useLocale'
import type { FormSchema, UnifiedApprovalDTO } from '../types/approval'
import { getTemplate } from './api'
import { collectFormUserIds, formatSummaryLine, summaryFields } from './detailField'
import { ensureUserNamesResolved, getResolvedUserName } from './directoryResolve'

/**
 * B2-01 (待办列表关键字段摘要) — row-level glue: resolve `row.templateId` against a templateId ->
 * FormSchema cache, then build the summary line via `summaryFields`/`formatSummaryLine`. Exported
 * standalone (not only reachable via the composable below) so `ApprovalMobileList.vue` — which
 * receives the cache as a plain `templateSchemas` prop, not the composable instance — shares the
 * exact same glue instead of re-deriving it. Returns `''` whenever there is no templateId, no
 * cached schema yet (not fetched / still in flight / fetch failed), or no eligible field, so a
 * caller can gate rendering with a plain truthy `v-if`.
 */
export function resolveRowSummaryLine(
  schemas: Map<string, FormSchema> | undefined,
  row: Pick<UnifiedApprovalDTO, 'templateId' | 'formSnapshot'>,
  isZh: boolean,
  limit = 3,
): string {
  const templateId = row.templateId
  const schema = templateId ? schemas?.get(templateId) : undefined
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
 * WHY THE LIVE TEMPLATE, NOT THE FROZEN ONE: `UnifiedApprovalDTO` (the list DTO) never carries the
 * instance's frozen per-version `formSchema` — only the single-instance detail read does a second
 * DB round trip for that (`ApprovalBridgeService.getApproval`'s `template_version_id` follow-up
 * query; `listApprovals`/`toUnifiedDTO` never sets it). Fetching per-ROW would defeat the point of
 * a list (N calls instead of a handful keyed by distinct templateId), so this substitutes the LIVE
 * template schema via `getTemplate(id)` — the SAME `approvals:read` permission every list viewer
 * already needs (`GET /api/approval-templates/:id` and the list route `GET /api/approvals` both
 * resolve to the identical `rbacGuard` permission code).
 *
 * LIVE-LABEL DRIFT CAVEAT: if a template's labels/options are edited after an instance was
 * created, this summary can show today's label for yesterday's stored value (e.g. a renamed select
 * option, or a since-reordered field). That is an accepted, DISPLAY-ONLY tradeoff — this line
 * exists purely so an approver can decide whether an item is worth opening, never to be the
 * authoritative rendering. The detail view keeps rendering from the instance's own FROZEN
 * `formSchema` via `buildDisplayFields`, which stays the single source of truth.
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
  async function ensureLoadedForRows(
    rows: Array<Pick<UnifiedApprovalDTO, 'templateId'> & Partial<Pick<UnifiedApprovalDTO, 'formSnapshot'>>>,
  ): Promise<void> {
    const distinctIds = new Set(
      rows
        .map((row) => row.templateId)
        .filter((id): id is string => !!id && !attempted.has(id)),
    )
    await Promise.all(Array.from(distinctIds, (id) => loadOne(id)))
    // T4b: once the schemas are in, queue the member ids of the rows' top-level `user` values for
    // the shared batch resolve, so the summary line can show names. Runs here (an async side effect
    // the caller's watch triggers), never from the render-time `summaryLineFor`.
    ensureUserNamesResolved(rows.flatMap((row) => {
      const schema = row.templateId ? schemas.get(row.templateId) : undefined
      return schema ? collectFormUserIds(schema, row.formSnapshot ?? null, { includeDetailColumns: false }) : []
    }))
  }

  function summaryLineFor(row: Pick<UnifiedApprovalDTO, 'templateId' | 'formSnapshot'>): string {
    return resolveRowSummaryLine(schemas, row, isZh.value)
  }

  return { schemas, ensureLoadedForRows, summaryLineFor }
}
