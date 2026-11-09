/**
 * R-69 I6a (G1) — the RULE'S SHEET must be the registered project sheet of the rule's project, owned by the
 * binding tenant (ADR adr-automation-pipeline-bridge-20261103 §3.1 "规则的 sheet_id 对 stock_prep_pull 必须是这些项目
 * 已登记的目标表" and §6.5 "租户…在触发时与表所属…的租户比对"). Checked at SAVE (AutomationService.
 * assertRunIntegrationJobAtSave) and RE-CHECKED at every TRIGGER (AutomationExecutor, between the binding-principal
 * check and the port lookup). Dry-run only, default OFF; R-69 is OPEN.
 *
 * THE AUTHORITY is the project-sheet registry (`integration_stock_prep_project_target`, migration 087), read through
 * the host's existing fixed-SQL read `readManualRowsProjectTarget` (stock-preparation-manual-rows-gate.ts) — the same
 * columns, the same SQLSTATE classification: 42P01 (table missing) = NOT REGISTERED, any other error = UNREADABLE.
 * The registry is the authority only while MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED is exactly `'true'`
 * (`stockPrepProjectSheetsEnabledForManualRows`, read per call); with the switch off there is no registered sheet
 * at all, so the verdict is `switch_off` (T-layer default R-90 (2): fail closed).
 *
 * THE PREDICATE (T-layer defaults R-90 (1)–(3)):
 *   - the switch is on;
 *   - the registry row for the rule's sheet is present and `status === 'active'` (an archived row is unregistered);
 *   - the row's `tenant_id` equals the binding tenant stamped at save (§6.5);
 *   - (save only, `projectNos` given) the rule lists EXACTLY ONE project and it is the row's `project_no` — 087 has
 *     UNIQUE(sheet_id), so one sheet is one project's and "these projects' registered target sheet" can only hold
 *     for a single project.
 * The trigger-time re-check passes no `projectNos`: its refusal set is the two closed causes `rule_sheet_unregistered`
 * / `rule_sheet_tenant_mismatch` (no project cause), so the project equality is a save-time guarantee.
 *
 * VALUES-FREE: the verdict is a closed token; no sheet id, tenant, project number or SQL text leaves this module.
 */
import {
  readManualRowsProjectTarget,
  stockPrepProjectSheetsEnabledForManualRows,
  type ManualRowsQueryFn,
} from './stock-preparation-manual-rows-gate'

export type RunIntegrationJobRuleSheetVerdict =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; refusal: 'switch_off' | 'unregistered' | 'tenant_mismatch' | 'project_mismatch' | 'unreadable' }>

const OK: RunIntegrationJobRuleSheetVerdict = Object.freeze({ ok: true as const })
const refuse = (refusal: Exclude<RunIntegrationJobRuleSheetVerdict, { ok: true }>['refusal']): RunIntegrationJobRuleSheetVerdict =>
  Object.freeze({ ok: false as const, refusal })

export async function checkRunIntegrationJobRuleSheet(
  query: ManualRowsQueryFn,
  input: { sheetId: unknown; tenantId: string; projectNos?: readonly string[] },
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunIntegrationJobRuleSheetVerdict> {
  if (!stockPrepProjectSheetsEnabledForManualRows(env)) return refuse('switch_off')
  const sheetId = typeof input.sheetId === 'string' ? input.sheetId.trim() : ''
  if (!sheetId) return refuse('unregistered')
  const read = await readManualRowsProjectTarget(query, sheetId)
  if (read.kind === 'unreadable') return refuse('unreadable')
  if (read.kind === 'absent') return refuse('unregistered')
  if (read.row.status !== 'active') return refuse('unregistered')
  if (typeof read.row.tenantId !== 'string' || read.row.tenantId !== input.tenantId) return refuse('tenant_mismatch')
  if (input.projectNos !== undefined) {
    if (input.projectNos.length !== 1 || typeof read.row.projectNo !== 'string' || input.projectNos[0] !== read.row.projectNo) {
      return refuse('project_mismatch')
    }
  }
  return OK
}

/** The save-time 400 messages (AutomationRuleValidationError). Fixed text: no sheet, tenant or project value. */
export const RUN_INTEGRATION_JOB_RULE_SHEET_SAVE_MESSAGES: Readonly<Record<Exclude<RunIntegrationJobRuleSheetVerdict, { ok: true }>['refusal'], string>> = Object.freeze({
  switch_off: "run_integration_job (stock_prep_pull) rules need the project-sheet registry (MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED is not 'true'); the rule was not saved",
  unregistered: 'run_integration_job (stock_prep_pull) rules must live on an active registered project sheet; this sheet is not one; the rule was not saved',
  tenant_mismatch: "run_integration_job (stock_prep_pull) rules must live on a project sheet registered to the creator's tenant; the rule was not saved",
  project_mismatch: "run_integration_job (stock_prep_pull) rules must list exactly one project, the sheet's registered project; the rule was not saved",
  unreadable: 'run_integration_job: the project-sheet registration could not be read; the rule was not saved',
})
