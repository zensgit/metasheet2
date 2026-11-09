/**
 * R-69 1c test utility: the in-memory model of the outbound-intent and job-lease ledgers that
 * tests/unit/automation-run-integration-job.test.ts (I3) defines inline — the same statements, matched by shape,
 * `now()` evaluated with the (fake) clock, a transaction rolled back on throw. Copied verbatim (not imported) so the
 * I3 suite stays byte-identical. Synthetic only.
 *
 * R-69 I6a: the model also answers the ONE project-sheet registry read the executor's rule-sheet re-check issues
 * (stock-preparation-manual-rows-gate.ts MANUAL_ROWS_PROJECT_TARGET_SQL, migration 087). `projectTargets` defaults to
 * the one row every harness here runs on — `sheet_1` registered, active, to `tenant_1` / `P-1` — so the existing
 * cases keep their meaning; a case mutates the map (archive, re-register) or sets the registry unreadable. The read
 * is not logged (the `log` assertions are about the ledgers).
 */
import type { AutomationDeps } from '../../src/multitable/automation-executor'

interface IntentRow { status: string; attempts: number; token: string | null; lease: number | null; lastError: string | null }
interface LeaseRow { holder: string | null; fence: number; expires: number }
export interface FakeProjectTargetRow { tenantId: string; projectNo: string; status: 'active' | 'archived'; objectId?: string }

export const FAKE_REGISTERED_SHEET = Object.freeze({ sheetId: 'sheet_1', tenantId: 'tenant_1', projectNo: 'P-1' })

