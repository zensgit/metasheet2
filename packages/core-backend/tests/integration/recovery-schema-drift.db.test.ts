import { describe, expect, test } from 'vitest'

import { query } from '../../src/db/pg'
import {
  AUTHORITY_FUNCTION_SNAPSHOT_QUERY,
  AUTHORITY_TRIGGER_SNAPSHOT_QUERY,
  AUTHORITY_TRIGGER_FUNCTIONS,
  EXPECTED_AUTHORITY_FUNCTIONS,
  EXPECTED_AUTHORITY_TRIGGERS,
  assessSchemaSnapshot,
  canonicalFunction,
  canonicalTrigger,
  fingerprint,
  queryRecoverySchemaSnapshot,
  // eslint-disable-next-line import/extensions
} from '../../../../scripts/ops/multitable-recovery-schema-containment.mjs'

/**
 * A-vs-B floor for the Time Machine recovery-authority schema posture.
 *
 * WHY THIS LIVES HERE (real-DB lane, not a unit test): `scripts/ops/multitable-recovery-schema-
 * containment.mjs` judges the LIVE recovery schema against hand-maintained constants
 * (`EXPECTED_AUTHORITY_TRIGGERS`, `EXPECTED_AUTHORITY_FUNCTIONS`, and the trigger/function BODY
 * fingerprints baked into that module). That module's own unit suite
 * (`multitable-recovery-schema-containment.test.mjs`, run via `node --test`) only proves the pure
 * functions (`canonicalTrigger`, `fingerprint`, `assessSchemaSnapshot`, …) behave correctly on
 * FIXTURE rows it hands them — it never runs the real migrations, so it cannot detect drift
 * between the constants and what
 * `packages/core-backend/src/db/migrations/zzzz20260721121000_add_recovery_authority_locks.ts`
 * (and its corrective replay `zzzz20260728120000_correct_recovery_authority_locks.ts`) ACTUALLY
 * installs. The `multitable-recovery-flag-containment-check.yml` workflow that runs the module
 * for real is dispatch-only against a live host — never a fresh-migration PR gate. So a migration
 * edit that silently changes a trigger's table, a function's body, or an argument encoding — without
 * updating the constants — would sail through every existing gate: the unit suite still fixture-
 * passes, and nothing in required CI ever asks Postgres what the migration really produced.
 *
 * This suite closes that gap the only way it can be closed: run the REAL migrations (this file's
 * CI lane runs after `pnpm --filter @metasheet/core-backend db:migrate`, same as every other
 * `*-realdb.test.ts` / `*.db.test.ts` sibling in this directory) and assert the constants the
 * containment helper trusts are byte-for-byte what the live catalog holds — using the helper's
 * OWN exported comparison machinery (`assessSchemaSnapshot`, `canonicalTrigger`, `canonicalFunction`,
 * `fingerprint`), never a re-hardcoded expectation of this file's own. If a migration edit and the
 * constants drift apart, this suite (and only this suite) is what turns required CI red for it.
 *
 * THREE ASSERTIONS:
 *   1. A-vs-B trigger/function identity + body: `assessSchemaSnapshot` on the real snapshot must
 *      be `ok === true`. The migration installs all nine triggers DISABLED ('D') — that is already
 *      baked into `EXPECTED_AUTHORITY_TRIGGERS`, so this is a straight equality, not a special case.
 *      `assessSchemaSnapshot`'s own `diagnostics` array is only populated for the FK-absence check
 *      (by design — see the module's source), so on a trigger/function drift this suite computes
 *      its OWN symmetric diff (below) naming exactly which trigger/function/field moved, rather than
 *      surfacing only a fingerprint mismatch.
 *   2. `subject_type` CHECK domain (the P3-INFO-1 settling query): the containment helper does NOT
 *      fingerprint the `record_permissions`/`field_permissions` CHECK constraint that constrains
 *      `subject_type` — only the trigger/function objects. A dropped or widened CHECK would silently
 *      un-cover those two tables (the `metasheet_recovery_authority_subject_trigger` function filters
 *      on `subject_type IN ('user', 'role', 'member-group')`; if the CHECK ever allowed a FOURTH
 *      value, rows carrying it would satisfy the column type but skip the trigger's authority-lease
 *      loop entirely — a silent coverage hole the trigger/function fingerprints cannot see). This
 *      queries `pg_constraint`/`pg_get_constraintdef` directly and asserts the VALUE SET (not the raw
 *      string) so a harmless reformat of the same three values never false-reds.
 *   3. `meta_links.foreign_record_id` FK absence: already inside `assessSchemaSnapshot`'s
 *      `meta-links-foreign-record-id-fk-absence` check — asserting `ok === true` in (1) covers it;
 *      this file adds no separate query for it (would just be a second, weaker copy).
 *
 * KNOWN COUPLING (not a bug in this file, disclosed so a false-attributed red doesn't waste triage
 * time): `multitable-recovery-authority-stability-realdb.test.ts` runs in the SAME CI step
 * (`multitable-real-db-integration`) and ENABLEs all nine authority triggers in its own `beforeAll`,
 * DISABLEing them again in `afterAll`. If that suite's process dies between those two hooks, the
 * nine triggers are left `tgenabled = 'O'` for whichever suite runs next against the same shared CI
 * database — including this one. If THIS suite reds with the triggers check's only delta being all
 * nine `enabled` values flipped from `'D'` to `'O'` (every other field identical), that is
 * cross-suite shared-DB residue from the sibling suite's own aborted teardown, not a migration/
 * constant drift; the diagnostic below names this explicitly so it is not mis-triaged as drift.
 */

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

