// B1c SQL Server snapshot page-sequence evidence gate.
//
// This computes a values-free evidence verdict. It does not certify a profile, register an
// executor, activate a binding, or authorize runtime/deployment work.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isProxy } from 'node:util/types'
import {
  B1C_CAPABILITY_POSTURE,
  assertValidB1cSqlServerEvidenceRecord,
  type B1cSqlServerEvidenceRecord,
  type B1cSqlServerOutcome,
} from './spike-b1c-shared'

export interface B1cGateCell {
  readonly dialect: 'sqlserver'
  readonly engineMajorVersion: '2019' | '2022'
  readonly capabilityPosture: typeof B1C_CAPABILITY_POSTURE
}

export interface B1cGateVerdict extends B1cGateCell {
  readonly evidencePresent: boolean
  readonly proven: boolean
  readonly reason: B1cSqlServerOutcome | 'ABSENT'
}

const CELL_KEYS = Object.freeze([
  'dialect',
  'engineMajorVersion',
  'capabilityPosture',
] as const)

function assertGateCell(value: unknown): asserts value is B1cGateCell {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      'spike-b1c-gate-check: each declared cell must be a plain object',
    )
  }
  if (isProxy(value)) {
    throw new Error('spike-b1c-gate-check: declared cell must not be a Proxy')
  }
  let prototype: object | null
  let keys: readonly PropertyKey[]
  let descriptors: PropertyDescriptorMap
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    throw new Error(
      'spike-b1c-gate-check: declared cell shape is not inspectable',
    )
  }
  if (prototype !== Object.prototype) {
    throw new Error(
      'spike-b1c-gate-check: declared cell must use the ordinary object prototype',
    )
  }
  if (
    keys.length !== CELL_KEYS.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !CELL_KEYS.includes(key as (typeof CELL_KEYS)[number]),
    )
  ) {
    throw new Error(
      'spike-b1c-gate-check: declared cell fields must exactly match the closed schema',
    )
  }
  for (const key of CELL_KEYS) {
    const descriptor = descriptors[key]
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(
        'spike-b1c-gate-check: declared cell fields must be enumerable data properties',
      )
    }
  }
  const cell = value as unknown as B1cGateCell
  if (cell.dialect !== 'sqlserver') {
    throw new Error(
      'spike-b1c-gate-check: only sqlserver is declared for this spike',
    )
  }
  if (
    cell.engineMajorVersion !== '2019' &&
    cell.engineMajorVersion !== '2022'
  ) {
    throw new Error(
      'spike-b1c-gate-check: undeclared SQL Server engine version',
    )
  }
  if (cell.capabilityPosture !== B1C_CAPABILITY_POSTURE) {
    throw new Error('spike-b1c-gate-check: undeclared capability posture')
  }
}

function cellKey(cell: B1cGateCell): string {
  return `${cell.dialect}/${cell.engineMajorVersion}/${cell.capabilityPosture}`
}

export function computeB1cGateVerdicts(
  records: readonly B1cSqlServerEvidenceRecord[],
  declaredCells: readonly B1cGateCell[],
): B1cGateVerdict[] {
  if (declaredCells.length === 0) {
    throw new Error(
      'spike-b1c-gate-check: at least one declared cell is required',
    )
  }
  const declared = new Map<string, B1cGateCell>()
  for (const cell of declaredCells) {
    assertGateCell(cell)
    const key = cellKey(cell)
    if (declared.has(key)) {
      throw new Error(
        `spike-b1c-gate-check: declared cell appears more than once: ${key}`,
      )
    }
    declared.set(key, cell)
  }

  const byCell = new Map<string, B1cSqlServerEvidenceRecord>()
  for (const record of records) {
    assertValidB1cSqlServerEvidenceRecord(record)
    const key = cellKey(record)
    if (!declared.has(key)) {
      throw new Error(
        `spike-b1c-gate-check: evidence belongs to an undeclared cell: ${key}`,
      )
    }
    if (byCell.has(key)) {
      throw new Error(
        `spike-b1c-gate-check: multiple evidence records for one cell: ${key}`,
      )
    }
    byCell.set(key, record)
  }

  return [...declared.values()].map((cell) => {
    const record = byCell.get(cellKey(cell))
    if (!record) {
      return {
        ...cell,
        evidencePresent: false,
        proven: false,
        reason: 'ABSENT',
      }
    }
    return {
      ...cell,
      evidencePresent: true,
      proven: record.outcome === 'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_PROVEN',
      reason: record.outcome,
    }
  })
}

