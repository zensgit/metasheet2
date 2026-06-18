/**
 * dept_head data plumbing — directory_departments.raw `dept_manager_userid_list` enrichment.
 *
 * Design-lock: docs/design/approval-dept-head-sync-plumbing-design-20260618.md.
 *
 * The DingTalk department-detail API (`/topapi/v2/department/get`) returns the
 * department's manager user ids, which `/topapi/v2/department/listsub` does NOT.
 * We enrich each department's stored raw with a normalized `dept_manager_userid_list`
 * (string[]) — the shape `ApprovalDirectoryOrg.parseDeptManagerExternalIds` reads.
 *
 * Failure semantics (last-known-good, the load-bearing invariant): a detail-fetch
 * SUCCESS — including a genuinely empty manager list — is authoritative; a detail-fetch
 * FAILURE must NOT be confused with success-empty, or a transient API blip would wipe a
 * previously-synced manager list and silently flip dept_head to empty. So at the
 * enrichment boundary the two are DISTINCT values:
 *   - success           → `managerUserIds = [...]` (possibly `[]`)
 *   - fetch failed       → `managerUserIds` stays `undefined`
 * and the upsert composer carries the prior value forward only on `undefined`.
 */

import type { DingTalkDepartment } from '../integrations/dingtalk/client'

type QueryFn = <Row>(text: string, params?: unknown[]) => Promise<{ rows: Row[] }>

/** A department carrying its (optional) freshly-fetched manager list. */
export type EnrichableDepartment = DingTalkDepartment & { managerUserIds?: string[] }

/** Normalize a `dept_manager_userid_list` value (DingTalk comma-string OR array) to string[]. */
export function normalizeDeptManagerList(value: unknown): string[] {
  const out: string[] = []
  const push = (v: unknown): void => {
    const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
    if (s) out.push(s)
  }
  if (Array.isArray(value)) value.forEach(push)
  else if (typeof value === 'string') value.split(',').forEach(push)
  return out
}

/**
 * Compose the raw the dept upsert writes: listsub raw + `dept_manager_userid_list`.
 * NEVER overwrites listsub keys.
 * - `managerList === undefined` (detail failed AND no prior) → listsub-only (field absent).
 * - `managerList === []` (success-empty) → the field is written as `[]` (authoritative empty).
 */
export function mergeDeptManagerIntoRaw(
  listsubRaw: Record<string, unknown>,
  managerList: string[] | undefined,
): Record<string, unknown> {
  if (managerList === undefined) return listsubRaw
  return { ...listsubRaw, dept_manager_userid_list: managerList }
}

/**
 * Last-known-good carry-forward for one department.
 * - fresh DEFINED (success, incl. `[]`) → fresh (authoritative).
 * - fresh UNDEFINED (fetch failed)       → prior (carry forward; `undefined` if none → field omitted).
 */
export function resolveManagerListForDept(
  fresh: string[] | undefined,
  prior: string[] | undefined,
): string[] | undefined {
  return fresh !== undefined ? fresh : prior
}

/**
 * THE SEAM. Best-effort, sequential (concurrency=1; explicit min-interval throttle
 * deferred — there is no real rate limiter yet, throughput is bounded only by
 * per-call latency) per-department detail fetch.
 * On success sets `managerUserIds` (incl. `[]`); on failure LEAVES IT `undefined`
 * (so the composer carries the prior value forward) and reports via `onError` —
 * it must never throw or fail the whole sync.
 */
export async function enrichDepartmentsWithManagers(
  departments: Iterable<EnrichableDepartment>,
  fetchDetail: (deptId: string) => Promise<{ deptManagerUserIdList: string[] }>,
  onError?: (deptId: string, error: unknown) => void,
): Promise<void> {
  for (const department of departments) {
    try {
      const detail = await fetchDetail(department.id)
      // success — authoritative, INCLUDING an empty list (distinct from failure below)
      department.managerUserIds = detail.deptManagerUserIdList
    } catch (error) {
      // failure — leave managerUserIds undefined so the composer carries prior forward
      onError?.(department.id, error)
    }
  }
}

/**
 * Capture the last-known-good `dept_manager_userid_list` per external department id,
 * BEFORE the whole-column upsert (`raw = EXCLUDED.raw`) overwrites the raw.
 */
export async function capturePriorDeptManagers(
  integrationId: string,
  query: QueryFn,
): Promise<Map<string, string[]>> {
  const result = await query<{ external_department_id: string; mgr: unknown }>(
    `SELECT external_department_id, raw->'dept_manager_userid_list' AS mgr
       FROM directory_departments
      WHERE integration_id = $1 AND raw ? 'dept_manager_userid_list'`,
    [integrationId],
  )
  const map = new Map<string, string[]>()
  for (const row of result.rows) {
    map.set(String(row.external_department_id), normalizeDeptManagerList(row.mgr))
  }
  return map
}
