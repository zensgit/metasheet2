// B1b capability spike — automated gate-check (X-5).
//
// Reads the evidence records the two engine probes wrote (spike-b1b-mysql.ts,
// spike-b1b-sqlserver.ts) and computes an open/non-open verdict per
// (dialect, engineMajorVersion, capabilityPosture) — the certification unit (§1.4). This is
// the ENFORCEMENT point: an outcome is read by this machine, never by a human reading a
// console log (battery §1.2). §4 step 3 (the real certification gate) is expected to cite
// THIS verdict, not re-derive it.
//
// EVIDENCE ONLY: computing "would this open the gate" is not the same as opening it. Nothing
// here writes to any registry, certificate, or runtime config.
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  B1B_OUTCOME_TOKENS,
  assertValidSpikeRecord,
  type Dialect,
  type OutcomeToken,
  type SpikeRecord,
} from './spike-b1b-shared'

export interface GateCell {
  readonly dialect: Dialect
  readonly engineMajorVersion: string
  readonly capabilityPosture: string
}

export interface GateVerdict extends GateCell {
  readonly open: boolean
  // The record's own outcome token, or 'ABSENT' when no record exists for this cell. Closed,
  // values-free — never a fabricated or interpolated reason string (this line's own rule:
  // an audit surface must not fabricate).
  readonly reason: OutcomeToken | 'ABSENT'
}

// The ONLY two tokens that open anything (§1.4, §3). Everything else — including a token this
// module has never seen — is non-open. Naming the set explicitly (rather than "== 'PROVEN'
// suffix") keeps this closed against a future token that merely CONTAINS the word PROVEN in a
// different sense.
const OPENING_TOKENS: ReadonlySet<OutcomeToken> = new Set([
  'MYSQL_PRECONDITIONS_PROVEN',
  'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN',
])

function cellKey(cell: GateCell): string {
  return `${cell.dialect}::${cell.engineMajorVersion}::${cell.capabilityPosture}`
}

const GATE_CELL_KEYS: ReadonlySet<string> = new Set(['dialect', 'engineMajorVersion', 'capabilityPosture'])

function assertValidGateCell(cell: unknown): asserts cell is GateCell {
  if (typeof cell !== 'object' || cell === null || Array.isArray(cell)) {
    throw new Error('spike-b1b-gate-check: each declared cell must be a plain object')
  }
  let prototype: object | null
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(cell)
    keys = Reflect.ownKeys(cell)
  } catch {
    throw new Error('spike-b1b-gate-check: declared cell shape is not inspectable')
  }
  if (prototype !== Object.prototype) {
    throw new Error('spike-b1b-gate-check: each declared cell must use the ordinary object prototype')
  }
  if (keys.length !== GATE_CELL_KEYS.size || keys.some(key => typeof key !== 'string' || !GATE_CELL_KEYS.has(key))) {
    throw new Error('spike-b1b-gate-check: declared cell fields must exactly match the closed schema')
  }
  const candidate = cell as Record<string, unknown>
  if (candidate.dialect !== 'mysql' && candidate.dialect !== 'sqlserver') {
    throw new Error('spike-b1b-gate-check: declared cell uses an unknown dialect')
  }
  for (const field of ['engineMajorVersion', 'capabilityPosture'] as const) {
    const value = candidate[field]
    if (typeof value !== 'string' || value.length < 1 || value.length > 64 || !/^[A-Za-z0-9._-]+$/.test(value)) {
      throw new Error(`spike-b1b-gate-check: declared cell ${field} must be a bounded identifier`)
    }
  }
  if (
    (candidate.dialect === 'mysql' && candidate.capabilityPosture !== 'default') ||
    (candidate.dialect === 'sqlserver' &&
      candidate.capabilityPosture !== 'default_rc_no_rcsi' &&
      candidate.capabilityPosture !== 'rcsi_on')
  ) {
    throw new Error('spike-b1b-gate-check: declared cell uses an unsupported capability posture')
  }
}

// Pure — no filesystem, no process. This is the function CP-7 exercises directly with
// synthetic records; the CLI below is a thin, untested-by-CP-7 shell around it.
export function computeGateVerdict(records: readonly SpikeRecord[], declaredCells: readonly GateCell[]): GateVerdict[] {
  if (!Array.isArray(records) || !Array.isArray(declaredCells) || declaredCells.length === 0) {
    throw new Error('spike-b1b-gate-check: at least one declared cell is required')
  }

  const declaredByKey = new Map<string, GateCell>()
  for (const cell of declaredCells) {
    assertValidGateCell(cell)
    const key = cellKey(cell)
    if (declaredByKey.has(key)) {
      throw new Error(`spike-b1b-gate-check: declared cell appears more than once: ${key}`)
    }
    declaredByKey.set(key, cell)
  }

  const recordsByKey = new Map<string, SpikeRecord>()
  for (const record of records) {
    assertValidSpikeRecord(record)
    const key = cellKey(record)
    if (!declaredByKey.has(key)) {
      throw new Error(`spike-b1b-gate-check: evidence record belongs to an undeclared cell: ${key}`)
    }
    if (recordsByKey.has(key)) {
      throw new Error(`spike-b1b-gate-check: multiple records for one cell: ${key}`)
    }
    recordsByKey.set(key, record)
  }

  return declaredCells.map(cell => {
    const key = cellKey(cell)
    const record = recordsByKey.get(key)
    if (!record) {
      return { ...cell, open: false, reason: 'ABSENT' }
    }
    const opens = OPENING_TOKENS.has(record.outcome)
    // Control-inversion gate (§1.3, generalized to THIS gate-check): an OPENING outcome whose
    // own counts show controls did NOT fully invert (some ran but failed, or none ran at all)
    // is internally inconsistent evidence — a synthetic or corrupted record could claim
    // MYSQL_PRECONDITIONS_PROVEN with controlsInverted=0/controlsTotal=0 and, before this
    // check, this function would still report open=true. Never silently resolved (same
    // discipline as the "multiple records" ambiguity above) — malformed/inconsistent evidence
    // throws rather than opening. A record produced by a REAL, uncorrupted run can never trip
    // this: spike-b1b-mysql.ts/spike-b1b-sqlserver.ts both call log.assertAllPassed() before
    // reaching an opening outcome. A failed control is persisted as INCONCLUSIVE and the job
    // then fails; only a genuine green run can emit an opening token.
    if (opens && (record.controlsTotal < 1 || record.controlsInverted !== record.controlsTotal)) {
      throw new Error(
        `spike-b1b-gate-check: record for ${key} claims opening outcome "${record.outcome}" but its ` +
          `own counts show controls did not fully invert (controlsInverted=${record.controlsInverted}, ` +
          `controlsTotal=${record.controlsTotal}) — refusing to open on internally inconsistent evidence`
      )
    }
    return { ...cell, open: opens, reason: record.outcome }
  })
}

