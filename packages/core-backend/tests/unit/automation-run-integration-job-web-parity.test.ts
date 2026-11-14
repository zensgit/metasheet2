/**
 * R-69 1b-iii — server ⟷ web parity for the run_integration_job SAVE gate.
 *
 * The rule editor (apps/web/src/multitable/runIntegrationJobAuthoring.ts) mirrors the server's pure save
 * validators (src/multitable/automation-run-integration-job.ts: validateRunIntegrationJobConfig and
 * validateRunIntegrationJobTriggerCoupling, both called by AutomationService.assertRunIntegrationJobAtSave)
 * so a refusal is an inline save-block line instead of an opaque 400. A mirror checked only against its own
 * fixtures is a wire-vs-fixture blind spot, so BOTH functions are imported LIVE here (precedent:
 * approval-form-draft-signature-web-parity.test.ts) and every case must produce the byte-identical answer
 * (null, or the same 400 message for the same `path`). A change on EITHER side that is not made on the other
 * turns this red. The web module has zero runtime imports, so it loads in Node without a bundler.
 *
 * R-69 I6d: the editor's PROJECT LIMIT is not the pure validator's cap (20, mirrored above) but the count half of
 * the server's rule-sheet guard (automation-run-integration-job-rule-sheet.ts, register R-90: exactly one project
 * per rule). That half is pinned here too, against the LIVE guard: for the same config the web check and the
 * server guard agree, and the web message is the server's.
 *
 * R-69 I6d fix round 2 (F2): the job is its rule's ONLY action (server validateRunIntegrationJobSoleAction, called
 * from collectRunIntegrationJobOccurrences). The editor's mirror gives the byte-identical answer on a shape table.
 *
 * R-69 1b-ii (owner-approved 2026-11-11): a rule that carries the job carries no conditions (server
 * validateRunIntegrationJobConditions, called by createRule and by updateRule on the version-bound row). The editor's
 * mirror gives the byte-identical answer on a conditions table.
 *
 * Runs in the default core-backend unit job (tests/unit/**, not DB-gated) — no CI wiring needed.
 */
import { describe, expect, it } from 'vitest'

import {
  RUN_INTEGRATION_JOB_ACTION_TYPE as SERVER_ACTION_TYPE,
  RUN_INTEGRATION_JOB_APPLY_MODES as SERVER_APPLY_MODES,
  RUN_INTEGRATION_JOB_CONDITIONS_MESSAGE as SERVER_CONDITIONS_MESSAGE,
  RUN_INTEGRATION_JOB_KINDS as SERVER_KINDS,
  RUN_INTEGRATION_JOB_MAX_PROJECTS as SERVER_MAX_PROJECTS,
  RUN_INTEGRATION_JOB_NOT_SOLE_ERROR as SERVER_NOT_SOLE_ERROR,
  RUN_INTEGRATION_JOB_TIMEOUT_MIN_MS as SERVER_TIMEOUT_MIN_MS,
  collectRunIntegrationJobOccurrences as occurrencesServer,
  validateRunIntegrationJobConditions as conditionsServer,
  validateRunIntegrationJobConfig as validateServer,
  validateRunIntegrationJobSoleAction as soleActionServer,
  validateRunIntegrationJobTriggerCoupling as couplingServer,
} from '../../src/multitable/automation-run-integration-job'
import {
  RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MS as SERVER_TIMEOUT_DEFAULT_MS,
  RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS as SERVER_TIMEOUT_MAX_MS,
} from '../../src/multitable/automation-job-lease'
import {
  RUN_INTEGRATION_JOB_RULE_SHEET_SAVE_MESSAGES as SERVER_RULE_SHEET_MESSAGES,
  checkRunIntegrationJobRuleSheet as ruleSheetServer,
} from '../../src/multitable/automation-run-integration-job-rule-sheet'
import { STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV } from '../../src/multitable/stock-preparation-manual-rows-gate'
// LIVE import of the web module across the package boundary (relative path; apps/web is not a dependency).
// eslint-disable-next-line import/no-relative-packages
import {
  RUN_INTEGRATION_JOB_ACTION_TYPE as WEB_ACTION_TYPE,
  RUN_INTEGRATION_JOB_APPLY_MODES as WEB_APPLY_MODES,
  RUN_INTEGRATION_JOB_CONDITIONS_MESSAGE as WEB_CONDITIONS_MESSAGE,
  RUN_INTEGRATION_JOB_EDITOR_MAX_PROJECTS as WEB_EDITOR_MAX_PROJECTS,
  RUN_INTEGRATION_JOB_KINDS as WEB_KINDS,
  RUN_INTEGRATION_JOB_MAX_PROJECTS as WEB_MAX_PROJECTS,
  RUN_INTEGRATION_JOB_NOT_SOLE_MESSAGE as WEB_NOT_SOLE_MESSAGE,
  RUN_INTEGRATION_JOB_PROJECT_MISMATCH_MESSAGE as WEB_PROJECT_MISMATCH_MESSAGE,
  RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MS as WEB_TIMEOUT_DEFAULT_MS,
  RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS as WEB_TIMEOUT_MAX_MS,
  RUN_INTEGRATION_JOB_TIMEOUT_MIN_MS as WEB_TIMEOUT_MIN_MS,
  buildRunIntegrationJobConfig,
  checkRunIntegrationJobRuleSheetProjects as ruleSheetProjectsWeb,
  isRunIntegrationJobSelectable as selectableWeb,
  validateRunIntegrationJobConditions as conditionsWeb,
  validateRunIntegrationJobConfig as validateWeb,
  validateRunIntegrationJobSoleAction as soleActionWeb,
  validateRunIntegrationJobTriggerCoupling as couplingWeb,
} from '../../../../apps/web/src/multitable/runIntegrationJobAuthoring'

