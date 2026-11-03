/**
 * Attendance settlement coordination — the S1 and S2 statements (implementation lock appendix E).
 *
 * S1 runs on a freshly borrowed connection in autocommit: idle proof, then a shared try on the
 * dedicated key, then (canonical orgs only) a shared try on the class-00 key, and an in-statement
 * undo of the dedicated key when only the second family failed. S2 is the first snapshot-taking
 * statement after `BEGIN`: transaction-level shared tries on the same keys (a re-grant, since the
 * session still holds them), then the session-level unlocks, then the per-entry `set_config`s.
 *
 * Both statements must go over the SIMPLE query protocol, so they carry no bind parameters: every
 * key is an integer computed by code and inlined as a literal, and each literal is checked
 * against `^-?\d+$` before formatting. Every layer is an `OFFSET 0` subquery so the planner cannot
 * pull it up, and each later lock call sits inside a CASE over the previous layer's result, so
 * every volatile call runs at most once and in data-dependency order. Neither statement reads
 * `pg_locks`.
 *
 * Integer literals are wrapped in parentheses and cast (`(k2)::int4`, `(c00)::bigint`). The cast is
 * defensive: it pins the argument types that select the two-int4 or the single-bigint advisory
 * function independently of how the parser types a bare literal (PostgreSQL itself folds a bare
 * `-2147483648` back to int4).
 */
import {
  W4_TRANSACTION_LOCK_TIMEOUT_MS,
  W4_TRANSACTION_STATEMENT_TIMEOUT_MS,
} from '../w4c0-operation-contract'
import { AttendanceCoordinationKeyError, SETTLEMENT_COORDINATION_KEY1 } from './settlement-coordination-key'

const INTEGER_LITERAL = /^-?\d+$/
const ENTRY_LABEL = /^[a-z0-9_.-]{1,40}$/
const INT4_MIN = -2147483648
const INT4_MAX = 2147483647

function integerLiteral(value: number | bigint, code: string): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new AttendanceCoordinationKeyError(code)
  if (typeof value !== 'number' && typeof value !== 'bigint') throw new AttendanceCoordinationKeyError(code)
  const text = value.toString()
  if (!INTEGER_LITERAL.test(text)) throw new AttendanceCoordinationKeyError(code)
  return text
}

function int4Literal(value: number): string {
  if (typeof value !== 'number' || value < INT4_MIN || value > INT4_MAX) {
    throw new AttendanceCoordinationKeyError('ATTENDANCE_COORDINATION_KEY_LITERAL_INVALID')
  }
  return `(${integerLiteral(value, 'ATTENDANCE_COORDINATION_KEY_LITERAL_INVALID')})::int4`
}

function bigintLiteral(value: bigint): string {
  if (typeof value !== 'bigint') throw new AttendanceCoordinationKeyError('ATTENDANCE_COORDINATION_KEY_LITERAL_INVALID')
  return `(${integerLiteral(value, 'ATTENDANCE_COORDINATION_KEY_LITERAL_INVALID')})::bigint`
}

export interface SettlementCoordinationStatementKeysV1 {
  /** Dedicated key2 (signed int4). */
  readonly key2: number
  /** Class-00 key for canonical orgs whose entry needs that family; `null` drops the layer. */
  readonly classZeroKey: bigint | null
}

const KEY1_LITERAL = `(${SETTLEMENT_COORDINATION_KEY1})::int4`

/** S1: idle proof + two-family shared try + in-statement undo. Columns: idle, k_ok, c_ok, k_undo. */
export function buildSettlementCoordinationS1Sql(keys: SettlementCoordinationStatementKeysV1): string {
  const k2 = int4Literal(keys.key2)
  if (keys.classZeroKey === null) {
    return [
      'SELECT idle, k_ok, true AS c_ok, NULL::boolean AS k_undo',
      `  FROM (SELECT idle, CASE WHEN idle THEN pg_try_advisory_lock_shared(${KEY1_LITERAL}, ${k2}) END AS k_ok`,
      '          FROM (SELECT now() = statement_timestamp() AS idle OFFSET 0) p',
      '        OFFSET 0) a',
    ].join('\n')
  }
  const c00 = bigintLiteral(keys.classZeroKey)
  return [
    'SELECT idle, k_ok, c_ok,',
    `       CASE WHEN k_ok AND c_ok IS NOT TRUE THEN pg_advisory_unlock_shared(${KEY1_LITERAL}, ${k2}) END AS k_undo`,
    '  FROM (SELECT idle, k_ok,',
    `               CASE WHEN k_ok THEN pg_try_advisory_lock_shared(${c00}) END AS c_ok`,
    '          FROM (SELECT idle,',
    `                       CASE WHEN idle THEN pg_try_advisory_lock_shared(${KEY1_LITERAL}, ${k2}) END AS k_ok`,
    '                  FROM (SELECT now() = statement_timestamp() AS idle OFFSET 0) p',
    '                OFFSET 0) a',
    '        OFFSET 0) b',
  ].join('\n')
}

