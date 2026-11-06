/**
 * Process policy for the DingTalk login repair CLI. Pure: imports only the code lists, never the
 * database, the pool or the repair module, so the entry script can refuse before any pool exists.
 */
import { REPAIR_CLI_CODES, REPAIR_REFUSAL_CODES } from './dingtalk-identity-repair-codes'

/** The CLI's client read timeout must exceed the server budget so the server's 57014 ends a stuck statement first. */
export const REPAIR_CLI_QUERY_TIMEOUT_FLOOR_MS = 45000
/**
 * pg arms the client read timeout with setTimeout(); Node turns any delay above 2^31-1 ms into 1 ms,
 * so a larger value would end every query at once. Neither the explicit value nor the floor may exceed it.
 */
export const REPAIR_CLI_QUERY_TIMEOUT_MAX_MS = 2147483647
const PRINTABLE: ReadonlySet<string> = new Set<string>([...REPAIR_REFUSAL_CODES, ...REPAIR_CLI_CODES])

/** Same parse as connection-pool.ts (parseInt base 10), so the gate evaluates what the pool will actually hold. */
const parsePositiveInt = (raw: string | undefined, fallback: number): number | null => {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Environment gate, before the pool exists: refuses early and presets DB_QUERY_TIMEOUT. It cannot see
 * DATABASE_URL parameters, so resolveEffectiveRepairTimeout decides on the final values after load.
 */
export function resolveRepairClientTimeout(
  env: NodeJS.ProcessEnv,
):
  | { ok: true; value: number; floor: number; explicit: boolean }
  | { ok: false; code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' | 'REPAIR_CLIENT_TIMEOUT_TOO_HIGH' } {
  const statement = parsePositiveInt(env.DB_STATEMENT_TIMEOUT, 30000)
  // Unparsable server budget: no floor can be established.
  if (statement === null) return { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }
  const floor = Math.max(REPAIR_CLI_QUERY_TIMEOUT_FLOOR_MS, statement + 15000)
  // A server budget this large leaves no client timeout that both exceeds it and can be armed.
  if (floor > REPAIR_CLI_QUERY_TIMEOUT_MAX_MS) return { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_HIGH' }
  const raw = env.DB_QUERY_TIMEOUT
  if (raw === undefined || raw.trim() === '') return { ok: true, value: floor, floor, explicit: false }
  const value = parsePositiveInt(raw, 0)
  // An explicit lower or unparsable value refuses; it is never overridden.
  if (value === null || value < floor) return { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }
  if (value > REPAIR_CLI_QUERY_TIMEOUT_MAX_MS) return { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_HIGH' }
  return { ok: true, value, floor, explicit: true }
}

/**
 * The parameters every connection of a pool really uses, as pg derives them. pg-pool builds each client as
 * `new Client(pool.options)`, and pg's ConnectionParameters merges the parsed connection string over those
 * options, so a DATABASE_URL parameter (`?query_timeout=`, `?statement_timeout=`, `?options=-c ...`) or
 * PGOPTIONS replaces what the pool options say.
 */
export type RepairEffectiveConnection = {
  /** client.connectionParameters.query_timeout: the read timer pg arms for every query that names none itself. */
  queryTimeout: unknown
  /** client.getStartupConf(): the startup packet pg sends (statement_timeout and options among it). */
  startup: unknown
}

type PoolLike = {
  Client: new (options: unknown) => { connectionParameters?: { query_timeout?: unknown }; getStartupConf?: () => unknown }
  options: unknown
}

/** Builds a client exactly the way the pool does and reads its parameters. Nothing connects. */
export function readPoolConnection(pool: PoolLike): RepairEffectiveConnection {
  const client = new pool.Client(pool.options)
  return {
    queryTimeout: client.connectionParameters?.query_timeout,
    startup: typeof client.getStartupConf === 'function' ? client.getStartupConf() : null,
  }
}

/**
 * statement_timeout as the server applies it, read only from pg's own startup field. PostgreSQL applies the
 * startup `options` string first and the startup parameters after it, so an explicit statement_timeout
 * parameter wins over every options spelling (and over role or database settings); options are never read
 * for the budget. A missing or empty value falls back to a role or database default (or none) and zero
 * disables it; a negative or non-numeric value makes the server reject the connection (22023). None of
 * these gives a known budget, so all are refused before connecting. Startup fields are NUL-terminated on the wire, so a NUL inside any key or value would
 * add a key the server applies after pg's own (seen as one value here, another on the server): refused.
 */
function serverStatementTimeoutMs(startup: Record<string, unknown>): number | null {
  for (const [key, value] of Object.entries(startup)) {
    // pg writes each value with addCString: a string, or nothing for a falsy value; anything else is unreadable.
    if (key.includes('\0') || (value !== undefined && value !== null && typeof value !== 'string')) return null
    if (typeof value === 'string' && value.includes('\0')) return null
  }
  const sent = startup.statement_timeout
  // pg sends String(parseInt(value, 10)); "NaN", "0" or a negative value gives no usable server budget.
  return typeof sent === 'string' && /^\d+$/.test(sent) && Number(sent) > 0 ? Number(sent) : null
}

/**
 * The gate on the final parameters: the server budget every connection gets, the floor derived from it, and
 * the read timer pg arms (Node coerces the delay with `* 1` and arms anything outside 1..2^31-1 as 1 ms;
 * pg arms no timer at all for a falsy value). Refuses with the same two codes as the environment gate.
 */
export function resolveEffectiveRepairTimeout(
  connection: RepairEffectiveConnection | null | undefined,
):
  | { ok: true; clientQueryTimeoutMs: number; serverStatementTimeoutMs: number; floor: number }
  | { ok: false; code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' | 'REPAIR_CLIENT_TIMEOUT_TOO_HIGH' } {
  const startup = connection?.startup
  if (!startup || typeof startup !== 'object') return { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }
  const server = serverStatementTimeoutMs(startup as Record<string, unknown>)
  if (server === null) return { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }
  const floor = Math.max(REPAIR_CLI_QUERY_TIMEOUT_FLOOR_MS, server + 15000)
  if (floor > REPAIR_CLI_QUERY_TIMEOUT_MAX_MS) return { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_HIGH' }
  const raw = connection?.queryTimeout
  // Falsy: pg arms no read timer, so a stuck connection would wait forever.
  if (!raw || (typeof raw !== 'number' && typeof raw !== 'string')) return { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }
  const value = Number(raw)
  if (Number.isNaN(value)) return { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }
  if (value > REPAIR_CLI_QUERY_TIMEOUT_MAX_MS) return { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_HIGH' }
  if (value < floor) return { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }
  return { ok: true, clientQueryTimeoutMs: value, serverStatementTimeoutMs: server, floor }
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

/** The part of a Node process the output guard takes over (a fake in unit tests). */
export type RepairProcess = {
  stdout: { write(chunk: unknown, ...rest: unknown[]): boolean }
  stderr: { write(chunk: unknown, ...rest: unknown[]): boolean }
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (e: unknown) => void): unknown
  exit(code: number): void
}

export type RepairProcessOutput = {
  stdout(s: string): void
  stderr(s: string): void
  /** Writes the one recorded line, then exits with the status. Later calls are ignored. */
  exit(code: number): void
  /** A failure nobody awaited (e.g. a pg client 'error' event): classified like any run failure. */
  crash(e: unknown): void
}

/**
 * Takes over the process streams for the CLI. Every other writer (the winston Console transport,
 * console.*, library warnings) is discarded from here on, so stdout carries only the final JSON and
 * stderr only one fixed code. An uncaught exception or unhandled rejection prints a fixed code instead
 * of Node's stack trace. Call before loading anything that can log.
 */
export function guardRepairProcess(proc: RepairProcess): RepairProcessOutput {
  const write = { out: proc.stdout.write.bind(proc.stdout), err: proc.stderr.write.bind(proc.stderr) }
  const discard = (...args: unknown[]): boolean => {
    const callback = args.find((a): a is () => void => typeof a === 'function')
    if (callback) queueMicrotask(callback)
    return true
  }
  proc.stdout.write = discard
  proc.stderr.write = discard
  let line: { to: 'out' | 'err'; text: string } | null = null
  let exiting = false
  const record = (to: 'out' | 'err', text: string) => {
    if (!line) line = { to, text }
  }
  const exit = (code: number) => {
    if (exiting) return
    exiting = true
    if (!line) return proc.exit(code)
    const writer = line.to === 'out' ? write.out : write.err
    writer(line.text + '\n', () => proc.exit(code))
  }
  const crash = (e: unknown) => {
    // A line already recorded means runRepairCli has decided; its own exit follows in the same tick.
    if (exiting || line) return
    const { code, exit: status } = classifyRepairFailure(e)
    record('err', code)
    exit(status)
  }
  proc.on('uncaughtException', crash)
  proc.on('unhandledRejection', crash)
  return { stdout: (s) => record('out', s), stderr: (s) => record('err', s), exit, crash }
}

export type RepairMain = {
  /** The parameters every connection of the CLI's pool will use (readPoolConnection on that pool). */
  effectiveConnection(): RepairEffectiveConnection
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
    // What every connection will actually use (DATABASE_URL overrides included), asserted before any
    // argument, file or database work. The pool has not connected yet.
    const effective = resolveEffectiveRepairTimeout(main.effectiveConnection())
    if ('code' in effective) throw new Error(effective.code)
    const result = await main.run(argv)
    io.stdout(JSON.stringify({ ...(result as Record<string, unknown>), clientQueryTimeoutMs: effective.clientQueryTimeoutMs }))
    return 0
  } catch (e) {
    const { code, exit } = classifyRepairFailure(e)
    io.stderr(code)
    return exit
  }
}
