/**
 * The rule a migration outside the frozen list must satisfy, and the traversal that applies it.
 *
 * A migration that writes an input table must contain the bounded try form of the world lock
 * inside one statement literal together with its retry-loop marks, and no blocking form. A write
 * is one the scan reports, or one the judgment reads on an input table named with another schema.
 * Every statement that writes an input table must be judged `safe`. In a new migration (one whose path is
 * not in the pinned set of historical migration files) every judged statement must be `safe`,
 * whether or not it writes: schema changes, helper calls and literals that mention an input table
 * are judged as well. Every write the scanner reports must lie inside a judged statement.
 *
 * A verdict that stands only for dynamic targets is set aside when the registry carries an
 * exemption for the file and the form whose count equals the number of such targets found in the
 * file and whose reachable tables contain no input table and no cascade parent. Nothing else about
 * the statement is set aside, and a substituted SET clause of a `users` UPDATE is never exempt.
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
import { commentStrippedText, INPUT_TABLES, literalSqlTexts, scanSource, scanText, SCANNED_TABLES, SOURCE_EXTENSIONS } from './authorization-input-scan'
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

/**
 * The dynamic forms of `file` that the registered exemptions cover: per form, the registered counts
 * add up to the number of targets found, and no registered exemption of that form reaches an input
 * table or a cascade parent or leaves its reachable tables unnamed.
 */
export function exemptDynamicForms(file: string, found: ReadonlyMap<string, number>, exemptions: readonly AuthorizationInputDynamicExemption[]): ReadonlySet<string> {
  const exempt = new Set<string>()
  for (const form of EXEMPTIBLE_DYNAMIC_FORMS) {
    const registered = exemptions.filter((exemption) => exemption.file === file && exemption.form === form)
    if (registered.length === 0) continue
    if (registered.reduce((sum, exemption) => sum + exemption.count, 0) !== (found.get(form) ?? 0)) continue
    if (registered.some((exemption) => exemption.reachableTables.length === 0 || exemption.reachableTables.some((table) => SCANNED_TABLES.has(table.toLowerCase())))) continue
    exempt.add(form)
  }
  return exempt
}

export function checkNewMigration(file: string, source: string, isNew: boolean = isNewMigration(file), exemptions: readonly AuthorizationInputDynamicExemption[] = AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS): MigrationCheck {
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
  const enforced = judged.judgments.filter((judgment) => judgment.verdict !== 'safe' && (isNew || judgment.inputWrite) && !isExempt(judgment))
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