const MIN = 60_000
const stock = (job: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  job: { kind: 'stock_prep_pull', projectNos: ['P-001'], applyMode: 'dry_run_only', ...job },
  ...extra,
})
const projects = (n: number) => Array.from({ length: n }, (_, i) => `P-${String(i + 1).padStart(3, '0')}`)

/** Every branch of the server validator, plus its boundaries. `expectAccept` pins the verdict independently. */
const CONFIG_CASES: Array<[string, unknown, boolean]> = [
  ['minimal valid', stock({}), true],
  ['valid with timeout and actionId', stock({ actionId: 'plm.stock-preparation.pull-bom.v1' }, { timeoutMs: 30 * MIN }), true],
  ['binding key is accepted (server re-stamps it)', stock({}, { binding: { principalId: 'u', tenantId: 't' } }), true],
  ['not an object (null)', null, false],
  ['not an object (array)', [], false],
  ['not an object (string)', 'x', false],
  ['unknown top-level key', stock({}, { extra: 1 }), false],
  ['retry is reserved', stock({}, { retry: { max: 1 } }), false],
  ['retry null is still present', stock({}, { retry: null }), false],
  ['job missing', { timeoutMs: MIN }, false],
  ['job is an array', { job: [] }, false],
  ['kind missing', { job: { projectNos: ['P'], applyMode: 'dry_run_only' } }, false],
  ['kind outside the closed set', stock({ kind: 'yida_send' }), false],
  ['kind wrong case', stock({ kind: 'Stock_Prep_Pull' }), false],
  ['pipeline with an unknown key', { job: { kind: 'pipeline', pipelineId: 'p', dryRun: true, projectNos: [] } }, false],
  ['pipeline dryRun false', { job: { kind: 'pipeline', pipelineId: 'p', dryRun: false } }, false],
  ['pipeline dryRun missing', { job: { kind: 'pipeline', pipelineId: 'p' } }, false],
  ['pipeline dryRun true (not deliverable in this slice)', { job: { kind: 'pipeline', pipelineId: 'p', dryRun: true, mode: 'full' } }, false],
  ['stock-prep with a pipeline key', stock({ dryRun: true }), false],
  ['applyMode missing', { job: { kind: 'stock_prep_pull', projectNos: ['P'] } }, false],
  ['applyMode outside the closed set', stock({ applyMode: 'apply' }), false],
  ['applyMode apply_when_ready', stock({ applyMode: 'apply_when_ready' }), false],
  ['projectNos missing', { job: { kind: 'stock_prep_pull', applyMode: 'dry_run_only' } }, false],
  ['projectNos not an array', stock({ projectNos: 'P-001' }), false],
  ['projectNos empty', stock({ projectNos: [] }), false],
  ['projectNos at the cap (20)', stock({ projectNos: projects(20) }), true],
  ['projectNos over the cap (21)', stock({ projectNos: projects(21) }), false],
  ['project blank', stock({ projectNos: [''] }), false],
  ['project with a space', stock({ projectNos: ['P 001'] }), false],
  ['project non-ASCII', stock({ projectNos: ['项目1'] }), false],
  ['project 128 chars', stock({ projectNos: ['A'.repeat(128)] }), true],
  ['project 129 chars', stock({ projectNos: ['A'.repeat(129)] }), false],
  ['project not a string', stock({ projectNos: [1001] }), false],
  ['project repeated', stock({ projectNos: ['P-1', 'P-2', 'P-1'] }), false],
  ['project containing :// (the run summary refuses it; R-69 1c, I5 ruling N2)', stock({ projectNos: ['P-1', 'x://y', 'P-3'] }), false],
  ['project with a single colon or slash is still a project number', stock({ projectNos: ['P:1', 'P/2'] }), true],
  ['actionId blank', stock({ actionId: '' }), false],
  ['actionId not a string', stock({ actionId: 7 }), false],
  ['actionId outside the run-summary identifier shape (R-69 1c)', stock({ actionId: 'plm.stock-preparation.pull-bom.v1@site' }), false],
  ['actionId with a slash (never a URL)', stock({ actionId: 'plm/pull' }), false],
  ['actionId 128 identifier chars', stock({ actionId: 'a'.repeat(128) }), true],
  ['actionId 129 chars', stock({ actionId: 'a'.repeat(129) }), false],
  ['timeoutMs non-integer', stock({}, { timeoutMs: 1500.5 }), false],
  ['timeoutMs string', stock({}, { timeoutMs: '60000' }), false],
  ['timeoutMs NaN', stock({}, { timeoutMs: Number.NaN }), false],
  ['timeoutMs below min (999)', stock({}, { timeoutMs: 999 }), false],
  ['timeoutMs at min (1000)', stock({}, { timeoutMs: 1000 }), true],
  ['timeoutMs at the cap (55 min)', stock({}, { timeoutMs: 55 * MIN }), true],
  ['timeoutMs over the cap (55 min + 1 ms)', stock({}, { timeoutMs: 55 * MIN + 1 }), false],
  ['timeoutMs 60 min', stock({}, { timeoutMs: 60 * MIN }), false],
  ['timeoutMs undefined is the default', stock({}, { timeoutMs: undefined }), true],
]

