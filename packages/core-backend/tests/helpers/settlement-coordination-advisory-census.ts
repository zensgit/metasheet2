/**
 * Census of every two-int4 advisory lock call in production source (implementation lock §2, guard ④).
 *
 * Two-int4 keys share one lock space (`pg_locks.objsubid = 2`), so the coordination key
 * `(0x4D533243, key2)` must not be reachable by any other caller whose key1 is a constant. A key1 can
 * be a constant without being a literal: most constant users pass the namespace as a bind parameter
 * (`hashtext($1)` with a fixed string, or `$1::int` with a fixed number), which a literal-only scan
 * cannot see. So the population is closed-world: the scanner below finds every call with two
 * arguments, and every call must match exactly one entry here.
 *   - `constant` entries name the registry entries (`ADVISORY_FIXED_KEY1_REGISTRY`) whose values the
 *     site can take, plus the evidence that ties the site to them (a quoted literal or an exported
 *     constant in the same file). Values are computed in PostgreSQL by the real-database guard.
 *   - `variable` entries derive key1 from per-org or per-request data; they are covered by the
 *     collision bound in §2, not by the registry.
 *   - `doc-comment` entries are calls written inside comments; they are matched so the scan stays
 *     closed, and they name the namespace they document.
 * A site is identified by its file, its key1 expression and a `window` substring that must occur in
 * the text from the call up to the next advisory call (at most 16 lines), which is where the bound
 * values are written. Executable sites are matched on that text with comments removed, so a
 * commented-out binding cannot stand in for the real one.
 *
 * Arguments are read twice: once counting every top-level comma, once skipping quoted text and SQL
 * comments. A call the two readings disagree on, that does not close, or whose argument count is not
 * 1 or 2 is an anomaly and fails the guard: in a closed world, "cannot read" must not pass as "not a
 * two-int4 call".
 */
import fs from 'node:fs'
import path from 'node:path'

export interface AdvisoryTwoInt4SiteV1 {
  readonly file: string
  readonly line: number
  readonly fn: string
  readonly key1: string
  readonly key2: string
  /** Text from the call to the next advisory mention (at most 16 lines). */
  readonly window: string
  /** `window` with `/* … *\/` blocks and `//` line comments removed. */
  readonly code: string
}

const ROOTS = ['packages', 'plugins', 'scripts']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '__tests__', 'tests', '__fixtures__'])
const EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.cjs', '.mjs', '.sql'])
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]s$/
const ADVISORY_CALL = /pg_(?:try_)?advisory_(?:xact_)?(?:un)?lock(?:_shared)?\s*\(/gi
const ANY_ADVISORY_MENTION = /pg_(?:try_)?advisory_/gi
const WINDOW_LINES = 16

export function listProductionSourceFiles(repoRoot: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
      } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name)) && !TEST_FILE.test(entry.name)) {
        files.push(full)
      }
    }
  }
  for (const root of ROOTS) walk(path.join(repoRoot, root))
  return files
}

const SCAN_LIMIT = 2000

/** Number of top-level arguments counting every comma, quoted or not; null when the call does not close. */
function naiveArity(text: string, start: number): number | null {
  let depth = 1
  let arity = 1
  for (let i = start; i < text.length && i < start + SCAN_LIMIT; i += 1) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return arity
    } else if (ch === ',' && depth === 1) arity += 1
  }
  return null
}

/**
 * Top-level arguments with quoted text ('…', "…") kept intact and SQL comments (`/* … *\/`, `-- …`)
 * dropped; null when the call does not close.
 */
function awareArguments(text: string, start: number): string[] | null {
  const args: string[] = []
  let depth = 1
  let current = ''
  let quote: string | null = null
  for (let i = start; i < text.length && i < start + SCAN_LIMIT; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) return null
      i = end + 1
      continue
    }
    if (ch === '-' && next === '-') {
      const end = text.indexOf('\n', i + 2)
      if (end < 0) return null
      i = end
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(') {
      depth += 1
      current += ch
    } else if (ch === ')') {
      depth -= 1
      if (depth === 0) {
        args.push(current.trim())
        return args
      }
      current += ch
    } else if (ch === ',' && depth === 1) {
      args.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  return null
}

/** Removes `/* … *\/` blocks and `//` line comments (a `//` preceded by `:` — a URL — is kept). */
export function stripCodeComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
}

const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()

