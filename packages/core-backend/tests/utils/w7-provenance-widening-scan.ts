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
 * family at all — and within an anchored file every line carrying a domain
 * literal, a widening symbol, or a `case` arm is a derived site.
 *
 * A file counts as referencing the family if it names ANY member of the three
 * lists this module already derives (field spellings, widening symbols,
 * distinctive literals) — see `familyIsReferencedBy`. Anchoring on the field
 * spellings alone left a consumer typed against the widened union, spelling no
 * column name, completely invisible.
 *
 * SCOPE — source text only. The DB surface is derived SEPARATELY, from the live
 * catalogue in
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
 *
 * ONE EXCEPTION, and it is the important one: a `switch` arm names the value but
 * NOT the subject — `case 'w4':` sits on a line that mentions neither the column
 * nor an alias, so the rule above would make an exhaustive switch over the owner
 * domain invisible. That is precisely the consumer class the `apps/web` finding
 * proves exists in this codebase (it was caught there only because
 * `policy_gate` happens to be distinctive). So a `case` arm carrying ANY member
 * of the family — ambiguous ones included — is always a site.
 */
const CASE_ARM = /^\s*case\s+['"]([a-z_0-9]+)['"]\s*:/
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
 * FILE-LEVEL anchoring: does this file reference the family AT ALL?
 *
 * This gate short-circuits before any line rule, so anything it misses is
 * invisible to the whole derivation. It therefore anchors on EVERY list this
 * module already derives — the field/column spellings, the widening symbols,
 * and the family's distinctive literals — rather than on the field spellings
 * alone. That matters because four of the owner family's widening symbols do
 * NOT contain any field spelling (`AttendanceProjectionOwnerV1`,
 * `isAttendanceProjectionOwnerV1`,
 * `isAttendanceProjectionOwnerWithCalculationPointerV1`,
 * `ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1` — capital `P`, or no trailing
 * `S`), so a consumer typed against the union and spelling no column name used
 * to evade the derivation entirely. The trace family had no such asymmetry,
 * which is exactly what made the owner-family hole detectable.
 *
 * This is reuse, not enumeration: all three lists are derived from the widening
 * itself, so the gate widens automatically whenever the widening does.
 */
function familyIsReferencedBy(family: W7ProvenanceFamily, source: string): boolean {
  return (
    FAMILY_ANCHORS[family].some((anchor) => source.includes(anchor)) ||
    FAMILY_WIDENING_SYMBOLS[family].some((symbol) => source.includes(symbol)) ||
    FAMILY_DISTINCTIVE_LITERALS[family].some((literal) => source.includes(literal))
  )
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

/**
 * Regex-escape a symbol before it is interpolated into a matcher. Widening
 * symbols are ordinary identifiers today, but `$` is a legal identifier
 * character and is also a regex metacharacter in replacement position; an
 * unescaped interpolation is how a matcher silently stops matching.
 */
function escapeForRegExpV1(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * WHOLE-TOKEN containment. `String.includes` is a SUBSTRING test, and a
 * substring test over widening symbols is not merely over-broad — it
 * MANUFACTURES widening evidence. A rename minting a short alias that happens
 * to be a substring of the field spelling (`… as Owner`, a substring of
 * `projectionOwner`) makes every line mentioning `projectionOwner` report
 * `hasWideningSymbol = true`, and `hasWideningSymbol` feeds the
 * `widened_predicate` evidence the diff consults. An un-widened predicate in
 * such a file is then accepted as widened and the "漏一点即红" property the
 * ratification made load-bearing fails silently.
 *
 * `\b` is NOT usable here: JS word boundaries treat `$` as a non-word
 * character, so `\b` would split inside a `$`-carrying identifier. The
 * identifier-class lookarounds below are the correct token boundary.
 */
function containsWholeTokenV1(haystack: string, token: string): boolean {
  return new RegExp(`(?<![\\w$])${escapeForRegExpV1(token)}(?![\\w$])`).test(haystack)
}

/**
 * Second taint hop: `import { isAttendanceProjectionOwnerV1 as ownsPointer }`.
 * The file-level gate sees the original symbol, but every CALL SITE then spells
 * only the renamed local — so without this hop the file anchors and no line is
 * ever a site. The renamed local is treated as a widening symbol FOR THAT FILE.
 *
 * ANCHORED to a real import/export BINDING LIST. The previous form matched
 * `X as Y` anywhere in the file, so a TS type assertion (`foo as Owner`), an
 * `import()` type position, or prose inside a block comment containing those
 * words all minted an alias that was then trusted as widening evidence for the
 * whole file. Widening the regex is how that happened; the fix is to parse the
 * clause and read the rename only inside it.
 *
 * The hop is REPAIRED, not removed: deleting it would pass every negative probe
 * while silently under-collecting, which is the opposite failure. A legitimate
 * `import { isAttendanceProjectionOwnerV1 as isKnown }` must still be honoured.
 */
export function deriveRenamedWideningSymbolsV1(
  source: string,
  symbols: readonly string[],
): string[] {
  const renamed = new Set<string>()
  // `import { … }` / `import type { … }` / `export { … }` / `export type { … }`.
  // The binding list is the ONLY position where `X as Y` is a rename.
  const clauseRe = /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}/g
  let clause: RegExpExecArray | null
  while ((clause = clauseRe.exec(source)) !== null) {
    const bindings = clause[1]
    for (const symbol of symbols) {
      const re = new RegExp(
        `(?<![\\w$])${escapeForRegExpV1(symbol)}\\s+as\\s+([A-Za-z_$][\\w$]*)`,
        'g',
      )
      let m: RegExpExecArray | null
      while ((m = re.exec(bindings)) !== null) {
        if (m[1]) renamed.add(m[1])
      }
    }
  }
  return [...renamed].sort()
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
      familyIsReferencedBy(family, source),
    )
    if (families.length === 0) continue
    anchoredFileCount += 1
    for (const alias of deriveAliasIdentifiersV1(source)) aliasIdentifiers.add(alias)

    const aliasTokens = [...FAMILY_ANCHORS.projection_owner, ...deriveAliasIdentifiersV1(source)]
    const lines = source.split('\n')
    for (const family of families) {
      const distinctive = literalRegex(FAMILY_DISTINCTIVE_LITERALS[family], isYaml)
      const ambiguous = literalRegex(FAMILY_AMBIGUOUS_LITERALS[family], isYaml)
      // The trace family's LINE-level anchors include the field spellings, not
      // just the type names: a fold built only from AMBIGUOUS members
      // (`k === 'record' ? 'record' : 'snapshot'`) names no type and carries no
      // distinctive member, so without these it would evade the line rule inside
      // an already-anchored file. The owner family is protected here only
      // because `legacy_untracked` happens to be distinctive.
      const anchorTokens =
        family === 'projection_owner'
          ? aliasTokens
          : [...FAMILY_ANCHORS[family], 'source.kind', 'sourceKind', 'traceSourceKind']
      const symbols = [
        ...FAMILY_WIDENING_SYMBOLS[family],
        ...deriveRenamedWideningSymbolsV1(source, FAMILY_WIDENING_SYMBOLS[family]),
      ]
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
        const hasWideningSymbol = symbols.some((symbol) => containsWholeTokenV1(text, symbol))
        // Evaluated over the enclosing DECLARATION, not the line. A fold's
        // return expression names the value but not the subject — the subject is
        // in the signature (`function foldKind(k: string): AttendanceDecisionTraceSourceKind`).
        // Line-scoping this check is what let an ambiguous-member fold hide.
        const namesTarget = anchorTokens.some((token) =>
          new RegExp(`\\b${token.replace('.', '\\.')}\\b`).test(enclosingDeclaration(lines, i)),
        )
        // A `switch` arm names the value but never the subject — see CASE_ARM.
        const caseArm = CASE_ARM.exec(text)
        const isFamilyCaseArm =
          caseArm !== null &&
          (FAMILY_DISTINCTIVE_LITERALS[family] as readonly string[]).concat(
            FAMILY_AMBIGUOUS_LITERALS[family] as readonly string[],
          ).includes(caseArm[1])
        const isSite =
          hasWideningSymbol ||
          distinctive.test(text) ||
          isFamilyCaseArm ||
          (ambiguous.test(text) && namesTarget)
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
          declarationHasWideningSymbol: symbols.some((symbol) =>
            containsWholeTokenV1(declaration, symbol),
          ),
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
  /**
   * An equality that SELECTS one named member (`env.source.kind === 'audit'`)
   * rather than enumerating the set. Widening cannot change its verdict for any
   * pre-existing value, and the new member correctly fails to be selected — a
   * `group_policy_snapshot` env is not an `audit` env.
   */
  | 'single_member_selector'
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
    case 'single_member_selector': {
      // Must be a POSITIVE equality naming exactly ONE member. A negation, or
      // more than one member on the line, is an exclusion/enumeration and must
      // be adjudicated as a real predicate instead.
      const members = [
        ...FAMILY_DISTINCTIVE_LITERALS[site.family],
        ...FAMILY_AMBIGUOUS_LITERALS[site.family],
      ].filter((member) => new RegExp(`['"\`]${member}['"\`]`).test(text))
      return (
        members.length === 1 &&
        /===|==|\bIS NOT DISTINCT\b/.test(text) &&
        !/!==|!=|\bNOT IN\b|\bIS DISTINCT\b/.test(text)
      )
    }
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
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: '\'audit\',', rule: 'closed_set_member_list' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: '\'group_policy_snapshot\',', rule: 'closed_set_member_list' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: '\'ledger\',', rule: 'closed_set_member_list' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: '\'policy_gate\',', rule: 'closed_set_member_list' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: '\'record\',', rule: 'closed_set_member_list' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: '\'rule_live\',', rule: 'closed_set_member_list' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: '\'snapshot\',', rule: 'closed_set_member_list' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: 'case \'audit\': return tr(\'Audit\', \'审计\')', rule: 'exhaustive_switch_arm' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: 'case \'group_policy_snapshot\': return tr(\'Group policy snapshot\', \'组策略快照\')', rule: 'exhaustive_switch_arm' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: 'case \'ledger\': return tr(\'Ledger\', \'台账\')', rule: 'exhaustive_switch_arm' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: 'case \'policy_gate\': return tr(\'Policy gate\', \'策略开关\')', rule: 'exhaustive_switch_arm' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: 'case \'record\': return tr(\'Record\', \'记录\')', rule: 'exhaustive_switch_arm' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: 'case \'rule_live\': return tr(\'Live rule\', \'活体规则\')', rule: 'exhaustive_switch_arm' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: 'case \'snapshot\': return tr(\'Frozen snapshot\', \'冻结快照\')', rule: 'exhaustive_switch_arm' },
  { file: 'apps/web/src/views/attendance/attendanceDecisionTrace.ts', text: 'const timelineEnv = parsed.basis.find((env) => env.source.kind === \'audit\' && env.source.ref === \'approval_records\')', rule: 'single_member_selector' },
  { file: 'packages/core-backend/src/attendance/w4c0-write-boundary-types.ts', text: 'projectionOwner: AttendanceProjectionOwnerV1', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: ': \'legacy_untracked\',', rule: 'widened_predicate_continuation' },
  // ⚠️ W7-1b: the hard-coded literal is GONE — this writer now DERIVES the value
  // from the calculation's own frozen context, so the two ternary arms below are
  // the derived points and the old single-literal entry is correctly stale.
  // `write_side_emitter` holds for both: neither line TESTS the value, so neither
  // can route the new member to the wrong side. The selection is made by the
  // ternary CONDITION, which compares `context.selector`, not `projection_owner`.
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: "? 'w4_group'", rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: ": 'w4'", rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: 'isAttendanceProjectionOwnerWithCalculationPointerV1(parent.projectionOwner) &&', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: 'let owner: AttendanceProjectionOwnerV1', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: 'owner = \'w4\'', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: 'projectionOwner: isAttendanceProjectionOwnerV1(row.projection_owner)', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: 'readonly projectionOwner: AttendanceProjectionOwnerV1', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c2-authoritative-calculation-core.ts', text: '} else if (parent.projectionOwner === \'legacy_untracked\' && parent.visibilityState === \'active\') {', rule: 'legacy_polarity' },
  { file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', text: ': \'legacy_untracked\',', rule: 'widened_predicate_continuation' },
  { file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', text: '\'legacy_untracked\', NULL, \'retired\', \'review_placeholder\',', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', text: 'kind: \'w4\' as const,', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', text: 'projectionOwner: AttendanceProjectionOwnerV1', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', text: 'projectionOwner: isAttendanceProjectionOwnerV1(row.projectionOwner)', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', text: 'return { kind: \'w4\', runId, rows: insertedRows, perUser }', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', text: 'return { kind: \'w4\', runId: startOutcome.runId, rows: [], perUser: [] }', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts', text: 'return { mode: \'w4\' as const, rows: [] as Array<{ user_id: string }> }', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', text: '!isAttendanceProjectionOwnerV1(projectionOwner) ||', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', text: '(isAttendanceProjectionOwnerWithCalculationPointerV1(projectionOwner) &&', rule: 'widened_predicate' },
  { file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', text: '(projectionOwner === \'legacy_untracked\' && currentCalculationId !== null) ||', rule: 'legacy_polarity' },
  { file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', text: '\'legacy_untracked\',NULL,$15,$16,now(),now()', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', text: 'if (input.preimage.projectionOwner !== \'legacy_untracked\') return', rule: 'legacy_polarity' },
  // W7-1b: same shape at P5's import writer — literal replaced by a bound
  // parameter whose value is derived from the same place.
  { file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', text: "? 'w4_group'", rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts', text: ": 'w4',", rule: 'write_side_emitter' },
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
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export const ATTENDANCE_TRACE_SOURCE_KINDS_V1 = [', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export function isAttendanceProjectionOwnerV1(value: unknown): value is AttendanceProjectionOwnerV1 {', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export function isAttendanceProjectionOwnerWithCalculationPointerV1(', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export function isAttendanceTraceSourceKindV1(value: unknown): value is AttendanceTraceSourceKindV1 {', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export type AttendanceProjectionOwnerV1 = (typeof ATTENDANCE_PROJECTION_OWNERS_V1)[number]', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'export type AttendanceTraceSourceKindV1 = (typeof ATTENDANCE_TRACE_SOURCE_KINDS_V1)[number]', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'return (ATTENDANCE_PROJECTION_OWNERS_V1 as readonly unknown[]).includes(value)', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'return (ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_V1 as readonly unknown[]).includes(value)', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts', text: 'return (ATTENDANCE_TRACE_SOURCE_KINDS_V1 as readonly unknown[]).includes(value)', rule: 'domain_definition' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: '\'audit\',', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: '\'group_policy_snapshot\',', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: '\'ledger\',', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: '\'policy_gate\',', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: '\'record\',', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: '\'rule_live\',', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: '\'snapshot\',', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: 'currentMembers: Object.freeze([\'legacy_untracked\', \'w4\', \'w4_group\'] as const),', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: 'export const ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1 = \'w4_group\' as const', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: 'export const ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1 = \'group_policy_snapshot\' as const', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: 'newValue: ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1,', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/attendance/w7-read-side-provenance-amendment.ts', text: 'newValue: ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1,', rule: 'w7_0_recorded_snapshot' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'basis.push({ source: { kind: \'policy_gate\', ref: \'auto_absence_generation\' }, version: { posture: \'undeterminable\' } })', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'return { source: { kind: \'rule_live\', ref: \'none\' }, version: { posture: \'undeterminable\' } }', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'return { source: { kind: \'rule_live\', ref: rule.refKind }, version: { posture: \'current_live_no_history\' } }', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'source: { kind: \'audit\', ref: \'approval_records\' },', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'source: { kind: \'policy_gate\', ref: \'ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED\' },', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'source: { kind: \'policy_gate\', ref: \'compTimeFromOvertime\' },', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'source: { kind: \'policy_gate\', ref: \'overtimeSegmentation\' },', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'source: { kind: \'record\', ref: \'approval_assignments\' },', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'source: { kind: \'rule_live\', ref: \'attendance_overtime_rules\' },', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'source: { kind: \'snapshot\', ref: \'approval_instances.metadata.approvalFlow\' },', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: 'source: { kind: \'snapshot\', ref: \'approval_instances.requester_snapshot\' },', rule: 'write_side_emitter' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: '| \'audit\'', rule: 'closed_set_member_list' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: '| \'group_policy_snapshot\'', rule: 'closed_set_member_list' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: '| \'ledger\'', rule: 'closed_set_member_list' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: '| \'policy_gate\'', rule: 'closed_set_member_list' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: '| \'record\'', rule: 'closed_set_member_list' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: '| \'rule_live\'', rule: 'closed_set_member_list' },
  { file: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts', text: '| \'snapshot\'', rule: 'closed_set_member_list' },
  { file: 'packages/core-backend/src/services/AttendanceW4CalculationDetail.ts', text: 'const PROJECTION_OWNERS = ATTENDANCE_PROJECTION_OWNERS_V1', rule: 'widened_predicate' },
  { file: 'packages/openapi/src/base.yml', text: 'projectionOwner: { type: string, enum: [legacy_untracked, w4, w4_group] }', rule: 'closed_set_member_list' },
  { file: 'scripts/attendance/execute-ops-retirement-cleanup.cjs', text: 'if (row.projection_owner != null && row.projection_owner !== \'legacy_untracked\') return true', rule: 'legacy_polarity' },
  { file: 'scripts/attendance/generate-cleanup-sql.cjs', text: 'OR r.projection_owner IS DISTINCT FROM \'legacy_untracked\'', rule: 'legacy_polarity' },
  { file: 'scripts/ops/staging-attendance-tooling-teardown.mjs', text: 'AND projection_owner IS NOT DISTINCT FROM \'legacy_untracked\'', rule: 'legacy_polarity' },
  { file: 'scripts/ops/staging-attendance-tooling-teardown.mjs', text: 'OR projection_owner IS DISTINCT FROM \'legacy_untracked\'', rule: 'legacy_polarity' },
  { file: 'scripts/ops/staging-attendance-tooling-teardown.mjs', text: '|| (row.projection_owner != null && row.projection_owner !== \'legacy_untracked\')', rule: 'legacy_polarity' },
] as W7LedgerEntryV1[])
