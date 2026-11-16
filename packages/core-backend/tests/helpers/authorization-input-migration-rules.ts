/**
 * The rule a migration outside the frozen list must satisfy, and the traversal that applies it.
 *
 * A migration that writes an input table must contain the bounded try form of the world lock
 * inside one statement literal together with its retry-loop marks, and no blocking form. A write
 * is one the scan reports, or one the judgment takes for a write of an input table: an input table
 * named with another schema or after a substituted one, and a target that is not read where it may
 * be an input table.
 * Every statement that writes an input table must be judged `safe`. In a new migration (one whose path is
 * not in the pinned set of historical migration files) every judged statement must be `safe`,
 * whether or not it writes: schema changes, helper calls and literals that mention an input table
 * are judged as well. Every write the scanner reports must lie inside a judged statement.
 *
 * A verdict that stands only for dynamic targets is set aside when the registry carries an
 * exemption for the file and the form whose count equals the number of such targets found in the
 * file and whose reachable tables are plain table names, none of them an input table or a cascade
 * parent however it is spelled. Nothing else about the statement is set aside, and a substituted
 * SET clause of a `users` UPDATE is never exempt.
 *
 * One more set-aside exists, and only one: the pinned statements of the D21 authorization-version
 * migration (owner ruling 2026-11-16 「按建议，A」). What it guarantees: the five CREATE TRIGGER
 * statements and the five tolerant DROP TRIGGER statements on input tables written below are set
 * aside only in the reviewed D21 file, at its exact path and byte-identical to the reviewed content
 * modulo CRLF (the sha256 of the source with every CRLF turned into LF equals
 * `D21_AUTHORIZATION_VERSION_MIGRATION_SHA256`; a lone carriage return is a byte of its own). Any
 * other content, at that path or at any other, has the ten judged as on main: ten problems. The
 * conditions read before the digest was added still hold on top of it: the ten are set aside
 * together or not at all, each found exactly once with exactly its pinned verdict, as written where
 * it is pinned to stand (a CREATE at the top of an SQL text, a DROP as the piece of a `DO` body that
 * its pinned `to_regclass` guard begins; `at` is a syntactic shape of the literal, see
 * `WrittenStatement`), and never in a file that holds white space PostgreSQL does not read as the
 * judge does (anything `\s` matches but space, tab, line feed and carriage return), as written or as
 * the value of a literal.
 *
 * What it does not guarantee: the judge reads literals, not what runs. A runner wrapped or replaced
 * where the literal is passed to it, a runner or a helper of the D21 file used from another module
 * (another migration importing the D21 helpers and calling them with a wrapping object), and SQL
 * computed at run time (`String.fromCharCode`, values read from elsewhere) are outside what a
 * single-file literal judge can see. That limit is not new with the pin: it holds on main for every
 * migration. Within the D21 file the digest leaves no shape to read: what may be set aside is only
 * the content that was reviewed as a whole. Another module that reuses the D21 helpers is judged by
 * its own literals only.
 *
 * Any later edit of the D21 migration, a rebase that changes a byte of it included, needs the
 * digest re-pinned; that is a change of the AIS contract and is reviewed as one.
 *
 * A function body is not part of the pin: the trigger function is judged by the rules for every
 * function definition, and the database census pins what the triggers run.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS,
  AUTHORIZATION_INPUT_MIGRATION_LOCK_BLOCK_MARKS,
  AUTHORIZATION_INPUT_MIGRATION_LOCK_FORM,
} from '../../src/rbac/authorization-input-writers'
import type { AuthorizationInputDynamicExemption, AuthorizationInputDynamicForm, AuthorizationInputMigrationVerdict } from '../../src/rbac/authorization-input-writers'
import { judgeMigrationInputWrites } from './authorization-input-migration-judge'
import type { MigrationJudgment } from './authorization-input-migration-judge'
import { commentStrippedText, INPUT_TABLES, literalSqlTexts, literalTexts, scanSource, scanText, SCANNED_TABLES, SOURCE_EXTENSIONS } from './authorization-input-scan'
import type { LiteralWrite } from './authorization-input-scan'

export const COMPLIANT_LOCK_BLOCK = `DO $$ DECLARE attempt int := 0; BEGIN LOOP EXIT WHEN ${AUTHORIZATION_INPUT_MIGRATION_LOCK_FORM}; attempt := attempt + 1; IF attempt >= 25 THEN RAISE EXCEPTION USING ERRCODE = '55P03'; END IF; PERFORM pg_sleep(0.2); END LOOP; END $$`

/* ───────────────────────────── historical migration files ───────────────────────────── */

