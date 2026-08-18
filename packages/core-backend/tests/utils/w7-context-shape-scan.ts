/**
 * W7-1b (#4556) — the CONTEXT-SHAPE derive-and-diff engine.
 *
 * Authority: #4556 comments 5293034619 + 5293478713.
 *
 * ---------------------------------------------------------------------------
 * WHY A DERIVATION AND NOT A LIST
 * ---------------------------------------------------------------------------
 * The predecessor design named ONE context-shape consumer. There are SIX
 * validator call sites — and a SEVENTH gate that never calls the validator at
 * all: `parseImportContext`, a hand-duplicated 14-key parser that tests
 * `schemaVersion` / `selector` / `calculationGroupId` itself and THROWS. A grep
 * for the validator's name misses it completely.
 *
 * That is the standing proof that a hand list can be wrong, and it is why this
 * module reuses W7-1a-M's method rather than its file:
 *
 *   - grep the FIELD and the DISCRIMINANT, never only the validator's name;
 *   - expand every hit to its enclosing syntactic unit before classifying,
 *     with boundaries derived from structure — never a fixed ±N window, which
 *     both under-reads a far arm and over-reads a neighbour's members;
 *   - diff against a committed manifest with ALL THREE red conditions, so that
 *     rewriting a gate from one form into another cannot reclassify silently
 *     while the id set stays identical.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

export type W7ContextShapeVerdict = 'MUST_WIDEN' | 'HOLDS_BY_POLARITY' | 'OUT_OF_SCOPE_OWNER'
export type W7ContextShapeFamily = 'validator_call' | 'hand_parser' | 'type_carrier'

export interface W7ContextShapeSiteV1 {
  readonly file: string
  readonly line: number
  readonly text: string
  readonly family: W7ContextShapeFamily
  /** True when the site admits BOTH schemas at this head. */
  readonly widened: boolean
}

export interface W7ContextShapeLedgerEntryV1 {
  readonly file: string
  readonly text: string
  readonly family: W7ContextShapeFamily
  readonly verdict: W7ContextShapeVerdict
  readonly note?: string
}

export interface W7ContextShapeViolationV1 {
  readonly kind: 'unledgered_site' | 'stale_ledger_entry' | 'verdict_drift'
  readonly detail: string
}

/** The V1-ONLY shape gates. A line calling one of these admits v1 alone. */
const V1_ONLY_GATES: readonly string[] = Object.freeze(['validateFrozenContextShape('])
/** The gates that admit BOTH schemas. */
const WIDENED_GATES: readonly string[] = Object.freeze([
  'isSupportedFrozenAttendanceContextV1(',
  'routeFrozenAttendanceContextV1(',
  'validateFrozenAttendanceContextV2ShapeV1(',
])
/** Hand-written discriminant tests — the family a validator-name grep misses.
 *
 *  ⚠️ These tokens alone OVER-COLLECT badly: `schemaVersion` is the envelope
 *  discriminant of several unrelated domains (source commands, snapshots), and
 *  collecting on the LINE would drag all of them in. Membership in this family
 *  therefore requires the ENCLOSING SYNTACTIC UNIT to also carry the
 *  frozen-context discriminant triple — which is exactly what "expand to the
 *  enclosing unit BEFORE classifying" is for. Classifying on the line and
 *  expanding afterwards is how a derivation stops discriminating. */
const HAND_PARSER_TOKENS: readonly string[] = Object.freeze(['schemaVersion !==', 'schemaVersion ===', 'importSchemaVersion'])

/** The frozen-context discriminant triple. A hand parser of THIS domain tests
 *  `schemaVersion` together with `selector` and `calculationGroupId`; an
 *  envelope check of some other domain does not. */
const CONTEXT_DOMAIN_MARKERS: readonly string[] = Object.freeze(['selector', 'calculationGroupId'])

/** The gate DEFINITIONS. Lines inside these are the rule itself, not consumers
 *  of it — collecting them would make the instrument report its own body. */
const GATE_DEFINITION_HEADS: readonly string[] = Object.freeze([
  'export function validateFrozenContextShape',
  'export function isSupportedFrozenAttendanceContextV1',
  'export function routeFrozenAttendanceContextV1',
  'export function validateFrozenAttendanceContextV2ShapeV1',
  'export function readFrozenAttendanceContextSchemaVersionV1',
])

