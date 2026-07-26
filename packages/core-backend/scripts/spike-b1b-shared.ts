// B1b capability spike — shared evidence vocabulary, record shape, declared-phase manifest
// and mutation-log helpers.
//
// EVIDENCE ONLY (docs/development/database-system-integration-line-design-and-verification-
// 20260724.md §4 step 2): nothing in this module or its consumers (spike-b1b-mysql.ts,
// spike-b1b-sqlserver.ts, spike-b1b-gate-check.ts) mints a certification, registers a probe
// strategy, or opens the B1b certification gate (§4 step 3, behind the owner). It produces a
// values-free evidence record per (dialect, engineMajorVersion, phase) that a separate,
// automated gate-check consumes.
//
// Job exit code vs gate verdict (battery §1.3, deliberately decoupled): a REFUSED or
// UNOBTAINABLE outcome, fully recorded with its controls inverted, is a SUCCESSFUL spike run
// — exit 0. Only an INCOMPLETE record (missing phase, out-of-vocabulary token, duplicate
// token, a control that failed to invert) is a failed run — non-zero. This module enforces
// that split structurally: DeclaredPhaseTracker throws on the incompleteness conditions;
// nothing here ever throws because an outcome happens to be a refusal.
//
// Values-free discipline (battery §6): only counts, closed tokens, engine version
// identifiers, verdicts/labels (never raw values) and structured scope fields may appear in
// a SpikeRecord or a MutationLog entry. There is no function anywhere in this module that
// accepts a raw row value — RowLabel is a closed three-member vocabulary, never a string the
// caller can supply freely.

// ── §3 frozen outcome-token vocabulary (exact; pinned by set-equality tests) ──────────────
export const B1B_OUTCOME_TOKENS = Object.freeze([
  'MYSQL_PRECONDITIONS_PROVEN',
  'MYSQL_PRECONDITIONS_UNESTABLISHED',
  'SQLSERVER_DEFAULT_RC_NO_RCSI_CERTIFICATION_REFUSED',
  'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN',
  'SQLSERVER_SINGLE_STATEMENT_SNAPSHOT_UNOBTAINABLE',
  'INCONCLUSIVE',
] as const)
export type OutcomeToken = (typeof B1B_OUTCOME_TOKENS)[number]
const OUTCOME_TOKEN_SET: ReadonlySet<string> = new Set(B1B_OUTCOME_TOKENS)
export function isOutcomeToken(value: unknown): value is OutcomeToken {
  return typeof value === 'string' && OUTCOME_TOKEN_SET.has(value)
}

// §3: "The vocabulary contains no member expressing 'explicit SNAPSHOT transaction proven.'"
// (S-8's vocabulary door). Pinned by a dedicated test asserting this string never appears —
// see spike-b1b-gate-check.test.ts.
export const FORBIDDEN_OUTCOME_SUBSTRING = 'SNAPSHOT_TRANSACTION_PROVEN'

// §6.1: the three row labels a Phase can report — never interchangeable (S-2b vs S-5(ii)).
export const ROW_LABELS = Object.freeze(['COMMITTED_ROW', 'PRE_IMAGE', 'POST_IMAGE'] as const)
export type RowLabel = (typeof ROW_LABELS)[number]

export type Dialect = 'mysql' | 'sqlserver'

// §1.4: the certification unit is (dialect, engine major version, capability posture) — never
// brand. capabilityPosture distinguishes SQL Server's Phase A ('default_rc_no_rcsi') from
// Phase B ('rcsi_on') as SEPARATE profiles (§3.5 ⟲C5, S-6's separateProfile field), and gives
// MySQL a single named posture ('default') since the battery names no MySQL posture axis.
export interface SpikeRecord {
  readonly evidenceSchemaVersion: 1
  readonly dialect: Dialect
  readonly engineMajorVersion: string
  readonly phase: string
  readonly capabilityPosture: string
  readonly outcome: OutcomeToken
  // S-6: statement-level consistency only, never transaction-level, never cross-page (§3.2).
  readonly statementScoped?: boolean
  // S-6: never merged with the other SQL Server posture into one "SQL Server" verdict.
  readonly separateProfile?: boolean
  // X-1: reported as the equality VERDICT, never the raw session identifier (§6.2).
  readonly sameConnection?: boolean
  readonly controlsInverted: number
  readonly observationsTaken: number
  readonly recordedAt: string
}

export function assertValidSpikeRecord(record: SpikeRecord): void {
  if (!isOutcomeToken(record.outcome)) {
    throw new Error(
      `spike-b1b internal: outcome token outside the frozen vocabulary: ${JSON.stringify(record.outcome)}`
    )
  }
  if (record.dialect !== 'mysql' && record.dialect !== 'sqlserver') {
    throw new Error(`spike-b1b internal: unknown dialect ${JSON.stringify(record.dialect)}`)
  }
  if (!Number.isInteger(record.controlsInverted) || record.controlsInverted < 0) {
    throw new Error('spike-b1b internal: controlsInverted must be a non-negative integer (count-only)')
  }
  if (!Number.isInteger(record.observationsTaken) || record.observationsTaken < 0) {
    throw new Error('spike-b1b internal: observationsTaken must be a non-negative integer (count-only)')
  }
}

// ── X-3: exactly one token per DECLARED phase, from the frozen vocabulary ─────────────────
//
// The declared-phase set must be known BEFORE execution (X-3 MUTATION C: an emitter that
// throws before writing its token must red the RUN with a missing-phase failure, not pass
// silently with fewer records than declared). Callers must declare every phase up front and
// call finalize() in a `finally` block so a mid-run throw is still caught as "missing", never
// swallowed.
export class DeclaredPhaseTracker {
  private readonly declared: ReadonlySet<string>
  private readonly emitted = new Map<string, OutcomeToken>()

