/**
 * W7-1a-M (#4556) — the DERIVE half of the derive-and-diff completeness check.
 *
 * Ratified per #4556 comments 5293034619 + 5293478713. The ratification refuses
 * to enumerate the widening surface ("扩宽面不由本裁决枚举" — two hand-written
 * lists were refuted), so this module DERIVES the surface from the tree and the
 * paired test diffs the derivation against a ledger. Missing a point is RED in
 * both directions: an un-ledgered derived site fails, and a ledger entry whose
 * construct has vanished fails.
 *
 * Why derivation is not "grep for the new value": the silent-downgrade folds
 * (`row.projection_owner === 'w4' ? 'w4' : 'legacy_untracked'`) contain NO
 * target string at all. So the anchor is the READER — a file that references the
 * column/field — and within an anchored file every line carrying a domain
 * literal OR a widening symbol is a derived site.
 *
 * SCOPE — source text only. The DB surface is derived SEPARATELY, from the live
 * catalogue (`pg_constraint` / `pg_proc`) in
 * `tests/integration/attendance-w7-1am-provenance-widening.db.test.ts`. Migration
 * FILES are deliberately excluded from this scan: `attendance_w4_records_pointer_guard`
 * is defined in zzzz20260725120000 and then REPLACED by zzzz20260731120000, so
 * migration text says nothing reliable about what is live, and historical
 * migrations are never edited. Only the catalogue is authoritative there.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Walk up for the workspace marker — never a fixed `../../..` (REPO_ROOT_AMBIGUOUS). */
export function resolveRepoRootV1(startDir: string = __dirname): string {
  let dir = startDir
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('W7_SCAN: pnpm-workspace.yaml not found above ' + startDir)
    dir = parent
  }
}

export const W7_SCAN_ROOTS_V1: readonly string[] = Object.freeze([
  'packages/core-backend/src',
  'packages/openapi/src',
  'apps/web/src',
  'scripts',
])

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.vue', '.cjs', '.mjs', '.js', '.yml', '.yaml'])

/** Excluded from the scan; each exclusion is a rule, not a site-level exemption. */
function isExcluded(relPath: string): boolean {
  return (
    relPath.includes('/node_modules/') ||
    relPath.includes('/dist/') ||
    relPath.includes('/dist-sdk/') ||
    // See file header: DB surface is derived from the live catalogue instead.
    relPath.includes('/src/db/migrations/') ||
    // The widening surface is the PRODUCTION consumer set. Test files assert
    // against the domain, they do not gate it, and a test that pins the
    // pre-widening set is a deliberate historical fixture, not a missed point.
    relPath.includes('/__tests__/') ||
    relPath.includes('/tests/') ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relPath)
  )
}

export type W7ProvenanceFamily = 'projection_owner' | 'trace_source_kind'

/** File-level anchors: a file is a CONSUMER of the family if it names one of these. */
const FAMILY_ANCHORS: Readonly<Record<W7ProvenanceFamily, readonly string[]>> = Object.freeze({
  projection_owner: Object.freeze(['projection_owner', 'projectionOwner', 'PROJECTION_OWNERS']),
  trace_source_kind: Object.freeze([
    'AttendanceDecisionTraceSourceKind',
    'ATTENDANCE_TRACE_SOURCE_KINDS',
    'AttendanceTraceSourceKind',
    'TRACE_SOURCE_KIND',
  ]),
})

/**
 * Two-tier membership, because a bare literal is not always this domain's.
 *
 * DISTINCTIVE members are unique to the family across the scanned tree, so any
 * line carrying one is a site outright. AMBIGUOUS members (`'w4'`, and the trace
 * family's `'record'`/`'snapshot'`/`'ledger'`/`'audit'`) also occur as unrelated
 * discriminators — `w4c2-live-scheduled-boundary.ts` has a `readonly kind: 'w4'`
 * tag that has nothing to do with projection ownership — so they count only when
 * the SAME line also names the field/column or a derived alias.
 *
 * This cannot miss a closed member list: every list of a family's members
 * contains at least one distinctive member by construction. And it cannot miss
 * an ambiguous-literal PREDICATE, because a predicate must name what it tests.
 */