export function resolveRepoRootV1(startDir: string = process.cwd()): string {
  let dir = path.resolve(startDir)
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('repo root not found')
    dir = parent
  }
}

/** Git-tracked files only, so a scratch file cannot silently enter or leave the
 *  domain. Roots deliberately include `plugins/` and `apps/` — the in-backend
 *  twin `parseImportContext` and the `apps/web` duplicate family both live
 *  outside `packages/core-backend/src`. */
export function scanRootsV1(repoRoot: string): string[] {
  const roots = ['packages/core-backend/src', 'plugins', 'apps/web/src', 'scripts']
  const out: string[] = []
  for (const root of roots) {
    const abs = path.join(repoRoot, root)
    if (!fs.existsSync(abs)) continue
    const listed = execFileSync('git', ['ls-files', '-z', '--cached', root], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString('utf8')
      .split('\u0000')
      .filter((f) => /\.(ts|tsx|cjs|mjs|js|vue)$/.test(f))
    out.push(...listed)
  }
  return [...new Set(out)].sort()
}

const isCommentLine = (text: string): boolean => /^\s*(?:\/\/|\/\*|\*|#|--)/.test(text)

/**
 * The enclosing syntactic unit: walk OUT to the nearest indent-0 declaration.
 * Structure-derived, never a fixed window.
 */
export function enclosingUnitV1(lines: readonly string[], index: number): string {
  let start = index
  while (start > 0 && !/^(?:export\s+)?(?:async\s+)?(?:function|const|class|interface|type)\b/.test(lines[start])) {
    start -= 1
  }
  let end = index
  while (end + 1 < lines.length && !/^(?:export\s+)?(?:async\s+)?(?:function|const|class|interface|type)\b/.test(lines[end + 1])) {
    end += 1
  }
  return lines.slice(start, end + 1).join('\n')
}

export function deriveContextShapeSurfaceV1(options: { repoRoot: string; files?: readonly string[] }): {
  sites: W7ContextShapeSiteV1[]
  filesWalked: number
} {
  const { repoRoot } = options
  const files = options.files ?? scanRootsV1(repoRoot)
  const sites: W7ContextShapeSiteV1[] = []
  for (const rel of files) {
    let source: string
    try {
      source = fs.readFileSync(path.join(repoRoot, rel), 'utf8')
    } catch {
      continue
    }
    // Cheap pre-filter, then the real per-line classification.
    if (
      !V1_ONLY_GATES.some((g) => source.includes(g)) &&
      !WIDENED_GATES.some((g) => source.includes(g)) &&
      !HAND_PARSER_TOKENS.some((t) => source.includes(t))
    ) {
      continue
    }
    const lines = source.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i]
      if (isCommentLine(text)) continue
      const v1Only = V1_ONLY_GATES.some((g) => text.includes(g))
      const widenedGate = WIDENED_GATES.some((g) => text.includes(g))
      const handParser = HAND_PARSER_TOKENS.some((t) => text.includes(t))
      if (!v1Only && !widenedGate && !handParser) continue
      // A DEFINITION is not a consumer site.
      if (/^\s*export\s+function\s+(validateFrozenContextShape|isSupportedFrozenAttendanceContextV1|routeFrozenAttendanceContextV1|validateFrozenAttendanceContextV2ShapeV1)\b/.test(text)) {
        continue
      }
      const unit = enclosingUnitV1(lines, i)
      // A line inside one of the gate DEFINITIONS is the rule, not a consumer.
      if (GATE_DEFINITION_HEADS.some((head) => unit.startsWith(head))) continue
      const isHandParserOfThisDomain =
        handParser && CONTEXT_DOMAIN_MARKERS.every((marker) => unit.includes(marker))
      if (!v1Only && !widenedGate && !isHandParserOfThisDomain) continue
      const family: W7ContextShapeFamily =
        isHandParserOfThisDomain && !v1Only && !widenedGate ? 'hand_parser' : 'validator_call'
      // "Widened" means: this site admits BOTH schemas.
      const widened =
        widenedGate || (isHandParserOfThisDomain && /!==\s*1\s*&&[\s\S]{0,80}?!==\s*2/.test(unit))
      sites.push({ file: rel, line: i + 1, text: text.trim(), family, widened })
    }
  }
  return { sites, filesWalked: files.length }
}