export function scanTwoInt4AdvisorySites(repoRoot: string): {
  files: number
  calls: number
  sites: AdvisoryTwoInt4SiteV1[]
  anomalies: string[]
} {
  const files = listProductionSourceFiles(repoRoot)
  const sites: AdvisoryTwoInt4SiteV1[] = []
  const anomalies: string[] = []
  let calls = 0
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    const relative = path.relative(repoRoot, file).split(path.sep).join('/')
    for (const match of text.matchAll(ADVISORY_CALL)) {
      calls += 1
      const start = (match.index ?? 0) + match[0].length
      const naive = naiveArity(text, start)
      const args = awareArguments(text, start)
      const line = text.slice(0, match.index).split('\n').length
      if (naive === null || args === null || naive !== args.length || (args.length !== 1 && args.length !== 2)) {
        anomalies.push(`${relative}:${line} (counting every comma: ${String(naive)}, skipping quotes and comments: ${String(args?.length ?? null)})`)
        continue
      }
      if (args.length !== 2) continue
      ANY_ADVISORY_MENTION.lastIndex = start
      const next = ANY_ADVISORY_MENTION.exec(text)
      let end = text.length
      let newlines = 0
      for (let i = match.index ?? 0; i < text.length; i += 1) {
        if (text[i] === '\n' && (newlines += 1) > WINDOW_LINES) {
          end = i
          break
        }
      }
      if (next && next.index < end) end = next.index
      const window = text.slice(match.index, end)
      sites.push({
        file: relative,
        line,
        fn: match[0].replace(/\s*\($/, '').toLowerCase(),
        key1: normalize(args[0]),
        key2: normalize(args[1]),
        window,
        code: stripCodeComments(window),
      })
    }
  }
  return { files: files.length, calls, sites, anomalies }
}

/** The text a census entry is matched against: comments removed, except for calls that live in comments. */
export function censusHaystack(entry: Pick<AdvisoryTwoInt4CensusEntryV1, 'kind'>, site: AdvisoryTwoInt4SiteV1): string {
  return entry.kind === 'doc-comment' ? site.window : site.code
}

export type AdvisoryTwoInt4CensusEntryV1 = Readonly<{
  file: string
  key1: string
  /** Substring of the site's window that identifies it among same-file, same-key1 sites. */
  window: string
  /** Number of sites this entry stands for (default 1). */
  count?: number
  kind: 'constant' | 'variable' | 'doc-comment'
  /** constant / doc-comment: registry entry names whose value the site's key1 takes. */
  registry?: readonly string[]
  /** constant: each must appear quoted (`'…'`) in the same file. */
  boundLiterals?: readonly string[]
  /** constant: exported constants in the same file whose value the registry entry must equal. */
  boundConstants?: readonly Readonly<{ name: string; registry: string }>[]
  /** constant through a helper: every call of `helper(` in the file passes one of `boundLiterals` at `argIndex`. */
  helper?: Readonly<{ name: string; argIndex: number }>
  /** What key1 is bound to, with the evidence. */
  binding: string
}>

const CORE = 'packages/core-backend/src'
const ATT = 'plugins/plugin-attendance/index.cjs'

