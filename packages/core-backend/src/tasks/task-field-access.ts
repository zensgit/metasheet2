/**
 * Task feature — custom field definitions: SQL condition TEXT for selecting `task_fields` rows.
 * PURE, no I/O: the builders only return `{ sql, params }`; they never run a query.
 *
 * Design: docs/development/task-m5-pr4a-backend-design-20261010.md §4.7
 *
 * ASSUMPTION(task-m5a): [a-40] `task_fields.org_id` is written in exactly one place in this module
 * (`taskFieldOrgClause`); every exported builder goes through it. The binding and value tables have
 * no builder of their own: their rows are read only from a list, task or field definition already
 * selected for the session org, and their composite foreign keys keep them in that org.
 * Placeholders: `$1` is the field id and `$2` the org. A caller that appends its own parameters
 * numbers them from `params.length + 1`.
 *
 * M5 PR-4a slice 3 adds the by-id builder: the recurrence spawn reads the definition of every field
 * value it copies to the next occurrence, to tell which values are member values (design §3.2,
 * [a-15]). The definition routes (slice 5) use the same builder.
 */

export interface TaskFieldCondition {
  /** WHERE-clause fragment over `task_fields`, using `$1` / `$2`. */
  sql: string
  /** Positional bind values matching `$1` / `$2`. */
  params: unknown[]
}

const FIELD_ID_PLACEHOLDER = '$1'
const ORG_PLACEHOLDER = '$2'

/** The org clause of every builder below, followed by the rest of that builder's condition. */
function taskFieldOrgClause(rest: string): string {
  return `(task_fields.org_id = ${ORG_PLACEHOLDER}) AND ${rest}`
}

/** One field definition of one org, by id. `$1` = field id, `$2` = org. */
export function buildTaskFieldByIdCondition(input: { fieldIdParam: string; orgParam: string }): TaskFieldCondition {
  return {
    sql: taskFieldOrgClause(`task_fields.id = ${FIELD_ID_PLACEHOLDER}`),
    params: [input.fieldIdParam, input.orgParam],
  }
}
