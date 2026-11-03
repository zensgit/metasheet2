/**
 * Process policy for the DingTalk login repair CLI. Pure: imports only the code lists, never the
 * database, the pool or the repair module, so the entry script can refuse before any pool exists.
 */
import { REPAIR_CLI_CODES, REPAIR_REFUSAL_CODES } from './dingtalk-identity-repair-codes'

/** The CLI's client read timeout must exceed the server budget so the server's 57014 ends a stuck statement first. */
export const REPAIR_CLI_QUERY_TIMEOUT_FLOOR_MS = 45000
const PRINTABLE: ReadonlySet<string> = new Set<string>([...REPAIR_REFUSAL_CODES, ...REPAIR_CLI_CODES])

/** Same parse as connection-pool.ts (parseInt base 10), so the gate evaluates what the pool will actually hold. */
const parsePositiveInt = (raw: string | undefined, fallback: number): number | null => {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function resolveRepairClientTimeout(
  env: NodeJS.ProcessEnv,
):
  | { ok: true; value: number; floor: number; explicit: boolean }
  | { ok: false; code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' } {
  const statement = parsePositiveInt(env.DB_STATEMENT_TIMEOUT, 30000)
  // Unparsable server budget: no floor can be established.
  if (statement === null) return { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }
  const floor = Math.max(REPAIR_CLI_QUERY_TIMEOUT_FLOOR_MS, statement + 15000)
  const raw = env.DB_QUERY_TIMEOUT
  if (raw === undefined || raw.trim() === '') return { ok: true, value: floor, floor, explicit: false }
  const value = parsePositiveInt(raw, 0)
  // An explicit lower or unparsable value refuses; it is never overridden.
  if (value === null || value < floor) return { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }
  return { ok: true, value, floor, explicit: true }
}

/** Maps any failure to one fixed code and an exit status. No message text, stack, SQL or identifier leaves. */
export function classifyRepairFailure(e: unknown): { code: string; exit: number } {
  const message = e instanceof Error ? e.message : ''
  const sqlstate = (e as { code?: unknown } | null)?.code
  // EX_TEMPFAIL: nothing written; check the blocker, re-preview, retry once by hand.
  if (message === 'REPAIR_LOCK_BUSY') return { code: message, exit: 75 }
  if (PRINTABLE.has(message)) return { code: message, exit: 1 }
  // pg client read timeout (no SQLSTATE): the outcome is unknown; never retry blindly. EX_UNAVAILABLE.
  if (message === 'Query read timeout') return { code: 'REPAIR_CLIENT_TIMEOUT', exit: 69 }
  // Server cancel outside lock(); the transaction wrapper rolled back.
  if (sqlstate === '57014') return { code: 'REPAIR_STATEMENT_TIMEOUT', exit: 1 }
  return { code: 'DINGTALK_LOGIN_REPAIR_REFUSED', exit: 1 }
}

export type RepairMain = {
  effectiveClientQueryTimeoutMs(): number | null
  run(argv: string[]): Promise<unknown>
}

export async function runRepairCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: { load: () => Promise<RepairMain>; stdout(s: string): void; stderr(s: string): void },
): Promise<number> {
  const t = resolveRepairClientTimeout(env)
  // No pool has been constructed and no connection attempted. (`in` narrows without strictNullChecks.)
  if ('code' in t) {
    io.stderr(t.code)
    return 1
  }
  if (!t.explicit) env.DB_QUERY_TIMEOUT = String(t.value)
  let main: RepairMain
  try {
    // The first evaluation of the connection pool happens inside load(), after the preset above.
    main = await io.load()
  } catch {
    io.stderr('DINGTALK_LOGIN_REPAIR_REFUSED')
    return 1
  }
  try {
    // What the pool actually holds, asserted before any argument, file or database work.
    const effective = main.effectiveClientQueryTimeoutMs()
    if (typeof effective !== 'number' || !(effective >= t.floor)) throw new Error('REPAIR_CLIENT_TIMEOUT_TOO_LOW')
    const result = await main.run(argv)
    io.stdout(JSON.stringify({ ...(result as Record<string, unknown>), clientQueryTimeoutMs: effective }))
    return 0
  } catch (e) {
    const { code, exit } = classifyRepairFailure(e)
    io.stderr(code)
    return exit
  }
}
