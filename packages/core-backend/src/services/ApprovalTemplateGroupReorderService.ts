/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), §6 phase 3 (A-4): the
 * group-reorder endpoint (§4 acceptance E "后半" — phase 3's own concurrent-reorder leg; §3 I3
 * "分期 3 拖拽后整体重排 1..n"; §6 表第 3 行 "重排端点").
 *
 * Kept as its OWN module — not folded into `ApprovalTemplateGroupService.ts` — for the SAME
 * reason `ApprovalTemplateGroupSectionService.ts` is (see that file's header): the parallel
 * phase-2 (A-3) lane is mid-refactor of `ApprovalTemplateGroupService.ts` to `WithClient`
 * primitives, and this slice's only real dependency on it is the constraint-error mapping, which
 * is small enough to duplicate here rather than export-and-import across two concurrently-
 * changing lanes.
 *
 * Lock order (§2 锁序表): L0 → L1 (batch, every ACTIVE row of the org, `FOR UPDATE`) — the same
 * shape as `archiveApprovalTemplateGroup`'s L0→L1→L2 batch, one level shallower (reorder never
 * touches `approval_template_group_links`, so there is no L2). `SET TRANSACTION ISOLATION LEVEL
 * READ COMMITTED` is the FIRST statement after BEGIN — same load-bearing reason as the sibling
 * files' headers: a later SET aborts the transaction under a REPEATABLE READ default pool with
 * 25001, and a bare RR snapshot taken by the advisory-lock SELECT itself would still see a stale
 * active-id set after waiting on L0.
 *
 * `CONSTRAINT atg_sort_unique UNIQUE (org_id, sort_order) DEFERRABLE INITIALLY DEFERRED` (§2) is
 * why this can assign each row's NEW `sort_order` with N sequential per-row `UPDATE`s instead of a
 * two-phase "clear to NULL, then set" dance: a transient duplicate between statement K and
 * statement K+1 is legal mid-transaction and is only checked at COMMIT ("重排事务内允许中间态
 * 重复,提交时校验" — the same DDL-comment clause the phase-1 migration cites for the constraint's
 * own definition).
 */

import { transaction } from '../db/pg'
import { ServiceError } from './ApprovalBridgeService'

export interface ApprovalTemplateGroupReorderResult {
  id: string
  sortOrder: number
}

/**
 * Duplicated from `ApprovalTemplateGroupService.ts`'s private `mapGroupConstraintError` — see
 * this file's header for why. Reorder's own `UPDATE` never writes `name`, so in practice only the
 * `atg_sort_unique` branch is reachable through this path today; the `uq_atg_org_name_active`
 * branch is kept anyway so a future statement that DOES touch `name` on this table still gets a
 * typed code here instead of leaking a raw 23505 through `handleApprovalsError`'s generic 500.
 */
function mapReorderConstraintError(error: unknown): unknown {
  if (error instanceof ServiceError) return error
  const pgErr = error as { code?: unknown; constraint?: unknown } | null
  if (pgErr && typeof pgErr === 'object' && pgErr.code === '23505') {
    if (pgErr.constraint === 'atg_sort_unique') {
      return new ServiceError('Group sort order conflict', 500, 'GROUP_SORT_CONFLICT')
    }
    if (pgErr.constraint === 'uq_atg_org_name_active') {
      return new ServiceError('An active group with this name already exists', 409, 'GROUP_NAME_TAKEN')
    }
  }
  return error
}

/**
 * Pure — no DB access. Validates that `orderedIds` is EXACTLY a permutation of `activeIds` (same
 * elements, no duplicates, no extras, no omissions) — the task brief's "排列缺项/多项/含归档组 ⇒
 * 400 专用错误码". `activeIds` is expected to be the org's CURRENT active (`archived_at IS NULL`)
 * group id set, read by the caller under L0+L1 (this function itself takes no lock and issues no
 * query) so that, called from `reorderApprovalTemplateGroups` below, this check observes the SAME
 * snapshot the subsequent `UPDATE`s write against — no TOCTOU window between validating the set
 * and writing it, both inside one L0 critical section.
 *
 * Throws one `ServiceError` (400, `GROUP_REORDER_SET_MISMATCH`) for every shape of mismatch
 * (missing id / extra id / duplicate id / an archived or foreign id) rather than a distinct code
 * per shape: the client-observable fact is identical in all four cases — "the list you sent is not
 * this org's current active group set" — and `activeIds` deliberately contains ONLY active ids, so
 * an archived group's id is indistinguishable here from an id that never existed in this org at
 * all (both simply fail `activeSet.has(id)`).
 */
export function validateApprovalTemplateGroupReorderIds(
  orderedIds: readonly string[],
  activeIds: readonly string[],
): void {
  const activeSet = new Set(activeIds)
  const seen = new Set<string>()
  for (const id of orderedIds) {
    if (seen.has(id) || !activeSet.has(id)) {
      throw new ServiceError(
        "Reorder list must be exactly the org's current active group set, no more, no less",
        400,
        'GROUP_REORDER_SET_MISMATCH',
      )
    }
    seen.add(id)
  }
  if (seen.size !== activeSet.size) {
    // Every element of `orderedIds` individually passed the loop above (so `seen ⊆ activeSet` and
    // `orderedIds` had no internal duplicate), yet `seen` is still smaller than `activeSet` — the
    // list is missing at least one of the org's active groups.
    throw new ServiceError(
      "Reorder list must be exactly the org's current active group set, no more, no less",
      400,
      'GROUP_REORDER_SET_MISMATCH',
    )
  }
}

/**
 * L0→L1 (batch, every active row of the org, `FOR UPDATE`, `ORDER BY id` for a deterministic lock
 * order — not load-bearing for correctness, since every OTHER writer of this table also takes L0
 * first and is therefore fully serialized against this transaction before it could attempt any
 * row lock of its own; the ORDER BY only keeps this statement's own row-lock order stable across
 * runs for anyone reading a lock-wait trace). Writes `sort_order = 1..n` in `orderedIds`' order —
 * §3 I3: "分期 3 拖拽后整体重排 1..n" is a full re-rank, not a delta from each row's previous
 * position; there is no partial-reorder verb in this lock.
 */
export async function reorderApprovalTemplateGroups(
  orgId: string,
  orderedIds: readonly string[],
): Promise<ApprovalTemplateGroupReorderResult[]> {
  try {
    return await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${orgId}`])
      const activeRows = await client.query(
        `SELECT id FROM approval_template_groups WHERE org_id = $1 AND archived_at IS NULL ORDER BY id FOR UPDATE`,
        [orgId],
      )
      validateApprovalTemplateGroupReorderIds(
        orderedIds,
        (activeRows.rows as Array<{ id: string }>).map((row) => row.id),
      )

      const results: ApprovalTemplateGroupReorderResult[] = []
      for (let index = 0; index < orderedIds.length; index += 1) {
        const sortOrder = index + 1
        await client.query(
          `UPDATE approval_template_groups SET sort_order = $3, updated_at = now() WHERE org_id = $1 AND id = $2`,
          [orgId, orderedIds[index], sortOrder],
        )
        results.push({ id: orderedIds[index], sortOrder })
      }
      return results
    })
  } catch (error) {
    throw mapReorderConstraintError(error)
  }
}