/**
 * Per-entry session settings set inside S2 (transaction-local):
 *   - `w4-runner`: entries that run through the W4 runner today — both W4 timeouts;
 *   - `lock-timeout-only`: entries registered with a lock timeout (M07, C4-27, C4-28 take
 *     `W4_TRANSACTION_LOCK_TIMEOUT_MS`; admin close takes its registered value) — no
 *     `statement_timeout`;
 *   - `none`: every other entry keeps today's session settings.
 */
export type SettlementCoordinationS2TimeoutsV1 =
  | Readonly<{ kind: 'w4-runner' }>
  | Readonly<{ kind: 'lock-timeout-only'; lockTimeoutMs: number }>
  | Readonly<{ kind: 'none' }>

export interface SettlementCoordinationS2OptionsV1 extends SettlementCoordinationStatementKeysV1 {
  readonly timeouts: SettlementCoordinationS2TimeoutsV1
  /** Entry label from the appendix D registration; becomes `application_name = ms2-coord:<label>`. */
  readonly entryLabel: string
}

function timeoutLiteral(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 1) throw new AttendanceCoordinationKeyError('ATTENDANCE_COORDINATION_TIMEOUT_INVALID')
  return integerLiteral(ms, 'ATTENDANCE_COORDINATION_TIMEOUT_INVALID')
}

function settingColumns(options: SettlementCoordinationS2OptionsV1): string[] {
  if (typeof options.entryLabel !== 'string' || !ENTRY_LABEL.test(options.entryLabel)) {
    throw new AttendanceCoordinationKeyError('ATTENDANCE_COORDINATION_ENTRY_LABEL_INVALID')
  }
  const columns: string[] = []
  const timeouts = options.timeouts
  if (timeouts.kind === 'w4-runner') {
    columns.push(`set_config('statement_timeout', '${timeoutLiteral(W4_TRANSACTION_STATEMENT_TIMEOUT_MS)}', true) AS st`)
    columns.push(`set_config('lock_timeout', '${timeoutLiteral(W4_TRANSACTION_LOCK_TIMEOUT_MS)}', true) AS lt`)
  } else if (timeouts.kind === 'lock-timeout-only') {
    columns.push(`set_config('lock_timeout', '${timeoutLiteral(timeouts.lockTimeoutMs)}', true) AS lt`)
  } else if (timeouts.kind !== 'none') {
    throw new AttendanceCoordinationKeyError('ATTENDANCE_COORDINATION_TIMEOUT_INVALID')
  }
  columns.push(`set_config('application_name', 'ms2-coord:${options.entryLabel}', true) AS an`)
  return columns
}

/** S2: transaction-level re-grant + session unlocks + settings. Columns: x_k, x_c, u_k, u_c, [st], [lt], an. */
export function buildSettlementCoordinationS2Sql(options: SettlementCoordinationS2OptionsV1): string {
  const k2 = int4Literal(options.key2)
  const settings = settingColumns(options)
  if (options.classZeroKey === null) {
    return [
      'SELECT x_k, true AS x_c,',
      `       CASE WHEN x_k THEN pg_advisory_unlock_shared(${KEY1_LITERAL}, ${k2}) END AS u_k,`,
      '       true AS u_c,',
      `       ${settings.join(',\n       ')}`,
      `  FROM (SELECT pg_try_advisory_xact_lock_shared(${KEY1_LITERAL}, ${k2}) AS x_k OFFSET 0) s1`,
    ].join('\n')
  }
  const c00 = bigintLiteral(options.classZeroKey)
  return [
    'SELECT x_k, x_c,',
    `       CASE WHEN x_k AND x_c THEN pg_advisory_unlock_shared(${KEY1_LITERAL}, ${k2}) END AS u_k,`,
    `       CASE WHEN x_k AND x_c THEN pg_advisory_unlock_shared(${c00}) END AS u_c,`,
    `       ${settings.join(',\n       ')}`,
    `  FROM (SELECT x_k, CASE WHEN x_k THEN pg_try_advisory_xact_lock_shared(${c00}) END AS x_c`,
    `          FROM (SELECT pg_try_advisory_xact_lock_shared(${KEY1_LITERAL}, ${k2}) AS x_k OFFSET 0) s1`,
    '        OFFSET 0) s2',
  ].join('\n')
}

/** Cleanup: release exactly the session-level shared locks this unit holds. Columns: u_k, u_c. */
export function buildSettlementCoordinationSessionUnlockSql(keys: SettlementCoordinationStatementKeysV1): string {
  const k2 = int4Literal(keys.key2)
  if (keys.classZeroKey === null) {
    return `SELECT pg_advisory_unlock_shared(${KEY1_LITERAL}, ${k2}) AS u_k, true AS u_c`
  }
  const c00 = bigintLiteral(keys.classZeroKey)
  // Release order mirrors acquisition in reverse: class-00 first, then the dedicated key.
  return [
    'SELECT u_k, u_c',
    `  FROM (SELECT u_c, pg_advisory_unlock_shared(${KEY1_LITERAL}, ${k2}) AS u_k`,
    `          FROM (SELECT pg_advisory_unlock_shared(${c00}) AS u_c OFFSET 0) c`,
    '        OFFSET 0) k',
  ].join('\n')
}