export function readEvidenceRecords(evidenceDir: string): SpikeRecord[] {
  if (!fs.existsSync(evidenceDir)) {
    return []
  }
  const files = fs.readdirSync(evidenceDir).filter(name => name.endsWith('.json'))
  return files.map(name => {
    const raw = fs.readFileSync(path.join(evidenceDir, name), 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`spike-b1b-gate-check: ${name} is not valid JSON: ${(error as Error).message}`)
    }
    assertValidSpikeRecord(parsed)
    return parsed
  })
}

function printHelp(): void {
  console.log(`Usage: tsx scripts/spike-b1b-gate-check.ts --evidence-dir <dir> --declared-cells <json>

Computes open/non-open per (dialect, engineMajorVersion, capabilityPosture) from the evidence
records written by spike-b1b-mysql.ts / spike-b1b-sqlserver.ts. EVIDENCE ONLY — never opens
anything itself; §4 step 3 (behind the owner) is expected to cite this verdict.

--evidence-dir <dir>     directory of *.json SpikeRecord files (default: B1B_EVIDENCE_DIR env)
--declared-cells <json>  JSON array of {dialect, engineMajorVersion, capabilityPosture}
                         (default: B1B_DECLARED_CELLS env, JSON-encoded)

Exit code is decoupled from the verdict (battery §1.3): 0 for any successfully COMPUTED
verdict set (open or non-open alike) — a non-open verdict is the expected, successful shape
for this spike, not a failure. Non-zero only for malformed or ambiguous input: unreadable
evidence, a record outside the closed schema or declared cell set, duplicate cells/records,
or an opening token whose proof qualifiers and control counts are incomplete.

Frozen vocabulary: ${B1B_OUTCOME_TOKENS.join(', ')}`)
}

function main(): void {
  if (process.argv.includes('--help')) {
    printHelp()
    return
  }
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const evidenceDir = flag('--evidence-dir') ?? process.env.B1B_EVIDENCE_DIR
  const declaredCellsRaw = flag('--declared-cells') ?? process.env.B1B_DECLARED_CELLS
  if (!evidenceDir) {
    throw new Error('spike-b1b-gate-check: --evidence-dir (or B1B_EVIDENCE_DIR) is required')
  }
  if (!declaredCellsRaw) {
    throw new Error('spike-b1b-gate-check: --declared-cells (or B1B_DECLARED_CELLS) is required')
  }
  const declaredCells = JSON.parse(declaredCellsRaw) as GateCell[]
  const records = readEvidenceRecords(evidenceDir)
  const verdicts = computeGateVerdict(records, declaredCells)

  console.log('[b1b-gate-check] verdicts (EVIDENCE ONLY — this does not itself open anything):')
  for (const verdict of verdicts) {
    console.log(`  ${cellKey(verdict)}  open=${verdict.open}  reason=${verdict.reason}`)
  }
  const anyOpen = verdicts.some(verdict => verdict.open)
  console.log(
    anyOpen
      ? '[b1b-gate-check] at least one cell verdict is OPEN — §4 step 3 still requires the owner.'
      : '[b1b-gate-check] no cell verdict is open — non-opening run (REFUSED/UNOBTAINABLE/INCONCLUSIVE/ABSENT).'
  )

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    const rows = verdicts
      .map(verdict => `| ${verdict.dialect} | ${verdict.engineMajorVersion} | ${verdict.capabilityPosture} | ${verdict.open} | ${verdict.reason} |`)
      .join('\n')
    fs.appendFileSync(
      summaryPath,
      `\n### B1b capability spike — gate-check verdict (EVIDENCE ONLY)\n\n` +
        `| dialect | engineMajorVersion | capabilityPosture | open | reason |\n|---|---|---|---|---|\n${rows}\n`
    )
  }
  // §1.3, generalized to the gate-check itself: a successfully COMPUTED non-open verdict is
  // not a failure. Only malformed input (thrown above, before this point) reds the step.
}

const entryUrl = process.argv[1] ? new URL(`file://${path.resolve(process.argv[1])}`).href : ''
if (import.meta.url === entryUrl) {
  try {
    main()
  } catch (error) {
    console.error('[b1b-gate-check] FAILED (malformed evidence or declared-cell input)')
    console.error(error)
    process.exitCode = 1
  }
}