const HISTORICAL_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'authorization-input-historical-migrations.json')

/** The migration files of both streams that existed when the statement-kind rules were introduced, by repository path. */
export function historicalMigrationFiles(): readonly string[] {
  return JSON.parse(fs.readFileSync(HISTORICAL_FIXTURE, 'utf8')) as string[]
}

export function digestOfFiles(files: readonly string[]): string {
  return createHash('sha256').update(files.join('\n')).digest('hex')
}

const HISTORICAL: ReadonlySet<string> = new Set(historicalMigrationFiles())

/** A migration is new when its path is not a historical one; its timestamp plays no part, so a back-dated file is new. */
export function isNewMigration(file: string): boolean {
  return !HISTORICAL.has(file)
}

/* ───────────────────────────── the rule ───────────────────────────── */

export type MigrationVerdictLine = Readonly<{ verdict: AuthorizationInputMigrationVerdict; kind: string; detail: string; table?: string; value?: string }>

export type MigrationCheck = Readonly<{
  problems: readonly string[]
  /** Every enforced judgment that is not `safe`. */
  verdicts: readonly MigrationVerdictLine[]
  inputWrites: number
}>

/** Writes the scanner reports that no judged statement contains, as `table|verb`. */
export function closureProblems(scanned: readonly LiteralWrite[], judged: ReadonlyMap<string, number>): string[] {
  const problems: string[] = []
  const counts = new Map<string, number>()
  for (const write of scanned) counts.set(`${write.table}|${write.verb}`, (counts.get(`${write.table}|${write.verb}`) ?? 0) + 1)
  for (const [key, count] of [...counts].sort()) if ((judged.get(key) ?? 0) < count) problems.push(`write outside the judged statements: ${key}`)
  return problems
}

function problemOf(judgment: MigrationJudgment): string {
  if (judgment.verdict === 'raising' || judgment.forbiddenTable) return judgment.detail
  return `unreadable ${judgment.kind}: ${judgment.detail}`
}

/** The dynamic forms an exemption can cover in a migration. A substituted SET clause of a `users` UPDATE targets an input table and is not among them. */
const EXEMPTIBLE_DYNAMIC_FORMS: ReadonlySet<AuthorizationInputDynamicForm> = new Set(['template_substitution', 'concatenation', 'query_builder_non_literal', 'helper_table_argument', 'dynamic_statement'])

/** The dynamic forms only the migration judgment finds; the write scan does not report them. */
export const JUDGED_ONLY_DYNAMIC_FORMS: readonly AuthorizationInputDynamicForm[] = ['helper_table_argument', 'dynamic_statement']

const MIGRATION_ROOTS = ['packages/core-backend/src/db/migrations/', 'packages/core-backend/migrations/']
const PLAIN_TABLE_NAME = /^[a-z_][a-z0-9_]*$/

/** Whether `file` lies in one of the two migration streams. */
export function isMigrationPath(file: string): boolean {
  return MIGRATION_ROOTS.some((root) => file.startsWith(root))
}

/**
 * A reachable table of an exemption, read as the table it names: double quotes, the schema and the
 * white space around the name removed, case folded. A spelling that is not a table name (a
 * pattern, a placeholder) stays what it is.
 */