const FAMILY_DISTINCTIVE_LITERALS: Readonly<Record<W7ProvenanceFamily, readonly string[]>> =
  Object.freeze({
    projection_owner: Object.freeze(['legacy_untracked', 'w4_group']),
    trace_source_kind: Object.freeze(['rule_live', 'policy_gate', 'group_policy_snapshot']),
  })

const FAMILY_AMBIGUOUS_LITERALS: Readonly<Record<W7ProvenanceFamily, readonly string[]>> =
  Object.freeze({
    projection_owner: Object.freeze(['w4']),
    trace_source_kind: Object.freeze(['record', 'snapshot', 'ledger', 'audit']),
  })

/** Symbols that CARRY the widening; a line using one is widened by construction. */
const FAMILY_WIDENING_SYMBOLS: Readonly<Record<W7ProvenanceFamily, readonly string[]>> =
  Object.freeze({
    projection_owner: Object.freeze([
      'ATTENDANCE_PROJECTION_OWNERS_V1',
      'ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_V1',
      'ATTENDANCE_PROJECTION_OWNERS_SQL_LIST_V1',
      'ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_SQL_LIST_V1',
      'isAttendanceProjectionOwnerV1',
      'isAttendanceProjectionOwnerWithCalculationPointerV1',
      'AttendanceProjectionOwnerV1',
      'ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1',
    ]),
    trace_source_kind: Object.freeze([
      'ATTENDANCE_TRACE_SOURCE_KINDS_V1',
      'isAttendanceTraceSourceKindV1',
      'ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1',
    ]),
  })

export const W7_WIDENING_SYMBOLS_V1: readonly string[] = Object.freeze([
  ...FAMILY_WIDENING_SYMBOLS.projection_owner,
  ...FAMILY_WIDENING_SYMBOLS.trace_source_kind,
])

/** The values this slice adds, per family. */
export const W7_NEW_VALUES_V1: Readonly<Record<W7ProvenanceFamily, string>> = Object.freeze({
  projection_owner: 'w4_group',
  trace_source_kind: 'group_policy_snapshot',
})

export interface W7DerivedSiteV1 {
  readonly family: W7ProvenanceFamily
  readonly file: string
  readonly line: number
  readonly text: string
  /** `file::text` — stable across line-number churn. */
  readonly key: string
  /** The enclosing indent-0 declaration, used ONLY as evidence scope for member lists. */
  readonly declaration: string
  readonly hasNewValue: boolean
  readonly hasWideningSymbol: boolean
  readonly declarationHasNewValue: boolean
  readonly declarationHasWideningSymbol: boolean
}

function listFiles(root: string, repoRoot: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    const rel = '/' + path.relative(repoRoot, full).split(path.sep).join('/')
    if (isExcluded(rel)) continue
    if (entry.isDirectory()) {
      listFiles(full, repoRoot, out)
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full)
    }
  }
}

/**
 * One taint hop: identifiers bound to a read of the column/field. Kept
 * FILE-LOCAL on purpose — a bare `owner` is far too generic to anchor globally.
 */
export function deriveAliasIdentifiersV1(source: string): string[] {
  const aliases = new Set<string>()
  const patterns = [
    // `const projectionOwner = String(row.projection_owner)`
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n]*\b(?:projection_owner|projectionOwner)\b/g,
    // `projection_owner AS "projectionOwner"`
    /\bprojection_owner\s+AS\s+"([A-Za-z_$][\w$]*)"/gi,
    // `owner = input.preimage.projectionOwner`
    /\b([A-Za-z_$][\w$]*)\s*=\s*[^\n=]*\.projectionOwner\b/g,
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) {
      if (m[1] && m[1].length > 1) aliases.add(m[1])
    }
  }
  return [...aliases].sort()
}

function literalRegex(members: readonly string[], isYaml: boolean): RegExp {
  const alternation = members.join('|')
  // YAML enums are unquoted (`enum: [legacy_untracked, w4]`); TS/SQL are quoted.
  return isYaml
    ? new RegExp(`\\b(?:${alternation})\\b`)
    : new RegExp(`['"\`](?:${alternation})['"\`]`)
}