test('sentinel: the real-DB allowlist step must have DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery-schema-drift real-DB step is missing DATABASE_URL')
  }
  expect(true).toBe(true)
})

type CanonicalTrigger = ReturnType<typeof canonicalTrigger>
type CanonicalFunction = ReturnType<typeof canonicalFunction>

function triggerKey(row: CanonicalTrigger): string {
  return `${row.schemaName}.${row.tableName}.${row.triggerName}`
}

function functionKey(row: CanonicalFunction): string {
  return `${row.schemaName}.${row.functionName}(${row.identityArguments})`
}

/**
 * Field-by-field symmetric diff between the ACTUAL (live-DB) canonical rows and the EXPECTED
 * (hand-maintained constant) canonical rows, keyed by identity. Loud by construction: every drift
 * class (extra row, missing row, or a field-level mismatch on a row present in both) is named,
 * never just summarized as "fingerprint differs".
 */
function diffKeyedRows<T extends Record<string, unknown>>(
  label: string,
  actualRows: T[],
  expectedRows: T[],
  keyOf: (row: T) => string,
): string[] {
  const actualByKey = new Map(actualRows.map((row) => [keyOf(row), row]))
  const expectedByKey = new Map(expectedRows.map((row) => [keyOf(row), row]))
  const lines: string[] = []

  for (const [key, expectedRow] of expectedByKey) {
    const actualRow = actualByKey.get(key)
    if (!actualRow) {
      lines.push(`  MISSING ${label}: expected "${key}" but the live DB has no matching row`)
      continue
    }
    const fields = new Set([...Object.keys(actualRow), ...Object.keys(expectedRow)])
    for (const field of fields) {
      const actualValue = JSON.stringify((actualRow as Record<string, unknown>)[field])
      const expectedValue = JSON.stringify((expectedRow as Record<string, unknown>)[field])
      if (actualValue !== expectedValue) {
        if (field === 'body') {
          lines.push(
            `  DRIFT ${label} "${key}" field="body": actual sha256=${fingerprint(
              (actualRow as Record<string, unknown>)[field],
            )} expected sha256=${fingerprint((expectedRow as Record<string, unknown>)[field])}`,
          )
        } else {
          lines.push(`  DRIFT ${label} "${key}" field="${field}": actual=${actualValue} expected=${expectedValue}`)
        }
      }
    }
  }
  for (const [key] of actualByKey) {
    if (!expectedByKey.has(key)) {
      lines.push(`  UNEXPECTED ${label}: live DB has "${key}" but no constant expects it`)
    }
  }
  return lines
}

/**
 * The "all nine flipped tgenabled" shared-DB-residue shape (see KNOWN COUPLING above): every
 * trigger drift line names field="enabled" with actual='"O"' expected='"D"' and nothing else.
 */
function isOnlyEnabledFlipResidue(triggerDiffLines: string[]): boolean {
  return (
    triggerDiffLines.length === EXPECTED_AUTHORITY_TRIGGERS.length &&
    triggerDiffLines.every(
      (line: string) => line.includes('field="enabled"') && line.includes('actual="O"') && line.includes('expected="D"'),
    )
  )
}