export function reachableTableName(item: string): string {
  const parts = item.replace(/"/g, '').split('.')
  return parts[parts.length - 1].trim().toLowerCase()
}

/**
 * The dynamic forms of `file` that the registered exemptions cover: per form, the registered counts
 * add up to the number of targets found, and every registered exemption of that form names its
 * reachable tables, each of them a plain table name that is neither an input table nor a cascade
 * parent under any spelling. A pattern or a placeholder covers nothing in a migration.
 */
export function exemptDynamicForms(file: string, found: ReadonlyMap<string, number>, exemptions: readonly AuthorizationInputDynamicExemption[]): ReadonlySet<string> {
  const exempt = new Set<string>()
  const unusable = (table: string): boolean => {
    const name = reachableTableName(table)
    return SCANNED_TABLES.has(name) || !PLAIN_TABLE_NAME.test(name)
  }
  for (const form of EXEMPTIBLE_DYNAMIC_FORMS) {
    const registered = exemptions.filter((exemption) => exemption.file === file && exemption.form === form)
    if (registered.length === 0) continue
    if (registered.reduce((sum, exemption) => sum + exemption.count, 0) !== (found.get(form) ?? 0)) continue
    if (registered.some((exemption) => exemption.reachableTables.length === 0 || exemption.reachableTables.some(unusable))) continue
    exempt.add(form)
  }
  return exempt
}

/**
 * Problems with the reachable tables of registered exemptions: one that is an input table or a
 * cascade parent under any spelling, and, in a migration, one that is not a plain table name. The
 * migration helper module is not a migration: its dynamic target takes the table from its caller.
 */
export function reachableTableProblems(exemptions: readonly AuthorizationInputDynamicExemption[], helperModule: string): string[] {
  const problems: string[] = []
  for (const exemption of exemptions) {
    for (const table of exemption.reachableTables) {
      const name = reachableTableName(table)
      if (SCANNED_TABLES.has(name)) problems.push(`${exemption.id}: reaches ${name}`)
      else if (isMigrationPath(exemption.file) && exemption.file !== helperModule && !PLAIN_TABLE_NAME.test(name)) problems.push(`${exemption.id}: ${table} is not a plain table name`)
    }
  }
  return problems
}

/**
 * Registered exemptions of a form only the judgment finds, checked against the file each names:
 * the file exists, and the judgment finds in it exactly the registered number of such targets.
 * `sourceOf` returns null for a file that does not exist.
 */
export function judgedOnlyExemptionProblems(exemptions: readonly AuthorizationInputDynamicExemption[], sourceOf: (file: string) => string | null): string[] {
  const registered = new Map<string, number>()
  for (const exemption of exemptions) {
    if (!JUDGED_ONLY_DYNAMIC_FORMS.includes(exemption.form)) continue
    const key = `${exemption.file}|${exemption.form}`
    registered.set(key, (registered.get(key) ?? 0) + exemption.count)
  }
  const problems: string[] = []
  for (const [key, count] of [...registered].sort()) {
    const [file, form] = key.split('|')
    const source = sourceOf(file)
    if (source === null) {
      problems.push(`${key}: the file does not exist`)
      continue
    }
    const found = judgeMigrationInputWrites(file, source).dynamic.get(form) ?? 0
    if (found !== count) problems.push(`${key}: registered ${count}, found ${found}`)
  }
  return problems
}

/* ───────────────────────────── pinned statements ───────────────────────────── */

/** One statement a pinned set names: its verdict exactly, and the statement as written and where it stands (`WrittenStatement`). */
export type PinnedStatement = Readonly<{ kind: string; detail: string; text: string; written: string; at: 'text' | 'block' }>

/**
 * Statements of one migration that are set aside together, or not at all, and only in the reviewed
 * content of that migration: `sha256` is the digest (`migrationSourceDigest`) of that content.
 */
export type PinnedStatementSet = Readonly<{ id: string; file: string; sha256: string; reason: string; statements: readonly PinnedStatement[] }>

const DEFINES_OVER_INPUT = 'defines an object over an input table'
const KIND_NOT_SAFE = 'statement kind is not on the safe list'
const pinnedCreate = (text: string): PinnedStatement => ({ kind: 'CREATE TRIGGER', detail: DEFINES_OVER_INPUT, text, written: text, at: 'text' })
/** A tolerant drop: the one statement of the `IF to_regclass('public.<table>') IS NOT NULL THEN` branch that opens its `DO` body. */
const pinnedDrop = (table: string, text: string): PinnedStatement => ({ kind: 'DROP TRIGGER', detail: KIND_NOT_SAFE, text, written: `BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ${text}`, at: 'block' })

export const D21_AUTHORIZATION_VERSION_MIGRATION = 'packages/core-backend/src/db/migrations/zzzz20261106110500_add_authorization_version_rows.ts'

/**
 * The reviewed content of the D21 migration: the sha256 of its LF blob at Y5a 3e597a2f5 (blob
 * f60b0a2ec8f4, 23934 bytes, no carriage return). The pinned statements are set aside in no other
 * content. Re-pin note: any later edit of the D21 migration, a byte changed by a rebase included,
 * needs this digest re-pinned, and that is a change of the AIS contract, reviewed as one.
 */
export const D21_AUTHORIZATION_VERSION_MIGRATION_SHA256 = 'a7b1c9b2d8420b1e7999dff3da86786ae1b4c95ca8f7394eb5ae1fe8faefe105'

/**
 * The digest a pinned set compares: sha256 of the UTF-8 text the judge reads, with every CRLF
 * turned into LF and nothing else changed, so a Windows checkout of the same blob has the same
 * digest while a lone carriage return (which PostgreSQL and JavaScript read as a line end) is a
 * byte of its own.
 */
export function migrationSourceDigest(source: string): string {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

/**
 * The D21 subject-version triggers on input tables (owner ruling 2026-11-16 「按建议，A」). Each runs
 * `public.metasheet_authz_bump_subject_authorization_version`, which writes only
 * `subject_authorization_versions`; the census of the database pins the triggers on input tables.
 */
export const D21_PINNED_TRIGGER_STATEMENTS: PinnedStatementSet = Object.freeze({
  id: 'AIS-PIN-D21',
  file: D21_AUTHORIZATION_VERSION_MIGRATION,
  sha256: D21_AUTHORIZATION_VERSION_MIGRATION_SHA256,
  reason: 'D21 authorization version rows: BEFORE ROW triggers that bump subject_authorization_versions; owner ruling 2026-11-16 option A',
  statements: Object.freeze([
    pinnedCreate("CREATE TRIGGER trg_user_roles_zz_authz_subject_version BEFORE INSERT OR UPDATE OR DELETE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public.metasheet_authz_bump_subject_authorization_version('user_id')"),
    pinnedCreate("CREATE TRIGGER trg_user_permissions_zz_authz_subject_version BEFORE INSERT OR UPDATE OR DELETE ON public.user_permissions FOR EACH ROW EXECUTE FUNCTION public.metasheet_authz_bump_subject_authorization_version('user_id')"),
    pinnedCreate("CREATE TRIGGER trg_user_namespace_admissions_zz_authz_subject_version BEFORE INSERT OR UPDATE OR DELETE ON public.user_namespace_admissions FOR EACH ROW EXECUTE FUNCTION public.metasheet_authz_bump_subject_authorization_version('user_id')"),
    pinnedCreate("CREATE TRIGGER trg_users_zz_authz_subject_version_update BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.metasheet_authz_bump_subject_authorization_version('id', 'role,is_active,activation_status,permissions,is_admin')"),
    pinnedCreate("CREATE TRIGGER trg_users_zz_authz_subject_version_lifecycle BEFORE INSERT OR DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION public.metasheet_authz_bump_subject_authorization_version('id')"),
    pinnedDrop('user_roles', 'DROP TRIGGER IF EXISTS trg_user_roles_zz_authz_subject_version ON public.user_roles'),
    pinnedDrop('user_permissions', 'DROP TRIGGER IF EXISTS trg_user_permissions_zz_authz_subject_version ON public.user_permissions'),
    pinnedDrop('user_namespace_admissions', 'DROP TRIGGER IF EXISTS trg_user_namespace_admissions_zz_authz_subject_version ON public.user_namespace_admissions'),
    pinnedDrop('users', 'DROP TRIGGER IF EXISTS trg_users_zz_authz_subject_version_update ON public.users'),
    pinnedDrop('users', 'DROP TRIGGER IF EXISTS trg_users_zz_authz_subject_version_lifecycle ON public.users'),
  ]),
})

export const AUTHORIZATION_INPUT_PINNED_STATEMENT_SETS: readonly PinnedStatementSet[] = Object.freeze([D21_PINNED_TRIGGER_STATEMENTS])

/**
 * Whether `judgment`, whose statement text is the pinned one, is `pinned` as it stands: its exact
 * verdict, nothing else about it, and the statement as written where it is pinned to stand.
 */
function isPinnedAsWritten(judgment: MigrationJudgment, pinned: PinnedStatement): boolean {
  return (
    judgment.verdict === 'unreadable' &&
    judgment.kind === pinned.kind &&
    judgment.detail === pinned.detail &&
    !judgment.inputWrite &&
    judgment.table === undefined &&
    judgment.raises === undefined &&
    judgment.forbiddenTable === undefined &&
    judgment.dynamic === undefined &&
    judgment.statement?.written === pinned.written &&
    judgment.statement.at === pinned.at
  )
}

/**
 * White space PostgreSQL does not read as the judge does: every character JavaScript's `\s` matches
 * except space, tab, line feed and carriage return (form feed, vertical tab, no-break space, U+FEFF,
 * the line and paragraph separators and the other Unicode spaces). The judge separates tokens at
 * each of them; PostgreSQL reads most of them as part of a token, so the statement it runs is not the
 * statement the judge read.
 */
const WHITE_SPACE_NOT_READ_AS_POSTGRESQL_READS_IT = /[^\S \t\n\r]/

/** Whether `source` holds such white space as written, or, for a TypeScript or JavaScript source, in the value of any literal (an escape such as `\u00a0` or `\f`). */
function holdsWhiteSpaceNotReadAsPostgresqlReadsIt(file: string, source: string): boolean {
  const texts = SOURCE_EXTENSIONS.has(path.extname(file)) ? literalTexts(file, source) : []
  return [source, ...texts].some((text) => WHITE_SPACE_NOT_READ_AS_POSTGRESQL_READS_IT.test(text))
}

/**
 * The judgments of `file` that a pinned set covers: all the statements of the set, or none. A set
 * covers its file only, and only when the source (`source`, the text the judgments were read from)
 * is the reviewed content (`migrationSourceDigest(source)` equals the set's `sha256`), and, on top
 * of that, each of its statements is found in exactly one judgment of the file (counted by the
 * statement text, however and wherever it stands) and that judgment is the statement as pinned. A
 * source that holds white space PostgreSQL does not read as the judge does, anywhere, has nothing
 * set aside. The judgments are read from literals; the digest, not the judgments, is what ties the
 * set-aside to what the reviewed file runs.
 */
export function pinnedStatementsSetAside(file: string, source: string, judgments: readonly MigrationJudgment[], sets: readonly PinnedStatementSet[] = AUTHORIZATION_INPUT_PINNED_STATEMENT_SETS): ReadonlySet<MigrationJudgment> {
  const aside = new Set<MigrationJudgment>()
  for (const set of sets) {
    if (set.file !== file) continue
    if (migrationSourceDigest(source) !== set.sha256) continue
    if (holdsWhiteSpaceNotReadAsPostgresqlReadsIt(file, source)) continue
    const found = set.statements.map((pinned) => judgments.filter((judgment) => judgment.statement?.text === pinned.text))
    if (!found.every((matches, index) => matches.length === 1 && isPinnedAsWritten(matches[0], set.statements[index]))) continue
    for (const [judgment] of found) aside.add(judgment)
  }
  return aside
}

export function checkNewMigration(
  file: string,
  source: string,
  isNew: boolean = isNewMigration(file),
  exemptions: readonly AuthorizationInputDynamicExemption[] = AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS,
  pinnedSets: readonly PinnedStatementSet[] = AUTHORIZATION_INPUT_PINNED_STATEMENT_SETS,
): MigrationCheck {
  const problems: string[] = []
  const isSource = SOURCE_EXTENSIONS.has(path.extname(file))
  const result = isSource ? scanSource(file, source) : scanText(file, source)
  const inputWrites = result.writes.filter((write) => (INPUT_TABLES as readonly string[]).includes(write.table))
  const judged = judgeMigrationInputWrites(file, source)
  // The lock block is required by every input write: one the scan reports, and one only the
  // judgment reads (an input table named with another schema).
  if (inputWrites.length > 0 || judged.judgments.some((judgment) => judgment.inputWrite)) {
    // Comments never satisfy the lock rule: SQL comments inside a literal are blanked before the search.
    const texts = isSource ? literalSqlTexts(file, source) : [commentStrippedText(file, source)]
    const lockText = texts.find((text) => text.includes(AUTHORIZATION_INPUT_MIGRATION_LOCK_FORM))
    if (lockText === undefined) problems.push('missing world lock try form')
    else for (const mark of AUTHORIZATION_INPUT_MIGRATION_LOCK_BLOCK_MARKS) if (!lockText.includes(mark)) problems.push(`world lock try form without ${mark}`)
    if (texts.some((text) => /pg_advisory_xact_lock\(\s*20261106\b/.test(text))) problems.push('blocking world lock form')
  }
  const exempt = exemptDynamicForms(file, judged.dynamic, exemptions)
  const isExempt = (judgment: MigrationJudgment) => judgment.dynamic !== undefined && judgment.dynamic.length > 0 && judgment.dynamic.every((form) => exempt.has(form))
  const pinned = pinnedStatementsSetAside(file, source, judged.judgments, pinnedSets)
  const enforced = judged.judgments.filter((judgment) => judgment.verdict !== 'safe' && (isNew || judgment.inputWrite) && !isExempt(judgment) && !pinned.has(judgment))
  for (const judgment of enforced) problems.push(problemOf(judgment))
  problems.push(...closureProblems(result.writes, judged.writes))
  return Object.freeze({
    problems: Object.freeze(problems),
    verdicts: Object.freeze(enforced.map((judgment) => ({ verdict: judgment.verdict, kind: judgment.kind, detail: judgment.detail, table: judgment.table, value: judgment.raises?.value }))),
    inputWrites: inputWrites.length,
  })
}

export type MigrationTraversal = Readonly<{ problems: readonly string[]; checked: number; frozenSkipped: number; writingChecked: number }>

/** Every migration outside `frozen` is checked; the result counts what was visited so an empty traversal cannot pass. */
export function migrationRuleProblems(files: readonly string[], frozen: readonly string[], sourceOf: (file: string) => string, isNew: (file: string) => boolean = isNewMigration): MigrationTraversal {
  const problems: string[] = []
  let checked = 0
  let frozenSkipped = 0
  let writingChecked = 0
  for (const file of files) {
    if (frozen.includes(file)) {
      frozenSkipped += 1
      continue
    }
    checked += 1
    const source = sourceOf(file)
    const scanned = SOURCE_EXTENSIONS.has(path.extname(file)) ? scanSource(file, source) : scanText(file, source)
    if (scanned.writes.length > 0) writingChecked += 1
    for (const problem of checkNewMigration(file, source, isNew(file)).problems) problems.push(`${file}: ${problem}`)
  }
  return Object.freeze({ problems: Object.freeze(problems), checked, frozenSkipped, writingChecked })
}

/**
 * The assertions of the real traversal as problems: no rule problem, every frozen file skipped,
 * every other file checked, and as many writing migrations checked as there are outside the frozen
 * list. A writing migration outside the frozen list is not a problem in itself.
 */
export function traversalProblems(files: readonly string[], frozen: readonly string[], sourceOf: (file: string) => string, writingMigrations: number, isNew: (file: string) => boolean = isNewMigration): string[] {
  const traversal = migrationRuleProblems(files, frozen, sourceOf, isNew)
  const problems = [...traversal.problems]
  if (traversal.frozenSkipped !== frozen.length) problems.push(`skipped ${traversal.frozenSkipped} frozen migrations, expected ${frozen.length}`)
  if (traversal.checked + traversal.frozenSkipped !== files.length || traversal.checked === 0) problems.push(`checked ${traversal.checked} of ${files.length - frozen.length} migrations outside the frozen list`)
  if (traversal.writingChecked !== writingMigrations - frozen.length) problems.push(`checked ${traversal.writingChecked} writing migrations, expected ${writingMigrations - frozen.length}`)
  return problems
}

