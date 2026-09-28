/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), §6 phase 3 (A-4): the
 * template-list `section=` token and its four-bucket query.
 *
 * Kept as its OWN module — not folded into `ApprovalTemplateGroupService.ts` — per the phase-3
 * task brief: that file is being refactored to `WithClient` primitives by the parallel phase-2
 * (A-3) lane, and this slice's job is read-only listing, not another write path on
 * `approval_template_groups` / `approval_template_group_links`. This file never opens a
 * transaction and never takes L0/L1/L2 (§2 锁序表 "只读路径不取 L0").
 *
 * `approval_templates` carries NO org column (lock §1) — org scoping for every bucket below lives
 * ENTIRELY in the `approval_template_group_links` EXISTS/NOT EXISTS predicates, each of which
 * carries `org_id = $1` (same discipline as §2 "SELECT 必须带 org 谓词" / acceptance A″, applied
 * here to a read path instead of a row lock).
 *
 * Row → DTO mapping reuses `TemplateRow` / `toApprovalTemplateListItemDTO` from
 * `ApprovalProductService.ts` (exported for exactly this) rather than re-deriving the
 * `visibility_scope` / `sla_hours` coercions a second time — one definition, so the sectioned
 * `data[]` shape stays byte-identical to the unsectioned `GET /api/approval-templates` response.
 */

import { pool } from '../db/pg'
import {
  applyTemplateVisibilityFilter,
  toApprovalTemplateListItemDTO,
  type ApprovalTemplateVisibilityActor,
  type TemplateRow,
} from './ApprovalProductService'
import type { ApprovalTemplateListItemDTO } from '../types/approval-product'

export type ApprovalTemplateSectionToken =
  | { readonly kind: 'group'; readonly groupId: string }
  | { readonly kind: 'ungrouped' }
  | { readonly kind: 'category'; readonly name: string }

/**
 * §4 acceptance C: "三个令牌、四个桶" — `group:<id>`, `ungrouped`, `category:<name>`. The token is
 * split on the FIRST `:` only (§2 "令牌按第一个 `:` 切分,name 原样" — a category name may itself
 * contain `:`, and `normalizeTemplateCategory` only trims + caps at 64 chars, it never rejects
 * `:`), and the part after the colon is returned VERBATIM — no trim, no case-fold. Returns `null`
 * for anything that is not one of the three exact shapes, so the caller can 400 on an unknown
 * token (§4 row J) instead of silently treating it as "no filter".
 */
export function parseApprovalTemplateSectionToken(raw: string): ApprovalTemplateSectionToken | null {
  if (raw === 'ungrouped') return { kind: 'ungrouped' }
  const colonIndex = raw.indexOf(':')
  if (colonIndex <= 0) return null
  const prefix = raw.slice(0, colonIndex)
  const rest = raw.slice(colonIndex + 1)
  if (rest.length === 0) return null
  if (prefix === 'group') return { kind: 'group', groupId: rest }
  if (prefix === 'category') return { kind: 'category', name: rest }
  return null
}

export interface ApprovalTemplateSectionListParams {
  orgId: string
  token: ApprovalTemplateSectionToken
  actor: ApprovalTemplateVisibilityActor
  status?: string
  search?: string
  limit: number
  offset: number
}

/**
 * Builds the bucket predicate for the outer query's WHERE clause. `orgIndex` is the already-bound
 * `$N` placeholder holding `orgId` (bound once by the caller, reused by every bucket — none of the
 * three needs it more than once). `sqlParams` accumulates any additional bucket-specific parameter
 * (the group id or category name); its OWN placeholder index is `sqlParams.length` after the push.
 *
 * `t` is the outer query's alias for `approval_templates`; `l` / `l2` are this predicate's own
 * (uncorrelated with each other) aliases for `approval_template_group_links`.
 */
