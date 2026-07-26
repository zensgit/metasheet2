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
  isOutcomeToken,
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

// Pure — no filesystem, no process. This is the function CP-7 exercises directly with
// synthetic records; the CLI below is a thin, untested-by-CP-7 shell around it.
export function computeGateVerdict(
  records: readonly SpikeRecord[],
  declaredCells: readonly GateCell[]
): GateVerdict[] {
  if (declaredCells.length === 0) {
    throw new Error('spike-b1b-gate-check: at least one declared cell is required')
  }
  return declaredCells.map(cell => {
    const matches = records.filter(
      record =>
        record.dialect === cell.dialect &&
        record.engineMajorVersion === cell.engineMajorVersion &&
        record.capabilityPosture === cell.capabilityPosture
    )
    if (matches.length === 0) {
      return { ...cell, open: false, reason: 'ABSENT' }
    }
    if (matches.length > 1) {
      // Ambiguous evidence for one certification unit is itself an incompleteness (§1.3) —
      // never silently pick one; the CLI wrapper turns this into a non-zero exit.
      throw new Error(`spike-b1b-gate-check: multiple records for one cell: ${cellKey(cell)}`)
    }
    const record = matches[0]
    assertValidSpikeRecord(record)
    return { ...cell, open: OPENING_TOKENS.has(record.outcome), reason: record.outcome }
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
    const record = parsed as SpikeRecord
    if (!isOutcomeToken(record.outcome)) {
      throw new Error(`spike-b1b-gate-check: ${name} carries an outcome outside the frozen vocabulary`)
    }
    assertValidSpikeRecord(record)
    return record
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
for this spike, not a failure. Non-zero only for malformed input: unreadable evidence, a
token outside the frozen vocabulary, or more than one record for one cell.

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
