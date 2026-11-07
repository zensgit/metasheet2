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
 * Runs in the default core-backend unit job (tests/unit/**, not DB-gated) — no CI wiring needed.
 */
import { describe, expect, it } from 'vitest'

import {
  RUN_INTEGRATION_JOB_ACTION_TYPE as SERVER_ACTION_TYPE,
  RUN_INTEGRATION_JOB_APPLY_MODES as SERVER_APPLY_MODES,
  RUN_INTEGRATION_JOB_KINDS as SERVER_KINDS,
  RUN_INTEGRATION_JOB_MAX_PROJECTS as SERVER_MAX_PROJECTS,
  RUN_INTEGRATION_JOB_TIMEOUT_MIN_MS as SERVER_TIMEOUT_MIN_MS,
  validateRunIntegrationJobConfig as validateServer,
  validateRunIntegrationJobTriggerCoupling as couplingServer,
} from '../../src/multitable/automation-run-integration-job'
import {
  RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MS as SERVER_TIMEOUT_DEFAULT_MS,
  RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS as SERVER_TIMEOUT_MAX_MS,
} from '../../src/multitable/automation-job-lease'
// LIVE import of the web module across the package boundary (relative path; apps/web is not a dependency).
// eslint-disable-next-line import/no-relative-packages
import {
  RUN_INTEGRATION_JOB_ACTION_TYPE as WEB_ACTION_TYPE,
  RUN_INTEGRATION_JOB_APPLY_MODES as WEB_APPLY_MODES,
  RUN_INTEGRATION_JOB_KINDS as WEB_KINDS,
  RUN_INTEGRATION_JOB_MAX_PROJECTS as WEB_MAX_PROJECTS,
  RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MS as WEB_TIMEOUT_DEFAULT_MS,
  RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS as WEB_TIMEOUT_MAX_MS,
  RUN_INTEGRATION_JOB_TIMEOUT_MIN_MS as WEB_TIMEOUT_MIN_MS,
  buildRunIntegrationJobConfig,
  validateRunIntegrationJobConfig as validateWeb,
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

  it('what the editor SENDS is what the server accepts (default draft = 30 min, dry_run_only, no binding)', () => {
    const sent = buildRunIntegrationJobConfig({ rijKind: 'stock_prep_pull', rijProjectNosText: 'P-001\nP-002, P-003', rijTimeoutMinutes: 30 })
    expect(sent).toEqual({ job: { kind: 'stock_prep_pull', projectNos: ['P-001', 'P-002', 'P-003'], applyMode: 'dry_run_only' }, timeoutMs: 30 * MIN })
    expect(validateServer(sent, 'actions[0].config')).toBeNull()
    // The editor's minute cap is the server's cap: 55 accepted, 56 refused — on both sides.
    for (const [minutes, accept] of [[55, true], [56, false], [0, false], ['', true]] as const) {
      const config = buildRunIntegrationJobConfig({ rijKind: 'stock_prep_pull', rijProjectNosText: 'P-001', rijTimeoutMinutes: minutes })
      expect(validateServer(config, 'c') === null).toBe(accept)
      expect(validateWeb(config, 'c')).toBe(validateServer(config, 'c'))
    }
  })
})