export function createFakeJobDb(options: { projectTargets?: Record<string, FakeProjectTargetRow> } = {}) {
  const intents = new Map<string, IntentRow>()
  const leases = new Map<string, LeaseRow>()
  const log: string[] = []
  let renewalsFailing = false
  const projectTargets = new Map<string, FakeProjectTargetRow>(Object.entries(options.projectTargets ?? {
    [FAKE_REGISTERED_SHEET.sheetId]: { tenantId: FAKE_REGISTERED_SHEET.tenantId, projectNo: FAKE_REGISTERED_SHEET.projectNo, status: 'active' },
  }))
  let registryError: (Error & { code?: string }) | null = null
  const key = (p: unknown[], idx = [0, 1, 2, 3]) => idx.map((i) => String(p[i])).join('|')
  const query: AutomationDeps['queryFn'] = async (sql, params = []) => {
    const now = Date.now()
    if (/FROM integration_stock_prep_project_target WHERE sheet_id = \$1/.test(sql)) {
      if (registryError) throw registryError
      const row = projectTargets.get(String(params[0]))
      return row
        ? { rows: [{ sheet_id: String(params[0]), project_no: row.projectNo, status: row.status, object_id: row.objectId ?? 'obj_1', tenant_id: row.tenantId }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (/INSERT INTO meta_automation_outbound_intent/.test(sql)) {
      const k = key(params)
      log.push('intent:claim')
      if (intents.has(k)) return { rows: [], rowCount: 0 }
      intents.set(k, { status: 'pending', attempts: 1, token: String(params[4]), lease: now + Number(params[5]), lastError: null })
      return { rows: [], rowCount: 1 }
    }
    if (/SELECT status, attempt_token/.test(sql)) {
      const row = intents.get(key(params))
      return { rows: row ? [{ status: row.status, attempt_token: row.token, lease_live: row.lease !== null && row.lease > now }] : [], rowCount: row ? 1 : 0 }
    }
    if (/SET status = 'outcome_unknown', last_error = 'lease_expired'/.test(sql)) {
      const row = intents.get(key(params))
      log.push('intent:expire')
      if (row && row.status === 'pending' && row.token === (params[4] ?? null) && (row.lease === null || row.lease <= now)) {
        row.status = 'outcome_unknown'; row.lastError = 'lease_expired'
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (/SET status = 'pending', attempts = attempts \+ 1/.test(sql)) {
      const row = intents.get(key(params))
      if (row && row.status === 'failed') {
        row.status = 'pending'; row.attempts += 1; row.token = String(params[4]); row.lease = now + Number(params[5])
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (/UPDATE meta_automation_outbound_intent\s+SET lease_expires_at = now\(\)/.test(sql)) {
      const row = intents.get(key(params))
      log.push('intent:renew')
      if (row && row.status === 'pending' && row.token === String(params[5])) { row.lease = now + Number(params[4]); return { rows: [], rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    }
    if (/UPDATE meta_automation_outbound_intent\s+SET status = \$4/.test(sql)) {
      const row = intents.get(key(params, [0, 1, 2, 5]))
      log.push('intent:outcome')
      if (row && row.status === 'pending' && row.token === String(params[6])) { row.status = String(params[3]); row.lastError = params[4] == null ? null : String(params[4]); return { rows: [], rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    }
    if (/INSERT INTO meta_automation_job_leases/.test(sql)) {
      const scope = String(params[0]); const row = leases.get(scope); const ttl = Number(params[2])
      log.push('lease:claim')
      if (!row) { leases.set(scope, { holder: String(params[1]), fence: 1, expires: now + ttl }); return { rows: [{ fence: '1' }], rowCount: 1 } }
      if (row.expires <= now) { row.fence += 1; row.holder = String(params[1]); row.expires = now + ttl; return { rows: [{ fence: String(row.fence) }], rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    }
    if (/SELECT 1 AS ok FROM meta_automation_job_leases/.test(sql)) {
      const row = leases.get(String(params[0]))
      log.push('lease:checkpoint')
      return row && String(row.fence) === String(params[1]) && row.expires > now ? { rows: [{ ok: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (/FROM meta_automation_job_leases[\s\S]*FOR UPDATE/.test(sql)) {
      const row = leases.get(String(params[0]))
      log.push('lease:lock')
      return row ? { rows: [{ holder: row.holder, fence: String(row.fence), live: row.expires > now }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (/UPDATE meta_automation_job_leases\s+SET lease_expires_at = now\(\) \+/.test(sql)) {
      const row = leases.get(String(params[0]))
      log.push('lease:renew')
      if (row && String(row.fence) === String(params[1]) && row.holder === String(params[2]) && row.expires > now) { row.expires = now + Number(params[3]); return { rows: [], rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    }
    if (/UPDATE meta_automation_job_leases\s+SET lease_expires_at = now\(\), holder = NULL/.test(sql)) {
      const row = leases.get(String(params[0]))
      log.push('lease:release')
      if (row && String(row.fence) === String(params[1])) { row.expires = now; row.holder = null; return { rows: [], rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`fake db: unexpected statement: ${sql.slice(0, 70)}`)
  }
  const snapshot = () => ({ i: new Map([...intents].map(([k, v]) => [k, { ...v }])), l: new Map([...leases].map(([k, v]) => [k, { ...v }])) })
  const transaction: NonNullable<AutomationDeps['transaction']> = async (handler) => {
    if (renewalsFailing) throw new Error('fake db: connection lost')
    const before = snapshot()
    log.push('BEGIN')
    try {
      const result = await handler({ query })
      log.push('COMMIT')
      return result
    } catch (error) {
      intents.clear(); leases.clear()
      for (const [k, v] of before.i) intents.set(k, v)
      for (const [k, v] of before.l) leases.set(k, v)
      log.push('ROLLBACK')
      throw error
    }
  }
  return {
    query,
    transaction,
    intents,
    leases,
    log,
    /** Simulate the database becoming unreachable for every transaction (a dead process renews nothing). */
    setTransactionsFailing(value: boolean) { renewalsFailing = value },
    lease(scope: string) { return leases.get(scope) },
    intentRows() { return [...intents.entries()] },
    /** R-69 I6a: the project-sheet registry rows (sheet id → row); mutate to archive / re-register / remove. */
    projectTargets,
    /** R-69 I6a: every registry read throws this SQLSTATE (anything but 42P01 is "unreadable"); null restores. */
    setRegistryUnreadable(code: string | null) { registryError = code ? Object.assign(new Error('fake db: registry unreadable'), { code }) : null },
  }
}
