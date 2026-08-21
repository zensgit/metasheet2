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
    // Lock-10 (S1) OD-S1-9(a) bumped this to add `approval_instances.org_id` (nullable, no
    // default, Phase 1 only — see zzzz20260821100000_add_approval_instance_org_id.ts).
    expect(source).toContain("APPROVAL_SCHEMA_BOOTSTRAP_VERSION = '20260821-s1-instance-org-id-phase1'")
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