const COUPLING_CASES: Array<[string, string, Record<string, unknown> | null | undefined, boolean]> = [
  ['cron with a business zone', 'schedule.cron', { cron: '0 6 * * *', timezone: 'Asia/Shanghai' }, true],
  ['cron with UTC', 'schedule.cron', { cron: '0 6 * * *', timezone: 'UTC' }, true],
  ['cron with a padded zone (server trims)', 'schedule.cron', { timezone: ' Asia/Shanghai ' }, true],
  ['cron without a timezone', 'schedule.cron', { cron: '0 6 * * *' }, false],
  ['cron with a blank timezone', 'schedule.cron', { timezone: '   ' }, false],
  ['cron with a non-string timezone', 'schedule.cron', { timezone: 8 }, false],
  ['cron with an invalid zone', 'schedule.cron', { timezone: 'Mars/Olympus' }, false],
  ['cron with null config', 'schedule.cron', null, false],
  ['cron with undefined config', 'schedule.cron', undefined, false],
  ['interval trigger', 'schedule.interval', { intervalMinutes: 5, timezone: 'Asia/Shanghai' }, false],
  ['date-field trigger', 'schedule.date_field', { timezone: 'Asia/Shanghai' }, false],
  ['record trigger', 'record.created', {}, false],
]

describe('run_integration_job save gate — server/web byte parity (R-69 1b-iii)', () => {
  it('canary: both sides loaded live (anti-vacuous guard)', () => {
    expect(typeof validateServer).toBe('function')
    expect(typeof validateWeb).toBe('function')
    expect(typeof couplingServer).toBe('function')
    expect(typeof couplingWeb).toBe('function')
    expect(validateServer('x', 'actionConfig')).not.toBeNull()
  })

  it('constants and closed vocabularies are equal', () => {
    expect(WEB_ACTION_TYPE).toBe(SERVER_ACTION_TYPE)
    expect(WEB_MAX_PROJECTS).toBe(SERVER_MAX_PROJECTS)
    expect(WEB_TIMEOUT_MIN_MS).toBe(SERVER_TIMEOUT_MIN_MS)
    expect(WEB_TIMEOUT_MAX_MS).toBe(SERVER_TIMEOUT_MAX_MS)
    expect(WEB_TIMEOUT_DEFAULT_MS).toBe(SERVER_TIMEOUT_DEFAULT_MS)
    expect([...WEB_KINDS].sort()).toEqual([...SERVER_KINDS].sort())
    expect([...WEB_APPLY_MODES].sort()).toEqual([...SERVER_APPLY_MODES].sort())
  })

  for (const path of ['actionConfig', 'actions[2].config']) {
    describe(`config validator, path ${path}`, () => {
      it.each(CONFIG_CASES)('%s', (_name, config, expectAccept) => {
        const server = validateServer(config, path)
        const web = validateWeb(config, path)
        expect(web).toBe(server)
        expect(server === null).toBe(expectAccept)
      })
    })
  }

  describe('trigger coupling (schedule.cron + IANA timezone required)', () => {
    it.each(COUPLING_CASES)('%s', (_name, triggerType, triggerConfig, expectAccept) => {
      const server = couplingServer(triggerType, triggerConfig)
      const web = couplingWeb(triggerType, triggerConfig)
      expect(web).toBe(server)
      expect(server === null).toBe(expectAccept)
    })
  })

  it('what the editor SENDS is what the server accepts (default draft = 30 min, dry_run_only, no binding, ONE project)', () => {
    const sent = buildRunIntegrationJobConfig({ rijKind: 'stock_prep_pull', rijProjectNosText: 'P-001', rijTimeoutMinutes: 30 })
    expect(sent).toEqual({ job: { kind: 'stock_prep_pull', projectNos: ['P-001'], applyMode: 'dry_run_only' }, timeoutMs: 30 * MIN })
    expect(validateServer(sent, 'actions[0].config')).toBeNull()
    expect(ruleSheetProjectsWeb(sent)).toBeNull()
    // The builder never truncates what was typed (lines and commas both separate): a longer list still reaches the
    // checks whole — the pure validator accepts it (its cap is 20), the one-project rule then refuses it (below).
    const typed = buildRunIntegrationJobConfig({ rijKind: 'stock_prep_pull', rijProjectNosText: 'P-001\nP-002, P-003', rijTimeoutMinutes: 30 })
    expect(typed).toEqual({ job: { kind: 'stock_prep_pull', projectNos: ['P-001', 'P-002', 'P-003'], applyMode: 'dry_run_only' }, timeoutMs: 30 * MIN })
    expect(validateServer(typed, 'actions[0].config')).toBeNull()
    expect(ruleSheetProjectsWeb(typed)?.code).toBe('projects_not_single')
    // The editor's minute cap is the server's cap: 55 accepted, 56 refused — on both sides.
    for (const [minutes, accept] of [[55, true], [56, false], [0, false], ['', true]] as const) {
      const config = buildRunIntegrationJobConfig({ rijKind: 'stock_prep_pull', rijProjectNosText: 'P-001', rijTimeoutMinutes: minutes })
      expect(validateServer(config, 'c') === null).toBe(accept)
      expect(validateWeb(config, 'c')).toBe(validateServer(config, 'c'))
    }
  })

  // ── R-69 I6d: the editor's project limit = the count half of the server's rule-sheet guard (register R-90) ──────
  describe('rule-sheet guard, project count: exactly one project per rule, on both sides', () => {
    /**
     * The LIVE server guard on the most favourable registry there is: the rule's sheet is registered, active, to the
     * binding tenant, and its project is the FIRST one the rule lists. Whatever the guard still refuses is the count.
     */
    const serverVerdict = (projectNos: string[]) => ruleSheetServer(
      async () => ({ rows: [{ sheet_id: 'sheet_1', project_no: projectNos[0], status: 'active', object_id: 'obj_1', tenant_id: 'tenant_1' }], rowCount: 1 }),
      { sheetId: 'sheet_1', tenantId: 'tenant_1', projectNos },
      { [STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV]: 'true' } as NodeJS.ProcessEnv,
    )

    it('the editor limit is 1 and its message is the server\'s project_mismatch text, byte for byte', () => {
      expect(WEB_EDITOR_MAX_PROJECTS).toBe(1)
      expect(WEB_PROJECT_MISMATCH_MESSAGE).toBe(SERVER_RULE_SHEET_MESSAGES.project_mismatch)
      // the two numbers are different rules: the pure cap (mirrored, 20) and the guard's count (1)
      expect(WEB_MAX_PROJECTS).toBe(SERVER_MAX_PROJECTS)
      expect(WEB_EDITOR_MAX_PROJECTS).toBeLessThan(WEB_MAX_PROJECTS)
    })

    it.each([1, 2, 3, 20])('%i project(s): the pure validator accepts on both sides; the count check and the live guard give the same verdict', async (count) => {
      const config = stock({ projectNos: projects(count) })
      expect(validateServer(config, 'actions[0].config')).toBeNull()
      expect(validateWeb(config, 'actions[0].config')).toBeNull()
      const server = await serverVerdict(projects(count))
      const web = ruleSheetProjectsWeb(config)
      expect(server.ok).toBe(count === 1)
      expect(web === null).toBe(server.ok)
      if (server.ok === false) {
        expect(server.refusal).toBe('project_mismatch')
        expect(web?.message).toBe(SERVER_RULE_SHEET_MESSAGES[server.refusal])
      }
    })

    it('anti-vacuous: the favourable registry really is favourable (one project passes), and the count is what refuses two', async () => {
      expect(await serverVerdict(['P-001'])).toEqual({ ok: true })
      expect(await serverVerdict(['P-001', 'P-002'])).toEqual({ ok: false, refusal: 'project_mismatch' })
    })
  })

  // ── R-69 I6d fix round 2 (F2): the job is its rule's ONLY action, on both sides ─────────────────────────────────
  describe('sole action: a rule that carries the job holds nothing else, on both sides', () => {
    const J = { type: SERVER_ACTION_TYPE, config: {} }
    const X = { type: 'send_notification', config: {} }
    /** [label, the legacy pair's type, the rule's actions, accepted?] — `accepted` pins the verdict independently. */
    const SOLE_CASES: Array<[string, string, unknown, boolean]> = [
      ['no job anywhere (pair only)', 'send_notification', null, true],
      ['no job anywhere (a list of other actions)', 'send_notification', [X, X], true],
      ['(A) the legacy pair alone, actions undefined', SERVER_ACTION_TYPE, undefined, true],
      ['(A) the legacy pair alone, actions null', SERVER_ACTION_TYPE, null, true],
      ['(A) the legacy pair alone, actions []', SERVER_ACTION_TYPE, [], true],
      ['(B) the editor shape: actions [job], the pair mirrored', SERVER_ACTION_TYPE, [J], true],
      ['the job, then another action', SERVER_ACTION_TYPE, [J, X], false],
      ['another action, then the job', 'send_notification', [X, J], false],
      ['the job between two others', 'send_notification', [X, J, X], false],
      ['the job twice', SERVER_ACTION_TYPE, [J, J], false],
      ['the job only in the pair, beside a list of another action', SERVER_ACTION_TYPE, [X], false],
      ['the job only in the list, under a pair that is another action', 'send_notification', [J], false],
      ['an entry that is not an action, beside the job', SERVER_ACTION_TYPE, [J, null], false],
      ['a list of one entry that is not an action, under a job pair', SERVER_ACTION_TYPE, [null], false],
      ['a list that is not a list is no list (the executor runs the pair)', SERVER_ACTION_TYPE, 'run_integration_job', true],
      ['a bare type string is not an action entry', 'send_notification', ['run_integration_job'], true],
      ['a job entry without a config is still a job entry', 'send_notification', [{ type: SERVER_ACTION_TYPE }], false],
    ]

    it('the web message is the server\'s, byte for byte', () => {
      expect(WEB_NOT_SOLE_MESSAGE).toBe(SERVER_NOT_SOLE_ERROR)
    })

    it.each(SOLE_CASES)('%s: the same answer on both sides', (_label, actionType, actions, accepted) => {
      const server = soleActionServer(actionType, actions as never)
      expect(soleActionWeb(actionType, actions as never)).toBe(server)
      expect(server === null).toBe(accepted)
      if (!accepted) expect(server).toBe(SERVER_NOT_SOLE_ERROR)
    })

    it('anti-vacuous: the table refuses and accepts, and the server\'s save gate answers with this very check', () => {
      expect(SOLE_CASES.filter(([, , , accepted]) => accepted).length).toBeGreaterThanOrEqual(6)
      expect(SOLE_CASES.filter(([, , , accepted]) => !accepted).length).toBeGreaterThanOrEqual(8)
      // collectRunIntegrationJobOccurrences — what assertRunIntegrationJobAtSave throws from — carries the same answer
      expect(occurrencesServer('send_notification', {}, [X, J] as never, [X, J] as never).error).toBe(SERVER_NOT_SOLE_ERROR)
      expect(occurrencesServer(SERVER_ACTION_TYPE, {}, [J] as never, [J] as never).error).toBeNull()
    })

    it('the editor offers the job for a NEW selection only on a rule with one action row — the shape the server accepts', () => {
      expect(selectableWeb(true, 'schedule.cron', 'send_notification', 1)).toBe(true)
      for (const count of [2, 3]) expect(selectableWeb(true, 'schedule.cron', 'send_notification', count)).toBe(false)
      // a loaded job stays listed whatever the count (never silently dropped); the save block is what stops the save
      expect(selectableWeb(false, 'record.created', SERVER_ACTION_TYPE, 3)).toBe(true)
    })
  })

  describe('conditions: a rule that carries the job carries no conditions, on both sides (R-69 1b-ii, owner-approved 2026-11-11)', () => {
    /** [label, the rule's conditions, accepted?] — `accepted` pins the verdict independently. */
    const CONDITIONS_CASES: Array<[string, unknown, boolean]> = [
      ['absent (undefined)', undefined, true],
      ['absent (null)', null, true],
      ['an empty group', { conjunction: 'AND', conditions: [] }, true],
      ['one condition', { conjunction: 'AND', conditions: [{ fieldId: 'status', operator: 'equals', value: 'x' }] }, false],
      ['a group holding only an empty group (a node is a node)', { conjunction: 'OR', conditions: [{ conjunction: 'AND', conditions: [] }] }, false],
      ['a malformed group (no list)', { conjunction: 'AND' }, false],
      ['a group whose list is not a list', { conjunction: 'AND', conditions: 'x' }, false],
    ]

    it('the web message is the server\'s, byte for byte', () => {
      expect(WEB_CONDITIONS_MESSAGE).toBe(SERVER_CONDITIONS_MESSAGE)
    })

    it.each(CONDITIONS_CASES)('%s: the same answer on both sides', (_label, conditions, accepted) => {
      const server = conditionsServer(conditions)
      expect(conditionsWeb(conditions)).toBe(server)
      expect(server === null).toBe(accepted)
      if (!accepted) expect(server).toBe(SERVER_CONDITIONS_MESSAGE)
    })

    it('anti-vacuous: the table refuses and accepts', () => {
      expect(CONDITIONS_CASES.filter(([, , accepted]) => accepted).length).toBeGreaterThanOrEqual(3)
      expect(CONDITIONS_CASES.filter(([, , accepted]) => !accepted).length).toBeGreaterThanOrEqual(4)
    })
  })
})