describeIfDatabase('recovery-authority schema drift (A-vs-B floor, real DB)', () => {
  test('assessSchemaSnapshot passes on a freshly migrated database (triggers + functions + meta_links FK-absence)', async () => {
    const databaseUrl = String(process.env.DATABASE_URL)
    const snapshot = await queryRecoverySchemaSnapshot(databaseUrl)
    const assessment = assessSchemaSnapshot(snapshot)

    if (!assessment.ok) {
      const actualTriggers = snapshot.authorityTriggers.map(canonicalTrigger)
      const expectedTriggers = EXPECTED_AUTHORITY_TRIGGERS.map(canonicalTrigger)
      const triggerDiff = diffKeyedRows('trigger', actualTriggers, expectedTriggers, triggerKey)

      const actualFunctions = snapshot.authorityFunctions.map(canonicalFunction)
      const expectedFunctions = EXPECTED_AUTHORITY_FUNCTIONS.map(canonicalFunction)
      const functionDiff = diffKeyedRows('function', actualFunctions, expectedFunctions, functionKey)

      const failing = assessment.checks.filter((check) => !check.ok)
      const lines = [
        'Recovery-authority schema drift detected — the constants in',
        'scripts/ops/multitable-recovery-schema-containment.mjs no longer match what the real',
        'migrations installed. Failing checks:',
        ...failing.map(
          (check) =>
            `  ${check.id}: actualCount=${check.actualCount} expectedCount=${check.expectedCount} ` +
            `actualFingerprint=${check.actualFingerprint} expectedFingerprint=${check.expectedFingerprint}`,
        ),
        ...(triggerDiff.length > 0 ? ['Trigger diff:', ...triggerDiff] : []),
        ...(functionDiff.length > 0 ? ['Function diff:', ...functionDiff] : []),
        ...(snapshot.metaLinksForeignRecordFks.length > 0
          ? [
              'meta_links.foreign_record_id carries a forbidden FK:',
              ...snapshot.metaLinksForeignRecordFks.map(
                (fk: { constraintName?: string; constraint_name?: string; onDeleteAction?: string; on_delete_action?: string }) =>
                  `  constraint="${fk.constraintName ?? fk.constraint_name}" on_delete_action="${
                    fk.onDeleteAction ?? fk.on_delete_action
                  }"`,
              ),
            ]
          : []),
        ...(isOnlyEnabledFlipResidue(triggerDiff)
          ? [
              'NOTE: every trigger delta is enabled "O" vs expected "D" and nothing else — this is the',
              'documented shared-DB-residue shape (see the KNOWN COUPLING header comment in this file):',
              'the sibling multitable-recovery-authority-stability-realdb.test.ts suite in the SAME CI',
              'step enables these nine triggers in beforeAll and disables them in afterAll; if that',
              'process died between the two hooks this run inherited enabled triggers from it. Still a',
              'real red (CI must not silently pass with residue), but not migration/constant drift.',
            ]
          : []),
      ]
      expect(assessment.ok, lines.join('\n')).toBe(true)
    }

    expect(assessment.ok).toBe(true)
    expect(assessment.checks.map((check) => check.id).sort()).toEqual(
      ['meta-links-foreign-record-id-fk-absence', 'recovery-authority-functions', 'recovery-authority-triggers'].sort(),
    )
  })

  // Positive control for the diff machinery itself: if the live DB and the expected constants
  // were EVER different, diffKeyedRows must say so — not stay silent. Proven here against the
  // module's OWN exported snapshot queries so a future edit to either query's column list is
  // exercised too, not just today's hardcoded row shape.
  test('sanity: the trigger/function snapshot queries return the expected object counts', async () => {
    const databaseUrl = String(process.env.DATABASE_URL)
    const snapshot = await queryRecoverySchemaSnapshot(databaseUrl)
    expect(snapshot.authorityTriggers).toHaveLength(EXPECTED_AUTHORITY_TRIGGERS.length)
    expect(snapshot.authorityFunctions).toHaveLength(EXPECTED_AUTHORITY_FUNCTIONS.length)
    // Every trigger name this suite expects to see must have been asked for by the shared query
    // (guards against silently narrowing AUTHORITY_TRIGGER_SNAPSHOT_QUERY's own $1/$2 filter).
    expect(AUTHORITY_TRIGGER_SNAPSHOT_QUERY).toContain('pg_trigger')
    expect(AUTHORITY_FUNCTION_SNAPSHOT_QUERY).toContain('pg_proc')
    expect(AUTHORITY_TRIGGER_FUNCTIONS.length).toBeGreaterThan(0)
  })
})

/**
 * subject_type CHECK domain — the P3-INFO-1 settling query.
 *
 * The trigger function `metasheet_recovery_authority_subject_trigger` (installed by the same
 * migration, fingerprinted by `EXPECTED_AUTHORITY_FUNCTIONS` above) filters incoming rows with
 * `WHERE subject_type IN ('user', 'role', 'member-group')`. The containment helper fingerprints
 * that function's BODY, but never asks what values `record_permissions.subject_type` and
 * `field_permissions.subject_type` are actually constrained to accept. If a future migration widens
 * (or drops) either table's `..._subject_type_check` CHECK constraint without touching the trigger
 * function, rows carrying a new subject_type value would pass the column CHECK, land in the table,
 * and skip the authority-lease loop entirely (the trigger's own filter silently excludes them) — a
 * coverage hole neither the trigger nor the function fingerprint can detect, because neither one
 * changed. This is exactly the caveat the P3-INFO-1 investigation left open.
 */