/** A comment cannot gate, downgrade, or reject a value, so it is not a site. */
function isCommentLine(text: string): boolean {
  return /^\s*(?:\/\/|\/\*|\*|#|--)/.test(text)
}

/** The enclosing indent-0 declaration block containing `lineIndex`. */
function enclosingDeclaration(lines: readonly string[], lineIndex: number): string {
  let start = lineIndex
  while (start > 0 && !/^\S/.test(lines[start])) start -= 1
  let end = lineIndex
  while (end < lines.length - 1 && !/^\S/.test(lines[end + 1])) end += 1
  return lines.slice(start, end + 1).join('\n')
}

export interface W7DerivationV1 {
  readonly sites: readonly W7DerivedSiteV1[]
  readonly aliasIdentifiers: readonly string[]
  readonly scannedFileCount: number
  readonly anchoredFileCount: number
}

export function deriveProvenanceWideningSurfaceV1(
  options: Readonly<{ repoRoot: string; roots?: readonly string[] }>,
): W7DerivationV1 {
  const repoRoot = options.repoRoot
  const roots = options.roots ?? W7_SCAN_ROOTS_V1
  const files: string[] = []
  for (const root of roots) listFiles(path.join(repoRoot, root), repoRoot, files)
  files.sort()

  const sites: W7DerivedSiteV1[] = []
  const aliasIdentifiers = new Set<string>()
  let anchoredFileCount = 0

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    const rel = path.relative(repoRoot, file).split(path.sep).join('/')
    const isYaml = /\.ya?ml$/.test(file)
    const families = (Object.keys(FAMILY_ANCHORS) as W7ProvenanceFamily[]).filter((family) =>
      FAMILY_ANCHORS[family].some((anchor) => source.includes(anchor)),
    )
    if (families.length === 0) continue
    anchoredFileCount += 1
    for (const alias of deriveAliasIdentifiersV1(source)) aliasIdentifiers.add(alias)

    const aliasTokens = [...FAMILY_ANCHORS.projection_owner, ...deriveAliasIdentifiersV1(source)]
    const lines = source.split('\n')
    for (const family of families) {
      const distinctive = literalRegex(FAMILY_DISTINCTIVE_LITERALS[family], isYaml)
      const ambiguous = literalRegex(FAMILY_AMBIGUOUS_LITERALS[family], isYaml)
      const anchorTokens = family === 'projection_owner' ? aliasTokens : FAMILY_ANCHORS[family]
      const symbols = FAMILY_WIDENING_SYMBOLS[family]
      const newValue = W7_NEW_VALUES_V1[family]
      // An `import` names a symbol; it does not gate, branch on, or emit a
      // value, so it is not a consumer site.
      let inImportBlock = false
      for (let i = 0; i < lines.length; i += 1) {
        const text = lines[i]
        if (/^\s*import\b/.test(text)) inImportBlock = !/\bfrom\b|;\s*$/.test(text)
        else if (inImportBlock && /\bfrom\b/.test(text)) {
          inImportBlock = false
          continue
        }
        if (inImportBlock || /^\s*import\b/.test(text)) continue
        if (isCommentLine(text)) continue
        const hasWideningSymbol = symbols.some((symbol) => text.includes(symbol))
        const namesTarget = anchorTokens.some((token) => new RegExp(`\\b${token}\\b`).test(text))
        const isSite =
          hasWideningSymbol || distinctive.test(text) || (ambiguous.test(text) && namesTarget)
        if (!isSite) continue
        const declaration = enclosingDeclaration(lines, i)
        sites.push({
          family,
          file: rel,
          line: i + 1,
          text: text.trim(),
          key: `${rel}::${text.trim()}`,
          declaration,
          hasNewValue: text.includes(newValue),
          hasWideningSymbol,
          declarationHasNewValue: declaration.includes(newValue),
          declarationHasWideningSymbol: symbols.some((symbol) => declaration.includes(symbol)),
        })
      }
    }
  }

  return {
    sites,
    aliasIdentifiers: [...aliasIdentifiers].sort(),
    scannedFileCount: files.length,
    anchoredFileCount,
  }
}

// ---------------------------------------------------------------------------
// The DIFF half: verdict rules + the ledger.
// ---------------------------------------------------------------------------

/**
 * Every derived site carries exactly one rule. `widened` rules assert the point
 * now admits the new value; `neutral` rules assert — with a MACHINE-CHECKED
 * predicate, never prose — that the point cannot downgrade or reject it.
 */