export function diffContextShapeV1(
  derivation: { sites: readonly W7ContextShapeSiteV1[] },
  ledger: readonly W7ContextShapeLedgerEntryV1[],
): W7ContextShapeViolationV1[] {
  const violations: W7ContextShapeViolationV1[] = []
  const key = (file: string, text: string) => `${file}::${text}`
  const ledgerByKey = new Map(ledger.map((e) => [key(e.file, e.text), e]))
  const derivedKeys = new Set<string>()

  for (const site of derivation.sites) {
    const k = key(site.file, site.text)
    derivedKeys.add(k)
    const entry = ledgerByKey.get(k)
    // (a) a new derived point that the manifest does not carry
    if (!entry) {
      violations.push({ kind: 'unledgered_site', detail: `${site.file}:${site.line} — ${site.text}` })
      continue
    }
    // (c) class or verdict drift for an existing id. WITHOUT THIS, rewriting a
    // gate from one form into another reclassifies silently while the id set
    // stays identical — which is the whole reason (c) exists.
    if (entry.family !== site.family) {
      violations.push({ kind: 'verdict_drift', detail: `${k} — family ${entry.family} -> ${site.family}` })
    }
    if (entry.verdict === 'MUST_WIDEN' && !site.widened) {
      violations.push({ kind: 'verdict_drift', detail: `${k} — ledgered MUST_WIDEN but derives as NOT widened` })
    }
  }
  // (b) a manifest entry that is no longer derived
  for (const entry of ledger) {
    if (!derivedKeys.has(key(entry.file, entry.text))) {
      violations.push({ kind: 'stale_ledger_entry', detail: `${entry.file} — ${entry.text}` })
    }
  }
  return violations
}

/**
 * THE COMMITTED MANIFEST. Every entry carries a per-site VERDICT, which is the
 * thing worth pinning — a blanket widening would have erased exactly this.
 */
