import { promises as fs } from 'fs'
import * as path from 'path'
import { describe, expect, it } from 'vitest'

const MIGRATIONS_DIR = path.join(__dirname, '../../src/db/migrations')
const BOOTSTRAP_PATH = path.join(__dirname, '../helpers/approval-schema-bootstrap.ts')
const JUMP_MIGRATION = path.join(MIGRATIONS_DIR, 'zzzz20260515130000_add_jump_action_to_approval_records.ts')
const POLICY_DENIED_MIGRATION = path.join(
  MIGRATIONS_DIR,
  'zzzz20260818090000_add_policy_denied_action_to_approval_records.ts',
)
const HISTORICAL_ACTION_MIGRATIONS = [
  'zzzz20260411123000_add_created_action_to_approval_records.ts',
  'zzzz20260411120100_approval_templates_and_instance_extensions.ts',
  'zzzz20260423120000_add_remind_action_to_approval_records.ts',
]

/**
 * The CURRENT `approval_records_action_check` membership, in declaration order. This is the ONE
 * place the set is written down for the parity gate; both the production migration and the test
 * bootstrap are compared against it, so neither can drift alone.
 */
const EXPECTED_ACTION_CHECK_MEMBERS = [
  'created', 'approve', 'reject', 'return', 'revoke', 'transfer', 'sign', 'comment', 'cc',
  'remind', 'jump', 'add_sign', 'reduce_sign', 'reassign',
  'handle',          // Lock-3 §2.1
  'policy_denied',   // Lock-5 §1.4 / OD-L5-9(a)
]

/** Structural read of a migration's `const <name> = [ '…', '…' ]`. THROWS when the anchor is absent
 *  (an empty array would otherwise read as "no members" and silently pass a set comparison). */
function parseMigrationActionArray(source: string, constName: string): string[] {
  const match = source.match(new RegExp(`const\\s+${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]`))
  if (!match) throw new Error(`APPROVAL_ACTION_ARRAY_MISSING: ${constName}`)
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1])
}

/** Structural read of the bootstrap helper's `CHECK (action IN ('…', '…'))`. Same throw-on-missing
 *  discipline as above. */
function parseBootstrapCheckMembers(source: string): string[] {
  const match = source.match(/CHECK \(action IN \(([^)]*)\)\)/)
  if (!match) throw new Error('APPROVAL_ACTION_CHECK_MISSING')
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1])
}