export function assertEveryDeclaredCellHasEvidence(
  verdicts: readonly B1cGateVerdict[],
): void {
  const absentCount = verdicts.filter(
    (verdict) => !verdict.evidencePresent,
  ).length
  if (absentCount > 0) {
    throw new Error(
      `spike-b1c-gate-check: ${absentCount} declared cell(s) have no evidence`,
    )
  }
}

export function assertEveryDeclaredCellProven(
  verdicts: readonly B1cGateVerdict[],
): void {
  assertEveryDeclaredCellHasEvidence(verdicts)
  const nonOpeningCount = verdicts.filter((verdict) => !verdict.proven).length
  if (nonOpeningCount > 0) {
    throw new Error(
      `spike-b1c-gate-check: ${nonOpeningCount} declared cell(s) did not prove the page-sequence capability`,
    )
  }
}

export function readB1cEvidenceRecords(
  evidenceDir: string,
): B1cSqlServerEvidenceRecord[] {
  if (!fs.existsSync(evidenceDir)) return []
  const records: B1cSqlServerEvidenceRecord[] = []
  for (const name of fs
    .readdirSync(evidenceDir)
    .filter((name) => name.endsWith('.json'))
    .sort()) {
    const filePath = path.join(evidenceDir, name)
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
      throw new Error(`spike-b1c-gate-check: ${name} is not valid JSON`)
    }
    assertValidB1cSqlServerEvidenceRecord(parsed)
    records.push(parsed)
  }
  return records
}

function main(): void {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const evidenceDir = flag('--evidence-dir') ?? process.env.B1C_EVIDENCE_DIR
  const declaredCellsRaw =
    flag('--declared-cells') ?? process.env.B1C_DECLARED_CELLS
  if (!evidenceDir) {
    throw new Error(
      'spike-b1c-gate-check: --evidence-dir (or B1C_EVIDENCE_DIR) is required',
    )
  }
  if (!declaredCellsRaw) {
    throw new Error(
      'spike-b1c-gate-check: --declared-cells (or B1C_DECLARED_CELLS) is required',
    )
  }
  const declaredCells = JSON.parse(declaredCellsRaw) as B1cGateCell[]
  const verdicts = computeB1cGateVerdicts(
    readB1cEvidenceRecords(evidenceDir),
    declaredCells,
  )

  console.log('[b1c-gate-check] values-free verdicts (EVIDENCE ONLY):')
  for (const verdict of verdicts) {
    console.log(
      `  ${cellKey(verdict)} evidencePresent=${verdict.evidencePresent} proven=${verdict.proven} reason=${verdict.reason}`,
    )
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    const rows = verdicts
      .map(
        (verdict) =>
          `| ${verdict.engineMajorVersion} | ${verdict.evidencePresent} | ${verdict.proven} | ${verdict.reason} |`,
      )
      .join('\n')
    fs.appendFileSync(
      summaryPath,
      `\n### B1c SQL Server snapshot page-sequence evidence\n\n` +
        `This verdict does not certify or activate a profile.\n\n` +
        `| engine | evidence | proven | reason |\n|---|---|---|---|\n${rows}\n`,
    )
  }
  // Non-opening records remain valid evidence and are rendered above, but this workflow is
  // the opening proof gate: every declared matrix cell must actually prove the capability.
  assertEveryDeclaredCellProven(verdicts)
}

const entryUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : ''
if (import.meta.url === entryUrl) {
  try {
    main()
  } catch (error) {
    console.error('[b1c-gate-check] FAILED (malformed or ambiguous evidence)')
    console.error(error)
    process.exitCode = 1
  }
}