export const W7_CONTEXT_SHAPE_LEDGER_V1: readonly W7ContextShapeLedgerEntryV1[] = Object.freeze([
  {
    file: 'packages/core-backend/src/attendance/w4c1-segment-calculator.ts',
    text: 'if (!isSupportedFrozenAttendanceContextV1(input.context)) {',
    family: 'validator_call', verdict: 'MUST_WIDEN',
    note: 'X1 — un-widened, EVERY group calculation reviews out and the cutover is a silent no-op',
  },
  {
    file: 'packages/core-backend/src/attendance/w4c3b-request-snapshots.ts',
    text: 'if (!isSupportedFrozenAttendanceContextV1(input)) {',
    family: 'validator_call', verdict: 'MUST_WIDEN',
    note: 'X2 — the request-creation snapshot freeze gate (P4 core side); un-widened it silently drops the frozen context',
  },
  {
    file: 'packages/core-backend/src/attendance/w4c3c-manual-edit-apply.ts',
    text: 'if (!isSupportedFrozenAttendanceContextV1(prior.context_snapshot)) {',
    family: 'validator_call', verdict: 'MUST_WIDEN',
    note: 'X3 — reads the PRIOR persisted context; un-widened, manual edit fails on a group-frozen day',
  },
  {
    file: 'packages/core-backend/src/attendance/w4c3c-recompute.ts',
    text: 'if (!isSupportedFrozenAttendanceContextV1(prior.context_snapshot)) {',
    family: 'validator_call', verdict: 'MUST_WIDEN',
    note: 'X4 — frozen_prior recompute replays the persisted context verbatim; un-widened it fails on every group day',
  },
  {
    file: 'packages/core-backend/src/attendance/w4c3c-recompute.ts',
    text: 'if (!isSupportedFrozenAttendanceContextV1(input.currentPolicyContext)) {',
    family: 'validator_call', verdict: 'MUST_WIDEN',
    note: 'X5 — validates the freshly built current_policy context (P6 core side), which can now be v2',
  },
  {
    file: 'packages/core-backend/src/services/AttendanceW4CalculationDetail.ts',
    text: 'const routed = routeFrozenAttendanceContextV1(row.context_snapshot)',
    family: 'validator_call', verdict: 'MUST_WIDEN',
    note: 'X6 — the admin READ API; un-widened it hard-fails for EVERY persisted group row. '
      + 'W7-4 (read-side labeling) rewrote the boolean gate into the DISCRIMINATED router call: '
      + 'acceptance is unchanged (the boolean IS `router !== invalid`), and the routed branches '
      + 'type `context.selector` for the trace-provenance threading',
  },
  {
    file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts',
    text: '(importSchemaVersion !== 1 && importSchemaVersion !== 2) ||',
    family: 'hand_parser', verdict: 'MUST_WIDEN',
    note: 'X7 — the HAND-DUPLICATED parser a validator-name grep misses entirely',
  },
  // ---- X7's remaining derived lines. The widened import parser spans several
  // lines, and each one is its own derived point; ledgering only the first would
  // leave the rest able to drift.
  {
    file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts',
    text: 'const importSchemaVersion = root.schemaVersion',
    family: 'hand_parser', verdict: 'MUST_WIDEN',
    note: 'X7 continuation — binds the discriminant the widened predicate below tests',
  },
  {
    file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts',
    text: "(importSchemaVersion === 1 && importSelector !== 'legacy') ||",
    family: 'hand_parser', verdict: 'MUST_WIDEN',
    note: 'X7 continuation — keeps schemaVersion 1 bound to the legacy selector (the v2-shape-with-v1-tag reject)',
  },
  // ---- The W7-0 DRAFT contract. Its own header states it is NOT called from
  // any production path; W7-1b wired the shape into production through the
  // ROUTER instead of calling this. Recorded rather than silently skipped, so
  // that if it ever gains a production caller the diff reds on the class change.
  {
    file: 'packages/core-backend/src/attendance/w7-frozen-context-v2-contract.ts',
    text: 'if (ctx.schemaVersion !== 1 && ctx.schemaVersion !== 2) return false',
    family: 'hand_parser', verdict: 'OUT_OF_SCOPE_OWNER',
    note: 'W7-0 draft preview validator — no production caller; the live rule is the router',
  },
  {
    file: 'packages/core-backend/src/attendance/w7-frozen-context-v2-contract.ts',
    text: "if (ctx.schemaVersion === 1 && (ctx.selector !== 'legacy' || ctx.calculationGroupId !== null)) {",
    family: 'hand_parser', verdict: 'OUT_OF_SCOPE_OWNER',
    note: 'W7-0 draft guard 4 — no production caller; kept in the domain so a future caller reds',
  },
  {
    file: 'packages/core-backend/src/attendance/w7-frozen-context-v2-contract.ts',
    text: "if (ctx.schemaVersion === 2 && ctx.selector === 'legacy' && ctx.calculationGroupId !== null) {",
    family: 'hand_parser', verdict: 'OUT_OF_SCOPE_OWNER',
    note: 'W7-0 draft guard 5 — no production caller; kept in the domain so a future caller reds',
  },
  {
    file: 'packages/core-backend/src/attendance/w7-frozen-context-v2-contract.ts',
    text: 'ctx.schemaVersion === 2 &&',
    family: 'hand_parser', verdict: 'OUT_OF_SCOPE_OWNER',
    note: 'W7-0 draft guard 6 — no production caller; kept in the domain so a future caller reds',
  },
  // ---- op(i)'s own v2 rehydration witness. This is the ISSUER's rule, not a
  // consumer gate: it must stay v2-only, because a v1 object is not something
  // the group issuance boundary may ever rehydrate.
  {
    file: 'packages/core-backend/src/attendance/w7-resolver/w7-group-effective-context-issuance.ts',
    text: 'if (ctx.schemaVersion !== 2) return false',
    family: 'hand_parser', verdict: 'HOLDS_BY_POLARITY',
    note: "op(i)'s v2-only rehydration check — v2-only is CORRECT here; widening it would let a v1 object through the group issuance boundary",
  },
])