function buildSectionBucketCondition(
  orgIndex: number,
  token: ApprovalTemplateSectionToken,
  sqlParams: unknown[],
): string {
  switch (token.kind) {
    case 'group': {
      // §2 "有效关联" is `group_id IS NOT NULL` (the CHECK `atgl_state_check` pairs it 1:1 with
      // `unlinked_at IS NULL`), so matching on `l.group_id = $N` alone already excludes every
      // unlinked/never-linked row — no separate `unlinked_at IS NULL` clause is needed.
      sqlParams.push(token.groupId)
      const groupIndex = sqlParams.length
      return `EXISTS (
        SELECT 1 FROM approval_template_group_links l
        WHERE l.org_id = $${orgIndex} AND l.template_id = t.id AND l.group_id = $${groupIndex}
      )`
    }
    case 'ungrouped':
      // Bucket ② (has a link row, but unlinked — `group_id IS NULL`) UNION bucket ④ (never had a
      // link row in this org, AND the legacy `category` back-fill is itself empty/unset). The
      // `OR category = ''` half matters (§4 acceptance C / v2.6 P2-A): a write-path bug or a
      // direct-DB edit can leave `category = ''` rather than NULL, and without this clause that
      // row falls into zero sections instead of `ungrouped`.
      return `(
        EXISTS (
          SELECT 1 FROM approval_template_group_links l
          WHERE l.org_id = $${orgIndex} AND l.template_id = t.id AND l.group_id IS NULL
        )
        OR (
          NOT EXISTS (
            SELECT 1 FROM approval_template_group_links l2
            WHERE l2.org_id = $${orgIndex} AND l2.template_id = t.id
          )
          AND (t.category IS NULL OR t.category = '')
        )
      )`
    case 'category': {
      // Bucket ③: never had a link row in this org (I2′'s `NOT EXISTS` — "从未关联过"), and the
      // legacy category equals the requested name exactly (§4 row D's fallback predicate, applied
      // here per-name instead of "any non-empty category").
      sqlParams.push(token.name)
      const nameIndex = sqlParams.length
      return `(
        NOT EXISTS (
          SELECT 1 FROM approval_template_group_links l
          WHERE l.org_id = $${orgIndex} AND l.template_id = t.id
        )
        AND t.category IS NOT NULL AND t.category <> ''
        AND t.category = $${nameIndex}
      )`
    }
  }
}

/**
 * §4 acceptance C: section-scoped listing with independent per-section pagination. `total` is
 * this bucket's own count (not the union of all sections), so the client never has to reconstruct
 * a per-section count itself ("每个 section 独立 page/pageSize" / "每节的计数不得由客户端拼").
 *
 * `status` / `search` compose with the bucket predicate exactly as they do in the unsectioned
 * `listTemplates` — only `category` is mutually exclusive with `section` (§4 row C: "与 section
 * 同时出现 ⇒ 400"), and that conflict is the ROUTE layer's job (checked, and rejected, before this
 * function is ever called — a caller that already resolved a bucket has nothing left to conflict
 * with `category` on).
 */
export async function listApprovalTemplatesBySection(
  params: ApprovalTemplateSectionListParams,
): Promise<{ data: ApprovalTemplateListItemDTO[]; total: number }> {
  if (!pool) throw new Error('Database not available')

  const sqlParams: unknown[] = [params.orgId]
  const orgIndex = 1
  let index = 2

  const conditions: string[] = [buildSectionBucketCondition(orgIndex, params.token, sqlParams)]
  // `buildSectionBucketCondition` may have appended one bucket-specific param (group id / category
  // name) after `orgId` — resume numbering the REST of the WHERE clause after whatever it used.
  index = sqlParams.length + 1

  if (params.status) {
    conditions.push(`status = $${index++}`)
    sqlParams.push(params.status)
  }
  if (params.search) {
    conditions.push(`(name ILIKE $${index} OR key ILIKE $${index})`)
    sqlParams.push(`%${params.search}%`)
    index += 1
  }
  index = applyTemplateVisibilityFilter(conditions, sqlParams, index, params.actor)

  const where = `WHERE ${conditions.join(' AND ')}`

  const totalResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM approval_templates t ${where}`,
    sqlParams,
  )
  const result = await pool.query<TemplateRow>(
    `SELECT t.*
     FROM approval_templates t
     ${where}
     ORDER BY t.updated_at DESC, t.id DESC
     LIMIT $${index++} OFFSET $${index++}`,
    [...sqlParams, params.limit, params.offset],
  )

  return {
    data: result.rows.map(toApprovalTemplateListItemDTO),
    total: Number.parseInt(totalResult.rows[0]?.count || '0', 10),
  }
}