  constructor(declaredPhases: readonly string[]) {
    if (declaredPhases.length === 0) {
      throw new Error('spike-b1b internal: DeclaredPhaseTracker needs at least one declared phase')
    }
    const seen = new Set<string>()
    for (const phase of declaredPhases) {
      if (seen.has(phase)) {
        throw new Error(`spike-b1b internal: phase "${phase}" declared twice`)
      }
      seen.add(phase)
    }
    this.declared = seen
  }

  // MUTATION A: token outside the frozen vocabulary -> throws.
  // MUTATION B: a phase emits a second token -> throws ("exactly one token per phase").
  emit(phase: string, outcome: OutcomeToken): void {
    if (!this.declared.has(phase)) {
      throw new Error(`spike-b1b internal: emit() for an undeclared phase "${phase}"`)
    }
    if (!isOutcomeToken(outcome)) {
      throw new Error(`spike-b1b: outcome token outside the frozen vocabulary: ${JSON.stringify(outcome)}`)
    }
    if (this.emitted.has(phase)) {
      throw new Error(
        `spike-b1b: phase "${phase}" already emitted "${this.emitted.get(phase)}" — exactly one token per phase`
      )
    }
    this.emitted.set(phase, outcome)
  }

  // MUTATION C: called from a `finally` around EVERY phase runner. If a phase's emitter threw
  // before calling emit(), that phase is absent here and finalize() reds the run — "refusal
  // recorded" and "nothing recorded" must never be indistinguishable at run level (they are
  // already distinguishable at phase level: REFUSED is a token, absence is not).
  finalize(): ReadonlyMap<string, OutcomeToken> {
    const missing = [...this.declared].filter(phase => !this.emitted.has(phase))
    if (missing.length > 0) {
      throw new Error(
        `spike-b1b: missing phase record(s): ${missing.join(', ')} (declared: ${[...this.declared].join(', ')})`
      )
    }
    return this.emitted
  }
}

// ── Mutation-log: baseline vs mutated, both directions pasted ─────────────────────────────
//
// `holds` means "the assertion's condition is satisfied" (GREEN). A MUTATION is expected to
// make `holds` false (RED) unless explicitly marked as an over-strictness / positive-case
// mutation (which must stay GREEN — e.g. M-3's SERIALIZABLE case). Advisor-reviewed shape:
// the OBSERVATION changes between baseline and mutated calls (server state, or an explicit
// mutation-only binding token); the ASSERTION function itself never changes.
export type MutationExpectation = 'RED' | 'GREEN'
export interface MutationLogEntry {
  readonly id: string
  readonly description: string
  readonly expected: MutationExpectation
  readonly observed: MutationExpectation
  readonly verdict: 'PASS' | 'FAIL'
}

export class MutationLog {
  private readonly entries: MutationLogEntry[] = []

  // holds=true -> observed GREEN; holds=false -> observed RED.
  check(id: string, description: string, expected: MutationExpectation, holds: boolean): boolean {
    const observed: MutationExpectation = holds ? 'GREEN' : 'RED'
    const verdict: 'PASS' | 'FAIL' = observed === expected ? 'PASS' : 'FAIL'
    this.entries.push({ id, description, expected, observed, verdict })
    const tag = verdict === 'PASS' ? 'ok' : 'FAILED'
    // eslint-disable-next-line no-console
    console.log(`[mutation ${tag}] ${id} :: expected=${expected} observed=${observed} :: ${description}`)
    return verdict === 'PASS'
  }

  all(): readonly MutationLogEntry[] {
    return this.entries
  }

  // Count-only summary (values-free) — safe to print/emit in evidence.
  summary(): { total: number; passed: number; failed: number } {
    const passed = this.entries.filter(entry => entry.verdict === 'PASS').length
    return { total: this.entries.length, passed, failed: this.entries.length - passed }
  }

  // A control/mutation that "failed to invert" must fail the RUN (§1.3), not merely log a
  // warning. Called once at the end of each phase's mutation battery.
  assertAllPassed(context: string): void {
    const failed = this.entries.filter(entry => entry.verdict === 'FAIL')
    if (failed.length > 0) {
      throw new Error(
        `spike-b1b: ${failed.length} mutation(s)/control(s) failed to invert in ${context}: ` +
          failed.map(entry => entry.id).join(', ')
      )
    }
  }
}

// ── Values-free row-label discipline (§6.1/§6.2) ───────────────────────────────────────────
// The only thing ever reported about a probed row is ONE of these three labels — never the
// row's own values. Callers must not format an arbitrary string here (closed union, not
// `string`), so a future edit that tries to smuggle a value through this seam fails to
// compile rather than fails silently at runtime.
export function assertRowLabel(label: RowLabel): RowLabel {
  if (!ROW_LABELS.includes(label)) {
    throw new Error(`spike-b1b internal: row label outside the closed vocabulary: ${JSON.stringify(label)}`)
  }
  return label
}

// ── Evidence file I/O (JSON, ONE file per (dialect, engineMajorVersion, phase) record) ────
// A dialect/version pair can carry MORE THAN ONE record (SQL Server's Phase A and Phase B are
// two separate certification units, §1.4) — the gate-check reads one SpikeRecord object per
// file, never an array, so each phase gets its OWN file.
export function evidenceFileName(dialect: Dialect, engineMajorVersion: string, phase: string): string {
  // Version/phase strings here are operator/CI-declared matrix labels (e.g. "2019", "8.0",
  // "phaseA"), never externally-supplied free text, so a plain sanitize is defense-in-depth,
  // not a boundary.
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${safe(dialect)}-${safe(engineMajorVersion)}-${safe(phase)}.json`
}