describe('approval admin jump migration and bootstrap sync', () => {
  it('T11 exposes reversible up/down functions for the jump migration', async () => {
    const migration = await import('../../src/db/migrations/zzzz20260515130000_add_jump_action_to_approval_records')

    expect(typeof migration.up).toBe('function')
    expect(typeof migration.down).toBe('function')
    expect(migration.up.length).toBe(1)
    expect(migration.down.length).toBe(1)
  })

  it('T11 adds jump in up() and restores the non-jump constraint with NOT VALID in down()', async () => {
    const source = await fs.readFile(JUMP_MIGRATION, 'utf8')
    const [upSource, downSource] = source.split('export async function down')

    expect(upSource).toContain("'jump'")
    expect(upSource).toContain('approval_records_action_check')
    expect(upSource).toContain('ACTIONS_WITH_JUMP')
    expect(downSource).toContain('ACTIONS_WITHOUT_JUMP')
    expect(downSource).toContain('NOT VALID')
  })

  it('PD2 removes role_permissions before permissions in down() for FK safety', async () => {
    const source = await fs.readFile(JUMP_MIGRATION, 'utf8')
    const downSource = source.split('export async function down')[1] ?? ''
    const roleDeleteIndex = downSource.indexOf('DELETE FROM role_permissions')
    const permissionDeleteIndex = downSource.indexOf('DELETE FROM permissions')

    expect(source).toContain('approvals:admin')
    expect(roleDeleteIndex).toBeGreaterThanOrEqual(0)
    expect(permissionDeleteIndex).toBeGreaterThanOrEqual(0)
    expect(roleDeleteIndex).toBeLessThan(permissionDeleteIndex)
  })

  it('T-bootstrap keeps approval_schema_bootstrap action check aligned with reassign (P1-B)', async () => {
    const source = await fs.readFile(BOOTSTRAP_PATH, 'utf8')

    // Later schema additions may advance the bootstrap marker; keep this pin synchronized so the
    // reassign CHECK and the latest idempotent DDL are both replayed on reused test databases.
    // Lock-10 (S1) OD-S1-9(a) bumped this to add `approval_instances.org_id` plus its non-blank
    // CHECK (nullable, no default, Phase 1 only — see zzzz20260821100000_add_approval_instance_org_id.ts).
    // Fix-round (S2 gate P2-1) bumped it again to add `approval_cmt_tombstone_mentions_cleared`.
    // S3b (P3-6 carried-hardening item) bumped it again to NAME the `approval_comments.instance_id`
    // FK as `approval_cmt_instance_fk` (was unnamed) — see the P3-6 parity test below.
    expect(source).toContain("APPROVAL_SCHEMA_BOOTSTRAP_VERSION = '20260822-s3b-p36-named-instance-fk'")
    // ANCHORED on the FULL member list, not the old floating fragment. The previous substring
    // (`'remind', 'jump', 'add_sign', 'reduce_sign', 'reassign'`) still passed with BOTH `handle`
    // and `policy_denied` missing from the bootstrap — an unanchored pin over load-bearing DDL, the
    // exact landmine this repo has been bitten by before. `parseCheckMembers` below now derives the
    // list structurally, so a dropped member cannot hide inside a longer string.
    expect(parseBootstrapCheckMembers(source)).toEqual(EXPECTED_ACTION_CHECK_MEMBERS)
    expect(source).toContain('ADD COLUMN IF NOT EXISTS publish_note TEXT')
    expect(source).toContain('ADD COLUMN IF NOT EXISTS node_activation_seq INTEGER NOT NULL DEFAULT 0')
    expect(source).toContain('ADD COLUMN IF NOT EXISTS entry_epoch INTEGER')
    expect(source).toContain('CREATE INDEX IF NOT EXISTS idx_approval_template_versions_restored_from')
  })

  /**
   * Lock-5 §1.4 / gate D-1 (positive-control repair, adversarial-gate finding P2-1 on PR #4980).
   *
   * D-1 requires "reverting only the migration reds the insert (the CHECK is exercised, not just the
   * TS union)". That control was VACUOUS: `approval-schema-bootstrap.ts` unconditionally
   * DROP/ADDs `approval_records_action_check`, and every real-DB suite calls
   * `ensureApprovalSchemaReady()` in `beforeAll` — so the bootstrap OVERWRITES whatever the
   * production migration created, and every DB-level CHECK assertion tests the test helper's DDL,
   * never the migration's. Removing `'policy_denied'` from the migration left the whole real-DB
   * suite green.
   *
   * This test is the repair, and it lives in the REQUIRED `test (20.x)` lane (no DB needed): the
   * migration's member array and the bootstrap's CHECK list must be the SAME SET, both directions.
   * A member added to one and not the other now reds here, which is what makes the migration
   * load-bearing again.
   *
   * PRODUCTION CONSEQUENCE this guards: if the image carrying the §2.1 choke reaches an environment
   * before this migration is applied, the first policy denial's INSERT violates the pre-existing
   * 15-member CHECK and throws a raw pg error — NOT a ServiceError — so the route maps it to 500
   * instead of the contracted 409, and no audit row is written.
   */
  it('D-1 repair: the policy_denied MIGRATION and the test bootstrap declare the SAME action CHECK set', async () => {
    const migrationSource = await fs.readFile(POLICY_DENIED_MIGRATION, 'utf8')
    const bootstrapSource = await fs.readFile(BOOTSTRAP_PATH, 'utf8')

    const migrationMembers = parseMigrationActionArray(migrationSource, 'ACTIONS_WITH_POLICY_DENIED')
    const bootstrapMembers = parseBootstrapCheckMembers(bootstrapSource)

    // Exact set equality, BOTH directions — not a subset, not a count.
    expect(new Set(migrationMembers)).toEqual(new Set(bootstrapMembers))
    expect(migrationMembers).toEqual(EXPECTED_ACTION_CHECK_MEMBERS)
    expect(bootstrapMembers).toEqual(EXPECTED_ACTION_CHECK_MEMBERS)
    // The value this slice adds must actually be in both.
    expect(migrationMembers).toContain('policy_denied')
    expect(bootstrapMembers).toContain('policy_denied')
    // …and the previous slice's value must not have been dropped on the way.
    expect(migrationMembers).toContain('handle')
    expect(bootstrapMembers).toContain('handle')
    // The migration's down() must restore the set WITHOUT policy_denied — a revert that left it in
    // would make the "reversible" claim false.
    expect(migrationSource).toContain('ACTIONS_WITHOUT_POLICY_DENIED')
    expect(migrationSource).toContain('NOT VALID')
  })

  it('D-1 repair (negative control): the parity helpers actually discriminate — a dropped member is detected', () => {
    // Without this, the parity test above could be green because BOTH parsers silently returned []
    // (the classic "empty read is not absence" failure). Feed each parser a source with one member
    // removed and assert the comparison FAILS.
    const migrationLike = `const ACTIONS_WITH_POLICY_DENIED = [\n${EXPECTED_ACTION_CHECK_MEMBERS
      .filter((action) => action !== 'policy_denied')
      .map((action) => `  '${action}',`)
      .join('\n')}\n]`
    const parsedMigration = parseMigrationActionArray(migrationLike, 'ACTIONS_WITH_POLICY_DENIED')
    expect(parsedMigration).not.toContain('policy_denied')
    expect(new Set(parsedMigration)).not.toEqual(new Set(EXPECTED_ACTION_CHECK_MEMBERS))

    const bootstrapLike = `CHECK (action IN (${EXPECTED_ACTION_CHECK_MEMBERS
      .filter((action) => action !== 'handle')
      .map((action) => `'${action}'`)
      .join(', ')}))`
    const parsedBootstrap = parseBootstrapCheckMembers(bootstrapLike)
    expect(parsedBootstrap).not.toContain('handle')
    expect(new Set(parsedBootstrap)).not.toEqual(new Set(EXPECTED_ACTION_CHECK_MEMBERS))

    // …and both parsers THROW rather than returning [] when their anchor is missing, so a renamed
    // constant can never be mistaken for an empty set.
    expect(() => parseMigrationActionArray('no such array', 'ACTIONS_WITH_POLICY_DENIED')).toThrow()
    expect(() => parseBootstrapCheckMembers('no such check')).toThrow()
  })
})