export type W7RuleName =
  /** Closed member list (union / `as const` array / OpenAPI enum). Evidence scope = declaration. */
  | 'closed_set_member_list'
  /** One arm of an exhaustive `switch` over the domain. Evidence scope =
   *  declaration (the sibling arm for the new member is what proves widening). */
  | 'exhaustive_switch_arm'
  /** A membership test, branch, or fold. Evidence scope = the LINE itself. */
  | 'widened_predicate'
  /** A continuation line of a multi-line widened predicate (e.g. a ternary's
   *  fallback arm). Evidence scope = declaration, because the widening symbol
   *  sits on the predicate's first line. */
  | 'widened_predicate_continuation'
  /** Compares only against `legacy_untracked`, so every other member — new ones
   *  included — takes the SAME arm `w4` takes. Correct as written. */
  | 'legacy_polarity'
  /** Writes a constant domain value; not a test at all. INERT slice: no new emitters. */
  | 'write_side_emitter'
  /** `?? 'legacy_untracked'` on a NOT NULL column: a null-default, not a fold. */
  | 'null_default'
  /** The recorded W7-0 snapshot of a live set (kept equal by the tsc sync guards). */
  | 'w7_0_recorded_snapshot'
  /**
   * A line of the domain module that DEFINES the widening. These lines are not
   * held to "must contain the new value" — one of them is precisely the
   * `legacy_untracked`-only NULL-pointer member, which by the semantic ruling
   * must NOT gain it. The module's correctness is asserted directly and far more
   * strictly by the exact-member-array assertions in the paired test.
   */
  | 'domain_definition'

const WIDENED_RULES: ReadonlySet<W7RuleName> = new Set<W7RuleName>([
  'closed_set_member_list',
  'exhaustive_switch_arm',
  'widened_predicate',
  'widened_predicate_continuation',
  'w7_0_recorded_snapshot',
])

/** Rules whose widening evidence may come from the enclosing declaration. */
const DECLARATION_SCOPED_RULES: ReadonlySet<W7RuleName> = new Set<W7RuleName>([
  'closed_set_member_list',
  'exhaustive_switch_arm',
  'widened_predicate_continuation',
  'w7_0_recorded_snapshot',
])

/** The one file allowed to carry `domain_definition` sites. */
const W7_DOMAIN_MODULE_SUFFIX = 'src/attendance/w7-provenance-domain.ts'

/**
 * Tokens that make a line a TEST rather than an emission. An emitter that
 * contains none of these cannot put the new member on the wrong side of
 * anything, because it does not branch on the value at all.
 */
const COMPARISON_TOKENS: readonly string[] = Object.freeze([
  '===',
  '!==',
  '==',
  '!=',
  '<>',
  'IN (',
  'NOT IN',
  'IS DISTINCT',
  'IS NOT DISTINCT',
  '.includes(',
  'case ',
])

/**
 * SQL boolean contexts. Plain `=` is assignment in `SET`/`VALUES` but comparison
 * in `WHERE`/`AND`/`OR`/`WHEN`, and the two are indistinguishable from the
 * operator alone — so a line in a boolean context is never treated as a mere
 * emitter. Without this, a future `WHERE projection_owner = 'w4'` would classify
 * as an emitter and its missing widening would pass unnoticed.
 */
const SQL_BOOLEAN_CONTEXT_TOKENS: readonly string[] = Object.freeze([
  'WHERE',
  ' AND ',
  ' OR ',
  'HAVING',
  'WHEN ',
  'IF ',
  'CHECK',
])

function hasComparison(text: string): boolean {
  return (
    COMPARISON_TOKENS.some((token) => text.includes(token)) ||
    SQL_BOOLEAN_CONTEXT_TOKENS.some((token) => text.includes(token))
  )
}

export interface W7LedgerEntryV1 {
  readonly file: string
  readonly text: string
  readonly rule: W7RuleName
  readonly note?: string
}

export interface W7ViolationV1 {
  readonly kind: 'unledgered_site' | 'stale_ledger_entry' | 'not_widened' | 'rule_predicate_failed'
  readonly detail: string
}

function ledgerKey(entry: W7LedgerEntryV1): string {
  return `${entry.file}::${entry.text}`
}

