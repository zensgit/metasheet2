/**
 * B3-11 — read-only ruleName/sheetName resolution for the automation-execution
 * monitoring views (`GET /api/multitable/automation-executions`).
 *
 * Purely additive: it only ADDS a display label alongside the existing bare
 * `ruleId`/`sheetId`; it never mutates an execution row or gates a read on the
 * lookup succeeding. Two batched queries (never N+1 per row) resolve the CURRENT
 * `automation_rules.name` / `sheets.name` for the set of ids referenced by a
 * page of executions. A rule/sheet that was DELETED (or an automation_rules row
 * with a null `name`) is simply ABSENT from the returned map — callers degrade
 * to the raw id, never throw.
 */
import type { Kysely } from 'kysely'
import type { Database } from '../db/types'

export interface ExecutionNameMaps {
  ruleNames: Map<string, string>
  sheetNames: Map<string, string>
}

function uniqueNonEmpty(ids: readonly (string | null | undefined)[]): string[] {
  return Array.from(new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0)))
}

/**
 * Batched, read-only lookup of current rule/sheet display names.
 * Runs at most two SELECT ... WHERE id IN (...) queries regardless of how many
 * executions are being enriched (empty id sets skip their query entirely).
 */
export async function resolveExecutionNameMaps(
  db: Kysely<Database>,
  ruleIds: readonly (string | null | undefined)[],
  sheetIds: readonly (string | null | undefined)[],
): Promise<ExecutionNameMaps> {
  const uniqueRuleIds = uniqueNonEmpty(ruleIds)
  const uniqueSheetIds = uniqueNonEmpty(sheetIds)

  const [ruleRows, sheetRows] = await Promise.all([
    uniqueRuleIds.length
      ? db.selectFrom('automation_rules').select(['id', 'name']).where('id', 'in', uniqueRuleIds).execute()
      : Promise.resolve([]),
    uniqueSheetIds.length
      ? db.selectFrom('sheets').select(['id', 'name']).where('id', 'in', uniqueSheetIds).execute()
      : Promise.resolve([]),
  ])

  const ruleNames = new Map<string, string>()
  for (const row of ruleRows) {
    if (typeof row.name === 'string' && row.name.length > 0) ruleNames.set(row.id, row.name)
  }
  const sheetNames = new Map<string, string>()
  for (const row of sheetRows) {
    if (typeof row.name === 'string' && row.name.length > 0) sheetNames.set(row.id, row.name)
  }
  return { ruleNames, sheetNames }
}

/**
 * Resolve one execution's display names from the batched maps — degrades to the
 * raw id (never `undefined`/throws) when the rule/sheet is missing or unnamed.
 * `sheetName` is `null` (not the id) when the execution never had a sheetId to
 * begin with — there is nothing to name.
 */
export function executionDisplayNames(
  ruleId: string,
  sheetId: string | null | undefined,
  maps: ExecutionNameMaps,
): { ruleName: string; sheetName: string | null } {
  return {
    ruleName: maps.ruleNames.get(ruleId) ?? ruleId,
    sheetName: sheetId ? (maps.sheetNames.get(sheetId) ?? sheetId) : null,
  }
}