export const ADVISORY_TWO_INT4_CENSUS_V1: readonly AdvisoryTwoInt4CensusEntryV1[] = Object.freeze([
  // The coordination module itself.
  { file: `${CORE}/attendance/coordination/settlement-coordination-statements.ts`, key1: '${KEY1_LITERAL}', window: '', count: 9, kind: 'constant', registry: ['attendance-settlement-coordination'], binding: 'KEY1_LITERAL = (0x4D533243)::int4 inlined by the S1 / S2 / unlock builders' },
  // Constant key1 written as a literal.
  { file: `${CORE}/audit/AuditRepository.ts`, key1: "hashtext('audit_logs_partition')", window: '', count: 3, kind: 'constant', registry: ['audit-logs-partition'], binding: 'literal in the partition maintenance SQL' },
  { file: `${CORE}/db/migrations/zzzz20260830123000_create_elearning_titles.ts`, key1: "hashtext('elearning-title-balance-org')", window: '', kind: 'constant', registry: ['elearning-title-balance-org'], binding: 'literal in the trigger function' },
  // Constant key1 passed as a bind parameter.
  { file: `${CORE}/multitable/stock-preparation-persist-unit-of-work.ts`, key1: '$1::int', window: 'STOCK_PREPARATION_PROJECT_LOCK_NS', kind: 'constant', registry: ['stock-preparation-project'], boundConstants: [{ name: 'STOCK_PREPARATION_PROJECT_LOCK_NS', registry: 'stock-preparation-project' }], binding: 'params [STOCK_PREPARATION_PROJECT_LOCK_NS, …]' },
  { file: `${CORE}/multitable/stock-preparation-persist-unit-of-work.ts`, key1: '$1::int', window: 'STOCK_PREPARATION_BATCH_LOCK_NS', kind: 'constant', registry: ['stock-preparation-batch'], boundConstants: [{ name: 'STOCK_PREPARATION_BATCH_LOCK_NS', registry: 'stock-preparation-batch' }], binding: 'params [STOCK_PREPARATION_BATCH_LOCK_NS, …]' },
  { file: `${CORE}/integration/yida-initialization-bootstrap.ts`, key1: '$1::integer', window: 'YIDA_INITIALIZATION_LOCK_NS', kind: 'constant', registry: ['yida-initialization-slot'], boundConstants: [{ name: 'YIDA_INITIALIZATION_LOCK_NS', registry: 'yida-initialization-slot' }], binding: 'params [YIDA_INITIALIZATION_LOCK_NS, 1] (ASCII YIDA, permanent slot 1)' },
  { file: `${CORE}/services/stock-preparation-members.ts`, key1: 'hashtext($1::text)', window: 'STOCK_PREP_MEMBERS_ADVISORY_LOCK_KEY', kind: 'constant', registry: ['stock-prep-members'], boundConstants: [{ name: 'STOCK_PREP_MEMBERS_NAMESPACE', registry: 'stock-prep-members' }], binding: 'SQL constant used with [...STOCK_PREP_MEMBERS_ADVISORY_LOCK_KEY] = [STOCK_PREP_MEMBERS_NAMESPACE, \'members-port\']' },
  { file: `${CORE}/services/elearning-title-surface.ts`, key1: 'hashtext($1)', window: "'elearning-title-request'", kind: 'constant', registry: ['elearning-title-request'], boundLiterals: ['elearning-title-request'], binding: "params ['elearning-title-request', …]" },
  { file: `${CORE}/services/elearning-title-surface.ts`, key1: 'hashtext($1)', window: "'elearning-title-head'", kind: 'constant', registry: ['elearning-title-head'], boundLiterals: ['elearning-title-head'], binding: "params ['elearning-title-head', orgId]" },
  { file: `${CORE}/services/elearning-title-surface.ts`, key1: 'hashtext($1)', window: "'elearning-title-balance-org'", kind: 'constant', registry: ['elearning-title-balance-org'], boundLiterals: ['elearning-title-balance-org'], binding: "params ['elearning-title-balance-org', orgId]" },
  { file: `${CORE}/services/elearning-credit-surface.ts`, key1: 'hashtext($1)', window: "'elearning-credit-rule-request'", kind: 'constant', registry: ['elearning-credit-rule-request'], boundLiterals: ['elearning-credit-rule-request'], binding: "params ['elearning-credit-rule-request', …]" },
  { file: `${CORE}/services/elearning-credit-surface.ts`, key1: 'hashtext($1)', window: "'elearning-credit-rule-behavior'", kind: 'constant', registry: ['elearning-credit-rule-behavior'], boundLiterals: ['elearning-credit-rule-behavior'], binding: "params ['elearning-credit-rule-behavior', …]" },
  { file: `${CORE}/services/elearning-analytics-export.ts`, key1: 'hashtext($1)', window: "'elearning-analytics-export-request'", kind: 'constant', registry: ['elearning-analytics-export-request'], boundLiterals: ['elearning-analytics-export-request'], binding: "params ['elearning-analytics-export-request', …]" },
  { file: `${CORE}/services/elearning-portal-settings.ts`, key1: 'hashtext($1)', window: "'elearning-portal-request'", kind: 'constant', registry: ['elearning-portal-request'], boundLiterals: ['elearning-portal-request'], binding: "params ['elearning-portal-request', …]" },
  { file: `${CORE}/services/elearning-portal-settings.ts`, key1: 'hashtext($1)', window: "'elearning-portal-head'", kind: 'constant', registry: ['elearning-portal-head'], boundLiterals: ['elearning-portal-head'], binding: "params ['elearning-portal-head', orgId]" },
  { file: `${CORE}/services/elearning-credit-adjustment-postgres.ts`, key1: 'hashtext($1)', window: "'elearning-credit-adjustment-request'", kind: 'constant', registry: ['elearning-credit-adjustment-request'], boundLiterals: ['elearning-credit-adjustment-request'], binding: "params ['elearning-credit-adjustment-request', …]" },
  {
    file: `${CORE}/services/elearning-question-practice-postgres.ts`,
    key1: 'hashtext($1)',
    window: '[domain, identity]',
    kind: 'constant',
    registry: ['elearning-practice-set-request', 'elearning-practice-session-request', 'elearning-practice-answer-request', 'elearning-practice-question-answer', 'elearning-practice-wrong-projection'],
    boundLiterals: ['elearning-practice-set-request', 'elearning-practice-session-request', 'elearning-practice-answer-request', 'elearning-practice-question-answer', 'elearning-practice-wrong-projection'],
    helper: { name: 'advisoryLock', argIndex: 1 },
    binding: 'helper advisoryLock(tx, domain, identity); every caller passes a literal domain',
  },
  { file: `${CORE}/services/elearning-certificate-surface.ts`, key1: 'hashtext($1)', window: "'elearning-certificate-template-request'", kind: 'constant', registry: ['elearning-certificate-template-request'], boundLiterals: ['elearning-certificate-template-request'], binding: "params ['elearning-certificate-template-request', …]" },
  { file: `${CORE}/services/elearning-certificate-surface.ts`, key1: 'hashtext($1)', window: "'elearning-certificate-template-head'", kind: 'constant', registry: ['elearning-certificate-template-head'], boundLiterals: ['elearning-certificate-template-head'], binding: "params ['elearning-certificate-template-head', …]" },
  { file: `${CORE}/services/elearning-certificate-surface.ts`, key1: 'hashtext($1)', window: "'elearning-certificate-issue-request'", kind: 'constant', registry: ['elearning-certificate-issue-request'], boundLiterals: ['elearning-certificate-issue-request'], binding: "params ['elearning-certificate-issue-request', …]" },
  { file: `${CORE}/services/elearning-notification-delivery.ts`, key1: 'hashtext($1)', window: 'ELEARNING_NOTIFICATION_LOCK_NAMESPACE', kind: 'constant', registry: ['elearning-notification-delivery'], boundConstants: [{ name: 'ELEARNING_NOTIFICATION_LOCK_NAMESPACE', registry: 'elearning-notification-delivery' }], binding: 'params [ELEARNING_NOTIFICATION_LOCK_NAMESPACE, …]' },
  { file: ATT, key1: 'hashtext($1::text)', window: "'attendance-schedule-group-member'", kind: 'constant', registry: ['attendance-schedule-group-member'], boundLiterals: ['attendance-schedule-group-member'], binding: "params ['attendance-schedule-group-member', …]" },
  { file: ATT, key1: 'hashtext($1::text)', window: "'attendance-schedule-group-tree'", kind: 'constant', registry: ['attendance-schedule-group-tree'], boundLiterals: ['attendance-schedule-group-tree'], binding: "params ['attendance-schedule-group-tree', orgId]" },
  // Variable key1 (per-org or per-request data): covered by the §2 collision bound.
  { file: `${CORE}/attendance/w4c0-identity.ts`, key1: 'hashtext($1::text)', window: '[parsed.orgId, parsed.idempotencyKey]', kind: 'variable', binding: 'org id' },
  { file: `${CORE}/attendance/w7-resolver/w7-composite-lock-order.ts`, key1: 'hashtext($1::text)', window: 'buildAttendanceW7ScheduleFactsLockKeyV1(input.orgKey)', kind: 'variable', binding: '`attendance-schedule:${orgKey}`' },
  { file: ATT, key1: 'hashtext($1::text)', window: "[String(orgId ?? ''), clean]", count: 2, kind: 'variable', binding: 'org id' },
  { file: ATT, key1: 'hashtext($1::text)', window: "String(orgId ?? '') + ':' + String(userId ?? '')", kind: 'variable', binding: 'org id : user id' },
  { file: ATT, key1: 'hashtext($1::text)', window: "`attendance-schedule:${String(orgId ?? '').trim().toLowerCase()}`", count: 2, kind: 'variable', binding: '`attendance-schedule:${canonical org}` (writer and shared reader)' },
  { file: ATT, key1: 'hashtext($1::text)', window: '[orgId, sourceId]', count: 2, kind: 'variable', binding: 'org id' },
  { file: ATT, key1: 'hashtext($1::text)', window: 'attendance-schedule-dispatch:', kind: 'variable', binding: '`attendance-schedule-dispatch:${orgId}`' },
  { file: ATT, key1: 'hashtext($1::text)', window: 'attendance:otbank-cap:', kind: 'variable', binding: '`attendance:otbank-cap:${orgId}:${userId}`' },
  // Calls written inside documentation comments.
  { file: `${CORE}/multitable/canonical-sheet-fence.ts`, key1: 'PIT_RECOVERY_LOCK_NS::int', window: '', count: 2, kind: 'doc-comment', registry: ['multitable-pit-recovery'], boundConstants: [{ name: 'PIT_RECOVERY_LOCK_NS', registry: 'multitable-pit-recovery' }], binding: 'doc comments describing the PIT recovery namespace int' },
])