/** Machine predicates for the neutral rules — the reason a site needs no edit. */
function neutralPredicateHolds(rule: W7RuleName, site: W7DerivedSiteV1): boolean {
  const text = site.text
  switch (rule) {
    case 'legacy_polarity':
      // Must BE a test, must test `legacy_untracked`, and must NOT test `'w4'`.
      // A `'w4'`-polarity predicate would put the new member on the wrong side,
      // so this is exactly the condition under which no edit is needed.
      return (
        site.family === 'projection_owner' &&
        hasComparison(text) &&
        text.includes('legacy_untracked') &&
        !/['"`]w4['"`]/.test(text)
      )
    case 'write_side_emitter':
      // Not a test at all — it cannot route the new member anywhere.
      return !hasComparison(text)
    case 'null_default':
      // `?? 'legacy_untracked'` fires only on SQL NULL (the column is NOT NULL);
      // it passes every real value through unchanged, so it cannot downgrade.
      return text.includes('??') && !hasComparison(text)
    case 'domain_definition':
      // Only the domain module may claim this rule, so it cannot be used to
      // excuse an un-widened consumer anywhere else in the tree.
      return site.file.endsWith(W7_DOMAIN_MODULE_SUFFIX)
    default:
      return false
  }
}

export function diffProvenanceWideningV1(
  derivation: W7DerivationV1,
  ledger: readonly W7LedgerEntryV1[],
): W7ViolationV1[] {
  const violations: W7ViolationV1[] = []
  const byKey = new Map<string, W7LedgerEntryV1>()
  for (const entry of ledger) byKey.set(ledgerKey(entry), entry)
  const seen = new Set<string>()

  for (const site of derivation.sites) {
    const entry = byKey.get(site.key)
    if (!entry) {
      violations.push({
        kind: 'unledgered_site',
        detail: `${site.file}:${site.line} (${site.family}) — ${site.text}`,
      })
      continue
    }
    seen.add(site.key)
    if (WIDENED_RULES.has(entry.rule)) {
      const widened = DECLARATION_SCOPED_RULES.has(entry.rule)
        ? site.declarationHasNewValue || site.hasWideningSymbol || site.declarationHasWideningSymbol
        : site.hasNewValue || site.hasWideningSymbol
      if (!widened) {
        violations.push({
          kind: 'not_widened',
          detail: `${site.file}:${site.line} rule=${entry.rule} — ${site.text}`,
        })
      }
    } else if (!neutralPredicateHolds(entry.rule, site)) {
      violations.push({
        kind: 'rule_predicate_failed',
        detail: `${site.file}:${site.line} rule=${entry.rule} — ${site.text}`,
      })
    }
  }

  for (const entry of ledger) {
    if (!seen.has(ledgerKey(entry))) {
      violations.push({
        kind: 'stale_ledger_entry',
        detail: `${entry.file} — ${entry.text}`,
      })
    }
  }
  return violations
}

/**
 * THE LEDGER — every derived site, with the rule that adjudicates it.
 *
 * This list is DERIVED, then adjudicated: the scanner above produced the site
 * set mechanically from the tree, and each entry records which rule makes that
 * site correct. The paired test diffs the two in BOTH directions, so the ledger
 * cannot silently drift from the tree:
 *   - a site with no entry FAILS (a new un-widened consumer cannot sneak in);
 *   - an entry with no site FAILS (a construct that moved cannot be left behind);
 *   - a `widened` rule whose evidence is absent FAILS;
 *   - a `neutral` rule whose machine predicate is false FAILS.
 *
 * Keyed by `file` + exact source `text` rather than line number, so unrelated
 * edits above a site do not churn this list.
 */
export const W7_PROVENANCE_WIDENING_LEDGER_V1: readonly W7LedgerEntryV1[] = Object.freeze([
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: '\'group_policy_snapshot\',', rule: 'closed_set_member_list' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: '\'policy_gate\',', rule: 'closed_set_member_list' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: '\'rule_live\',', rule: 'closed_set_member_list' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: 'case \'group_policy_snapshot\': return tr(\'Group policy snapshot\', \'组策略快照\')', rule: 'exhaustive_switch_arm' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: 'case \'policy_gate\': return tr(\'Policy gate\', \'策略开关\')', rule: 'exhaustive_switch_arm' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: 'case \'rule_live\': return tr(\'Live rule\', \'活体规则\')', rule: 'exhaustive_switch_arm' },
  { file: 'packages/core-backend/src/attendance/w4c0-write-boundary-types.ts', text: 'projectionOwner: AttendanceProjectionOwnerV1', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: ': \'legacy_untracked\',', rule: 'widened_predicate_continuation' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: 'SET current_calculation_id = $3::uuid, projection_owner = \'w4\',', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: 'isAttendanceProjectionOwnerWithCalculationPointerV1(parent.projectionOwner) &&', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: 'let owner: AttendanceProjectionOwnerV1', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: 'owner = \'w4\'', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: 'projectionOwner: isAttendanceProjectionOwnerV1(row.projection_owner)', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: 'readonly projectionOwner: AttendanceProjectionOwnerV1', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: '} else if (parent.projectionOwner === \'legacy_untracked\' && parent.visibilityState === \'active\') {', rule: 'legacy_polarity' },
  { file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', text: ': \'legacy_untracked\',', rule: 'widened_predicate_continuation' },
  { file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', text: '\'legacy_untracked\', NULL, \'retired\', \'review_placeholder\',', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', text: 'projectionOwner: AttendanceProjectionOwnerV1', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', text: 'projectionOwner: isAttendanceProjectionOwnerV1(row.projectionOwner)', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', text: '!isAttendanceProjectionOwnerV1(projectionOwner) ||', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', text: '(isAttendanceProjectionOwnerWithCalculationPointerV1(projectionOwner) &&', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', text: '(projectionOwner === \'legacy_untracked\' && currentCalculationId !== null) ||', rule: 'legacy_polarity' },
  { file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', text: '\'legacy_untracked\',NULL,$15,$16,now(),now()', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', text: 'if (input.preimage.projectionOwner !== \'legacy_untracked\') return', rule: 'legacy_polarity' },
  { file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', text: 'timezone = $9, projection_owner = \'w4\', current_calculation_id = $10::uuid,', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c3a-import-rollback-boundary.ts', text: 'AND (current_calculation_id IS NOT NULL OR projection_owner IN (${ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_SQL_LIST_V1}))', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c3a-import-rollback.ts', text: '!isAttendanceProjectionOwnerV1(row.projectionOwner) ||', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c3a-import-rollback.ts', text: '!isAttendanceProjectionOwnerWithCalculationPointerV1(record.projection_owner) ||', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c3a-import-rollback.ts', text: '(isAttendanceProjectionOwnerWithCalculationPointerV1(row.projectionOwner) &&', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c3a-import-rollback.ts', text: '(row.projectionOwner === \'legacy_untracked\' && row.currentCalculationId === null) ||', rule: 'legacy_polarity' },
  { file: 'packages/core-backend/src/attendance/w4c3a-import-rollback.ts', text: 'currentCalculationId: isAttendanceProjectionOwnerWithCalculationPointerV1(row.projectionOwner)', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c3a-import-rollback.ts', text: 'present ? preimage.projectionOwner : \'w4\',', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c3a-import-rollback.ts', text: 'projectionOwner: AttendanceProjectionOwnerV1', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c3a-import-rollback.ts', text: 'projectionOwner?: AttendanceProjectionOwnerV1', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c3b-approved-leave-cancellation.ts', text: 'SET current_calculation_id = $3::uuid, projection_owner = \'w4\',', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c3c-manual-edit-apply.ts', text: 'projection_owner = \'w4\',', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c3c-ops-retirement.ts', text: 'const projectionOwner = String(record.projection_owner ?? \'legacy_untracked\')', rule: 'null_default' },
  { file: 'packages/core-backend/src/attendance/w4c3c-ops-retirement.ts', text: 'projection_owner = \'w4\',', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c3c-recompute.ts', text: 'SET current_calculation_id = $3::uuid, projection_owner = \'w4\',', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: '(typeof ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_V1)[number]', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_V1.map((owner) => `\'${owner}\'`).join(\', \')', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1,', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1,', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: '\'legacy_untracked\',', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: '\'policy_gate\',', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: '\'rule_live\',', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export const ATTENDANCE_PROJECTION_OWNERS_SQL_LIST_V1 = ATTENDANCE_PROJECTION_OWNERS_V1.map(', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export const ATTENDANCE_PROJECTION_OWNERS_V1 = [', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export const ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_SQL_LIST_V1 =', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export const ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_V1 = [', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export const ATTENDANCE_PROJECTION_OWNER_WITHOUT_CALCULATION_POINTER_V1 = \'legacy_untracked\' as const', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export const ATTENDANCE_TRACE_SOURCE_KINDS_V1 = [', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export function isAttendanceProjectionOwnerV1(value: unknown): value is AttendanceProjectionOwnerV1 {', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export function isAttendanceProjectionOwnerWithCalculationPointerV1(', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export function isAttendanceTraceSourceKindV1(value: unknown): value is AttendanceTraceSourceKindV1 {', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export type AttendanceProjectionOwnerV1 = (typeof ATTENDANCE_PROJECTION_OWNERS_V1)[number]', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export type AttendanceTraceSourceKindV1 = (typeof ATTENDANCE_TRACE_SOURCE_KINDS_V1)[number]', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'return (ATTENDANCE_PROJECTION_OWNERS_V1 as readonly unknown[]).includes(value)', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'return (ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_V1 as readonly unknown[]).includes(value)', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'return (ATTENDANCE_TRACE_SOURCE_KINDS_V1 as readonly unknown[]).includes(value)', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: '\'group_policy_snapshot\',', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: '\'policy_gate\',', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: '\'rule_live\',', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: 'currentMembers: Object.freeze([\'legacy_untracked\', \'w4\', \'w4_group\'] as const),', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: 'export const ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1 = \'w4_group\' as const', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: 'export const ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1 = \'group_policy_snapshot\' as const', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: 'newValue: ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1,', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: 'newValue: ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1,', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'basis.push({ source: { kind: \'policy_gate\', ref: \'auto_absence_generation\' }, version: { posture: \'undeterminable\' } })', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'return { source: { kind: \'rule_live\', ref: \'none\' }, version: { posture: \'undeterminable\' } }', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'return { source: { kind: \'rule_live\', ref: rule.refKind }, version: { posture: \'current_live_no_history\' } }', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'source: { kind: \'policy_gate\', ref: \'ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED\' },', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'source: { kind: \'policy_gate\', ref: \'compTimeFromOvertime\' },', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'source: { kind: \'policy_gate\', ref: \'overtimeSegmentation\' },', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'source: { kind: \'rule_live\', ref: \'attendance_overtime_rules\' },', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: '| \'group_policy_snapshot\'', rule: 'closed_set_member_list' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: '| \'policy_gate\'', rule: 'closed_set_member_list' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: '| \'rule_live\'', rule: 'closed_set_member_list' },
  { file: 'packages/core-backend/src/services/AttendanceW4CalculationDetail.ts', text: 'const PROJECTION_OWNERS = ATTENDANCE_PROJECTION_OWNERS_V1', rule: 'widened_predicate' },
  { file: 'packages/openapi/src/base.yml', text: 'projectionOwner: { type: string, enum: [legacy_untracked, w4, w4_group] }', rule: 'closed_set_member_list' },
  { file: 'scripts/attendance/execute-ops-retirement-cleanup.cjs', text: 'if (row.projection_owner != null && row.projection_owner !== \'legacy_untracked\') return true', rule: 'legacy_polarity' },
  { file: 'scripts/attendance/generate-cleanup-sql.cjs', text: 'OR r.projection_owner IS DISTINCT FROM \'legacy_untracked\'', rule: 'legacy_polarity' },
  { file: 'scripts/ops/staging-attendance-tooling-teardown.mjs', text: 'AND projection_owner IS NOT DISTINCT FROM \'legacy_untracked\'', rule: 'legacy_polarity' },
  { file: 'scripts/ops/staging-attendance-tooling-teardown.mjs', text: 'OR projection_owner IS DISTINCT FROM \'legacy_untracked\'', rule: 'legacy_polarity' },
  { file: 'scripts/ops/staging-attendance-tooling-teardown.mjs', text: '|| (row.projection_owner != null && row.projection_owner !== \'legacy_untracked\')', rule: 'legacy_polarity' },
] as W7LedgerEntryV1[])