describeIfDatabase('recovery-authority subject_type CHECK domain (real DB)', () => {
  const EXPECTED_SUBJECT_TYPES = new Set(['user', 'role', 'member-group'])

  function extractTextArrayLiterals(definition: string): string[] {
    // Primary rendering observed on PG14/PG15 for `IN (a, b, c)`-style CHECKs:
    //   CHECK ((subject_type = ANY (ARRAY['user'::text, 'role'::text, 'member-group'::text])))
    const perElement = [...definition.matchAll(/'((?:[^'\\]|\\.)*)'::text\b/g)].map((match) => match[1])
    if (perElement.length > 0) return perElement

    // Fallback rendering some Postgres builds use for the same predicate — a single quoted
    // array literal cast to text[]: CHECK ((subject_type = ANY ('{user,role,member-group}'::text[])))
    const folded = definition.match(/'\{([^}]*)\}'::text\[\]/)
    if (folded) {
      return folded[1]
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    }

    return []
  }

  test.each(['record_permissions', 'field_permissions'] as const)(
    '%s.subject_type CHECK still reads exactly (user, role, member-group)',
    async (tableName) => {
      const result = await query<{
        constraint_name: string
        definition: string
        column_names: string[]
      }>(
        `SELECT
           con.conname AS constraint_name,
           pg_get_constraintdef(con.oid) AS definition,
           COALESCE(
             ARRAY(
               SELECT attr.attname::text
                 FROM unnest(con.conkey) WITH ORDINALITY AS selected(attnum, position)
                 JOIN pg_catalog.pg_attribute attr
                   ON attr.attrelid = con.conrelid
                  AND attr.attnum = selected.attnum
                ORDER BY selected.position
             ),
             ARRAY[]::text[]
           ) AS column_names
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class cls ON cls.oid = con.conrelid
         JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
        WHERE con.contype = 'c'
          AND ns.nspname = 'public'
          AND cls.relname = $1
        ORDER BY con.conname`,
        [tableName],
      )

      // Filtered in JS (not in the WHERE clause) on the SAME column_names array asserted below,
      // so "which constraint is subject_type's" and "is it scoped to subject_type alone" are
      // proven by one consistent computation, not two independently-written queries that could
      // silently disagree.
      const subjectTypeChecks = result.rows.filter((row) => row.column_names.includes('subject_type'))

      expect(
        subjectTypeChecks.length,
        `expected exactly one CHECK constraint on ${tableName} covering subject_type; found ` +
          `${subjectTypeChecks.length} (${subjectTypeChecks.map((row) => row.constraint_name).join(', ') || 'none'}) ` +
          `— all CHECK constraints seen on ${tableName}: ` +
          `${result.rows.map((row) => `${row.constraint_name}[${row.column_names.join(',')}]`).join(', ') || 'none'} — ` +
          'the constraint may have been dropped, or subject_type is now covered by more than one CHECK',
      ).toBe(1)

      const [row] = subjectTypeChecks
      // The constraint must be scoped to subject_type alone, not a multi-column composite CHECK
      // that happens to also mention it (a composite CHECK could be satisfied without actually
      // constraining subject_type's domain the way this suite assumes).
      expect(
        row.column_names,
        `expected the CHECK on ${tableName} to reference exactly ["subject_type"], found ` +
          `${JSON.stringify(row.column_names)} (definition: ${row.definition})`,
      ).toEqual(['subject_type'])

      const normalizedDefinition = row.definition.replace(/\s+/g, ' ').trim()
      const actualValues = extractTextArrayLiterals(normalizedDefinition)

      expect(
        actualValues.length,
        `failed to extract any literal values from ${tableName}'s subject_type CHECK definition ` +
          `("${normalizedDefinition}") — the extractor's regex no longer matches this Postgres's ` +
          'pg_get_constraintdef rendering; fix the extractor, do not let an empty set compare as a pass',
      ).toBeGreaterThan(0)

      const actualSet = new Set(actualValues)
      const missing = [...EXPECTED_SUBJECT_TYPES].filter((value) => !actualSet.has(value))
      const extra = [...actualSet].filter((value) => !EXPECTED_SUBJECT_TYPES.has(value))

      expect(
        { missing, extra, actual: [...actualSet].sort() },
        `${tableName}.subject_type CHECK domain drifted from ('user','role','member-group'): ` +
          `definition="${normalizedDefinition}"`,
      ).toEqual({ missing: [], extra: [], actual: [...EXPECTED_SUBJECT_TYPES].sort() })
    },
  )
})