/**
 * S3b — P3-6 carried-hardening item. Migration ↔ bootstrap constraint-name parity for
 * `approval_comments` (Lock-10 S2, zzzz20260822120000_create_approval_comments.ts), extending the
 * D-1 pattern above to a SECOND table. Both sources use the identical `CONSTRAINT <name> …`
 * grammar (unlike the action-CHECK pair above, whose two sources use genuinely different SQL
 * shapes — an inline array literal vs. a `CHECK (action IN (...))` clause), so ONE structural
 * parser suffices for both files here, not two.
 *
 * SOURCE-TEXT CAVEAT (load-bearing, do not drop this sentence — see
 * feedback_source_text_assertions_are_not_behaviour.md): this is a parity claim about the two
 * DDL TEXTS, not about what a running database actually has. The bootstrap's `CREATE TABLE IF NOT
 * EXISTS` means an ALREADY-bootstrapped test DB keeps whatever FK name it materialized under an
 * OLDER bootstrap version — including Postgres's auto-generated
 * `approval_comments_instance_id_fkey`, from before this bump named it — and the name never
 * converges there. Only a virgin (never-before-bootstrapped) DB gets the named constraint this
 * test pins.
 */
describe('P3-6: approval_comments migration and bootstrap constraint-name parity', () => {
  const APPROVAL_COMMENT_MIGRATION = path.join(MIGRATIONS_DIR, 'zzzz20260822120000_create_approval_comments.ts')

  /** The ONE place the full constraint set is written down; both sources are compared against
   *  this, so neither can drift alone. */
  const EXPECTED_APPROVAL_COMMENT_CONSTRAINTS = [
    'approval_cmt_instance_fk',
    'approval_cmt_parent_fk',
    'approval_cmt_author_nonblank',
    'approval_cmt_tombstone_body_cleared',
    'approval_cmt_tombstone_mentions_cleared',
    'approval_cmt_no_self_parent',
  ]

  /** `approval_cmt_parent_fk` is DELIBERATELY migration-only — the bootstrap's own `parent_id`
   *  FK stays unnamed (see approval-schema-bootstrap.ts's own note on this). A naive
   *  set-equality would red on this ONE member forever, so it is excluded here BY NAME with the
   *  reason stated, never silently dropped from EXPECTED_APPROVAL_COMMENT_CONSTRAINTS itself. */
  const BOOTSTRAP_ONLY_EXCLUDED = new Set(['approval_cmt_parent_fk'])

  /** Structural extractor: every `CONSTRAINT <name>` occurrence NOT part of a `DROP CONSTRAINT
   *  IF EXISTS <name>` line (the bootstrap's own drop-then-add idempotency idiom, which would
   *  otherwise be mis-parsed — `CONSTRAINT IF` — and re-add the SAME name as a false duplicate
   *  the Set would then silently absorb, or worse, corrupt the capture). THROWS when zero names
   *  are found — same D-1 discipline as parseMigrationActionArray/parseBootstrapCheckMembers
   *  above: an empty read must never be mistaken for "no constraints", which is exactly the
   *  failure mode a renamed/deleted anchor would otherwise hide. */
  function parseNamedConstraints(source: string): string[] {
    const names = new Set<string>()
    for (const line of source.split('\n')) {
      if (/DROP\s+CONSTRAINT/i.test(line)) continue
      const match = line.match(/\bCONSTRAINT\s+(\w+)/)
      if (match) names.add(match[1])
    }
    if (names.size === 0) throw new Error('APPROVAL_COMMENT_CONSTRAINT_NAMES_MISSING')
    return [...names]
  }

  function collapseWhitespace(source: string): string {
    return source.replace(/\s+/g, ' ')
  }

  /**
   * The bootstrap file materializes the ENTIRE approval schema (templates, instances,
   * delegations, …), not just `approval_comments` — a whole-file `CONSTRAINT` scan picks up
   * every OTHER table's named constraints too (`approval_records_action_check`,
   * `chk_approval_delegations_*`, …), which a naive comparison against
   * EXPECTED_APPROVAL_COMMENT_CONSTRAINTS would never match. Scope to the contiguous
   * `approval_comments` DDL block — its own `CREATE TABLE` through (but excluding) the NEXT
   * `CREATE TABLE IF NOT EXISTS` for a different table — before parsing. THROWS if the start
   * marker is missing (same "never silently read as empty/absent" discipline as the parser
   * itself). The migration file needs no such scoping — it declares nothing but this one table.
   */
  function extractApprovalCommentsBootstrapBlock(source: string): string {
    const startMarker = 'CREATE TABLE IF NOT EXISTS approval_comments ('
    const startIdx = source.indexOf(startMarker)
    if (startIdx < 0) throw new Error('APPROVAL_COMMENTS_BOOTSTRAP_BLOCK_START_MISSING')
    const searchFrom = startIdx + startMarker.length
    const nextTableIdx = source.indexOf('CREATE TABLE IF NOT EXISTS', searchFrom)
    return source.slice(startIdx, nextTableIdx >= 0 ? nextTableIdx : source.length)
  }

  it('positive control: both sources are non-empty and contain the constraint grammar this parser targets', async () => {
    const migrationSource = await fs.readFile(APPROVAL_COMMENT_MIGRATION, 'utf8')
    const bootstrapSource = await fs.readFile(BOOTSTRAP_PATH, 'utf8')
    expect(migrationSource).toContain('CONSTRAINT approval_cmt_instance_fk')
    expect(bootstrapSource).toContain('CONSTRAINT approval_cmt_instance_fk')
  })

  it('the migration declares EXACTLY the expected 6-member constraint set', async () => {
    const migrationSource = await fs.readFile(APPROVAL_COMMENT_MIGRATION, 'utf8')
    const migrationConstraints = parseNamedConstraints(migrationSource)
    expect(new Set(migrationConstraints)).toEqual(new Set(EXPECTED_APPROVAL_COMMENT_CONSTRAINTS))
  })

  it('the bootstrap declares the expected set MINUS the migration-only parent FK — both directions', async () => {
    const bootstrapSource = await fs.readFile(BOOTSTRAP_PATH, 'utf8')
    const bootstrapConstraints = parseNamedConstraints(extractApprovalCommentsBootstrapBlock(bootstrapSource))
    const expectedBootstrapSet = new Set(
      EXPECTED_APPROVAL_COMMENT_CONSTRAINTS.filter((name) => !BOOTSTRAP_ONLY_EXCLUDED.has(name)),
    )
    expect(new Set(bootstrapConstraints)).toEqual(expectedBootstrapSet)
    expect(bootstrapConstraints).not.toContain('approval_cmt_parent_fk')
    expect(bootstrapConstraints).toContain('approval_cmt_tombstone_mentions_cleared')
  })

  it('approval_cmt_instance_fk is adjacent to `REFERENCES approval_instances(id) ON DELETE CASCADE` in BOTH sources', async () => {
    const migrationSource = collapseWhitespace(await fs.readFile(APPROVAL_COMMENT_MIGRATION, 'utf8'))
    const bootstrapSource = collapseWhitespace(extractApprovalCommentsBootstrapBlock(await fs.readFile(BOOTSTRAP_PATH, 'utf8')))
    const needle = 'CONSTRAINT approval_cmt_instance_fk REFERENCES approval_instances(id) ON DELETE CASCADE'
    expect(migrationSource).toContain(needle)
    expect(bootstrapSource).toContain(needle)
  })

  it('negative control: a dropped constraint is detected by the set comparison, and the parser THROWS on a totally missing anchor', () => {
    const migrationLike = EXPECTED_APPROVAL_COMMENT_CONSTRAINTS
      .filter((name) => name !== 'approval_cmt_no_self_parent')
      .map((name) => `        CONSTRAINT ${name} CHECK (true)`)
      .join('\n')
    const parsed = parseNamedConstraints(migrationLike)
    expect(parsed).not.toContain('approval_cmt_no_self_parent')
    expect(new Set(parsed)).not.toEqual(new Set(EXPECTED_APPROVAL_COMMENT_CONSTRAINTS))

    // The bootstrap's own DROP/ADD idempotency idiom must not be mis-parsed as a duplicate or
    // phantom "IF" name — feeding a DROP-only line yields the SAME (correct) result as the
    // matching ADD line alone.
    const dropThenAdd = [
      'ALTER TABLE approval_comments DROP CONSTRAINT IF EXISTS approval_cmt_author_nonblank',
      "ALTER TABLE approval_comments ADD CONSTRAINT approval_cmt_author_nonblank CHECK (author_id ~ '[!-~]')",
    ].join('\n')
    expect(parseNamedConstraints(dropThenAdd)).toEqual(['approval_cmt_author_nonblank'])

    expect(() => parseNamedConstraints('no constraints anywhere in this source')).toThrow()
  })
})

describe('approval admin jump migration and bootstrap sync (continued)', () => {
  it('does not mutate immutable historical approval action migrations', async () => {
    const sources = await Promise.all(
      HISTORICAL_ACTION_MIGRATIONS.map(async (fileName) => ({
        fileName,
        source: await fs.readFile(path.join(MIGRATIONS_DIR, fileName), 'utf8'),
      })),
    )

    for (const { fileName, source } of sources) {
      expect(source, fileName).not.toContain("'jump'")
      expect(source, fileName).not.toContain('approvals:admin')
    }
  })
})
