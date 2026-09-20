import { promises as fs } from 'fs'
import * as path from 'path'
import { describe, expect, it } from 'vitest'

/**
 * MIGRATION TIMESTAMP PREFIX UNIQUENESS — ALLOWLISTED COLLISIONS ONLY. (#5912)
 *
 * ── Why ───────────────────────────────────────────────────────────────────────
 * Migration filenames are `zzzz<14-digit timestamp>_<slug>.ts`. The runner
 * (`createCoreBackendMigrationProvider`, see migration-provider.test.ts) records applied migrations
 * by their FULL filename-derived key, not by the timestamp prefix alone — so two files that share a
 * 14-digit prefix both still run, and BOTH run. Their relative order then falls out of plain
 * filename lexical sort, which for a shared prefix means it is decided by whatever the slug (the part
 * after the prefix) happens to sort as — an ordering nobody chose on purpose and that silently
 * depends on future filenames being alphabetically adjacent to old ones. Issue #5912 found 12 such
 * collisions already sitting on main. Concretely, PR #5893 (multitable template-install ledger) and
 * PR #5915 (ai-bulk-fill commit-phase claim) both independently picked `zzzz20260919140000` this
 * week — proof the failure mode reproduces in practice, not just in theory.
 *
 * This guard does not try to fix ordering; it makes new collisions loud. Every prefix with more than
 * one file on disk must appear in the ALLOWLIST below with its EXACT file set. An unlisted collision
 * fails the test immediately, forcing the author to either rename one file to an unused prefix (the
 * normal fix) or add a deliberate, reviewed ALLOWLIST entry (the documented exception).
 *
 * ── How to extend ─────────────────────────────────────────────────────────────
 * - New migration: pick a 14-digit prefix that is not already in use (see the `ls | sed | sort |
 *   uniq -d` recipe in #5912). Nothing to do here.
 * - A NEW collision you actually intend to keep (rare — prefer renaming instead): append one entry
 *   to ALLOWLIST with a comment naming the PR(s) that justify it. Do not add an entry "just to make
 *   the test pass" without that justification — that is exactly the silent-drift this guard exists
 *   to prevent.
 *
 * ── State model for an ALLOWLIST entry (see validateMigrationPrefixAllowlist) ──
 * For a given prefix, comparing the ALLOWLIST's file set against what's really on disk right now
 * yields one of four states:
 *   - MATCH   (disk has >=2 files, exactly equal to the entry)        -> fine, this is the pin working.
 *   - MISSING (disk has 0 files for the prefix)                       -> fine, PRE-APPROVED BUT NOT YET
 *     LANDED. This is deliberate: `zzzz20260919140000` is pinned below for PR #5893 and PR #5915,
 *     but as of this guard's own commit NEITHER has merged, so the prefix has zero files on this
 *     branch. A static directory read cannot tell "never existed yet" apart from "existed and both
 *     files were later deleted" — MISSING is treated as the harmless case for both, because refusing
 *     to accept a pre-approved-but-not-yet-realized entry would block the very PRs this allowlisting
 *     was requested for landing at all order-independent.
 *   - ORPHAN  (disk has exactly 1 file for the prefix)                -> FAILS. The collision this
 *     entry pinned no longer exists as a collision (a rename/removal left one side behind); the
 *     entry is now a dead row and must be deleted from ALLOWLIST rather than kept around stale.
 *   - MISMATCH (disk has >=2 files but a different set than the entry) -> FAILS. Someone renamed a
 *     file that participates in a pinned collision without updating the pin.
 * Symmetrically, any prefix with >=2 files on disk that has NO allowlist entry at all -> FAILS
 * (new, un-reviewed collision).
 */

const MIGRATIONS_DIR = path.join(__dirname, '../../src/db/migrations')

const MIGRATION_FILENAME_PATTERN = /^(zzzz\d{14})_.+\.ts$/

export type MigrationPrefixAllowlist = Readonly<Record<string, readonly string[]>>

/** The 12 pre-existing collisions from #5912, plus the #5893/#5915 pair pinned below. Every entry's
 *  file array must be kept in ascending sort order (the same order `validateMigrationPrefixAllowlist`
 *  sorts disk reads into) so a diff against disk is a plain array equality. */
export const ALLOWLIST: MigrationPrefixAllowlist = {
  zzzz20260413130000: [
    'zzzz20260413130000_create_formula_dependencies.ts',
    'zzzz20260413130000_create_platform_app_instances.ts',
  ],
  zzzz20260610140000: [
    'zzzz20260610140000_create_attendance_auto_shift_auto_write_ledger.ts',
    'zzzz20260610140000_widen_plugin_kv_key.ts',
  ],
  zzzz20260611120000: [
    'zzzz20260611120000_add_parallel_branch_automation_action.ts',
    'zzzz20260611120000_create_attendance_notification_deliveries.ts',
  ],
  zzzz20260705150000: [
    'zzzz20260705150000_add_send_dingtalk_approval_card_automation_action.ts',
    'zzzz20260705150000_create_meta_view_personal_configs.ts',
  ],
  zzzz20260708090000: [
    'zzzz20260708090000_add_delivery_rule_indexes.ts',
    'zzzz20260708090000_create_meta_tombstone_tables.ts',
  ],
  zzzz20260710150000: [
    'zzzz20260710150000_add_files_blob_purged_at.ts',
    'zzzz20260710150000_add_outcome_unknown_delivery_status.ts',
  ],
  zzzz20260711120000: [
    'zzzz20260711120000_add_entry_epoch_to_dingtalk_approval_card_deliveries.ts',
    'zzzz20260711120000_add_redelivery_safe_to_attendance_notification_deliveries.ts',
  ],
  zzzz20260715210000: [
    'zzzz20260715210000_create_approval_attachments.ts',
    'zzzz20260715210000_create_meta_record_history_operations.ts',
  ],
  zzzz20260717120000: [
    'zzzz20260717120000_approval_bridge_lease.ts',
    'zzzz20260717120000_create_provider_org_transfers.ts',
  ],
  zzzz20260723140000: [
    'zzzz20260723140000_add_users_activation_status_and_local_password_set.ts',
    'zzzz20260723140000_create_attendance_calculation_group_memberships.ts',
  ],
  zzzz20260731120000: [
    'zzzz20260731120000_w4c3a_add_off_daily_status.ts',
    'zzzz20260731120000_w4c3a_import_rollback_foundation.ts',
  ],
  zzzz20260826120000: [
    'zzzz20260826120000_create_meta_recovery_archive_catalog.ts',
    'zzzz20260826120000_harden_elearning_v01_ledger.ts',
  ],
  // Pre-approved, order-independent: PR #5893 (multitable template-install ledger) and PR #5915
  // (ai-bulk-fill commit-phase claim) both picked this prefix independently; whichever merges
  // first leaves the prefix at MISSING or a transient single-file state, both merged leaves it at
  // MATCH — neither reds this guard. See the "State model" note above for why MISSING is not a
  // failure.
  zzzz20260919140000: [
    'zzzz20260919140000_ai_bulk_job_commit_phase_claim.ts',
    'zzzz20260919140000_create_multitable_template_install_ledger.ts',
  ],
}

/** Reads a filename's 14-digit `zzzz` prefix, or null for filenames that don't match the migration
 *  naming convention at all (non-`zzzz` legacy migrations, `.sql` files, `_template.ts`, etc. — none
 *  of those participate in the runner's "same prefix, both run" hazard this guard is about). */
export function extractMigrationPrefix(filename: string): string | null {
  const match = MIGRATION_FILENAME_PATTERN.exec(filename)
  return match ? match[1] : null
}

/** Groups migration filenames by their 14-digit prefix. Filenames that don't match the naming
 *  convention (see extractMigrationPrefix) are silently excluded — they can never collide by prefix. */
export function groupMigrationFilenamesByPrefix(filenames: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const filename of filenames) {
    const prefix = extractMigrationPrefix(filename)
    if (!prefix) continue
    const bucket = groups.get(prefix)
    if (bucket) {
      bucket.push(filename)
    } else {
      groups.set(prefix, [filename])
    }
  }
  return groups
}

/** Pure validation: given a filename list and an allowlist, returns human-readable violation
 *  strings (empty array = valid). See the header's "State model" note for the MATCH / MISSING /
 *  ORPHAN / MISMATCH states this implements. */
export function validateMigrationPrefixAllowlist(
  filenames: readonly string[],
  allowlist: MigrationPrefixAllowlist,
): string[] {
  const violations: string[] = []
  const groups = groupMigrationFilenamesByPrefix(filenames)
  const allPrefixes = new Set<string>([...groups.keys(), ...Object.keys(allowlist)])

  for (const prefix of allPrefixes) {
    const actual = [...(groups.get(prefix) ?? [])].sort()
    const allowed = allowlist[prefix]

    if (actual.length <= 1) {
      // ORPHAN: an allowlisted collision that now has exactly one file left is a dead row — the
      // collision it pinned no longer exists. MISSING (0 files) is deliberately NOT a violation;
      // see the header's state-model note (the #5893/#5915 pre-approved-but-not-yet-landed pair).
      if (allowed && actual.length === 1) {
        violations.push(
          `ORPHAN allowlist entry for prefix "${prefix}": only 1 file remains on disk ` +
            `([${actual.join(', ')}]) but the entry expects [${[...allowed].sort().join(', ')}]. ` +
            `Remove this ALLOWLIST entry — the collision it pinned no longer exists.`,
        )
      }
      continue
    }

    // actual.length >= 2: a real duplicate prefix exists on disk right now.
    if (!allowed) {
      violations.push(
        `UNALLOWLISTED duplicate prefix "${prefix}" with ${actual.length} files: ${actual.join(', ')}. ` +
          `Rename one file to an unused prefix, or add an ALLOWLIST entry with a PR-number justification.`,
      )
      continue
    }

    const allowedSorted = [...allowed].sort()
    const matches =
      allowedSorted.length === actual.length && allowedSorted.every((name, i) => name === actual[i])
    if (!matches) {
      violations.push(
        `MISMATCH for allowlisted prefix "${prefix}": disk has [${actual.join(', ')}] but the entry ` +
          `expects [${allowedSorted.join(', ')}]. Update ALLOWLIST to match, or investigate the rename.`,
      )
    }
  }

  return violations
}

async function readMigrationFilenames(): Promise<string[]> {
  const entries = await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
}

describe('migration timestamp prefix uniqueness guard (#5912)', () => {
  it('the real migrations directory has no un-allowlisted duplicate prefix', async () => {
    const filenames = await readMigrationFilenames()
    const violations = validateMigrationPrefixAllowlist(filenames, ALLOWLIST)
    expect(violations).toEqual([])
  })

  it('every ALLOWLIST entry is sorted ascending (so the disk-diff comparison above is meaningful)', () => {
    for (const [prefix, files] of Object.entries(ALLOWLIST)) {
      const sorted = [...files].sort()
      expect(files, `ALLOWLIST["${prefix}"] must be sorted ascending`).toEqual(sorted)
    }
  })

  it('every ALLOWLIST prefix is a real 14-digit zzzz prefix, and every filename actually carries it', () => {
    for (const [prefix, files] of Object.entries(ALLOWLIST)) {
      expect(prefix).toMatch(/^zzzz\d{14}$/)
      for (const file of files) {
        expect(extractMigrationPrefix(file)).toBe(prefix)
      }
    }
  })
})

describe('validateMigrationPrefixAllowlist — self-tests over synthetic file lists', () => {
  it('a new duplicate prefix that is not allowlisted fails', () => {
    const files = ['zzzz20270101000000_a.ts', 'zzzz20270101000000_b.ts']
    const violations = validateMigrationPrefixAllowlist(files, {})
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('UNALLOWLISTED')
    expect(violations[0]).toContain('zzzz20270101000000')
  })

  it('an allowlisted group that lost a file down to exactly one fails as an ORPHAN', () => {
    const files = ['zzzz20270101000000_a.ts']
    const allowlist: MigrationPrefixAllowlist = {
      zzzz20270101000000: ['zzzz20270101000000_a.ts', 'zzzz20270101000000_b.ts'],
    }
    const violations = validateMigrationPrefixAllowlist(files, allowlist)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('ORPHAN')
    expect(violations[0]).toContain('zzzz20270101000000')
  })

  it('a group whose filenames changed (renamed, same count) fails as a MISMATCH', () => {
    const files = ['zzzz20270101000000_a.ts', 'zzzz20270101000000_c-renamed.ts']
    const allowlist: MigrationPrefixAllowlist = {
      zzzz20270101000000: ['zzzz20270101000000_a.ts', 'zzzz20270101000000_b.ts'],
    }
    const violations = validateMigrationPrefixAllowlist(files, allowlist)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('MISMATCH')
  })

  it('an allowlisted prefix with zero files on disk (pre-approved, not yet landed) is NOT a violation', () => {
    // Models the #5893/#5915 state as of this guard's own commit: pinned in ALLOWLIST, neither
    // migration file exists on this branch yet.
    const files: string[] = ['zzzz20270101000000_unrelated.ts']
    const allowlist: MigrationPrefixAllowlist = {
      zzzz20270202000000: ['zzzz20270202000000_a.ts', 'zzzz20270202000000_b.ts'],
    }
    const violations = validateMigrationPrefixAllowlist(files, allowlist)
    expect(violations).toEqual([])
  })

  it('an allowlisted prefix with exactly one of its two pinned files landed is an ORPHAN, not silently fine', () => {
    // The transitional state after ONE of #5893/#5915 merges and before the other does. This guard
    // treats it as a (temporary) failure rather than silently accepting a partial match — a partial
    // match could just as easily be an unrelated single file that happens to share the prefix.
    const files = ['zzzz20270202000000_a.ts']
    const allowlist: MigrationPrefixAllowlist = {
      zzzz20270202000000: ['zzzz20270202000000_a.ts', 'zzzz20270202000000_b.ts'],
    }
    const violations = validateMigrationPrefixAllowlist(files, allowlist)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('ORPHAN')
  })

  it('a matching allowlisted group (order-independent) passes', () => {
    const files = ['zzzz20270101000000_b.ts', 'zzzz20270101000000_a.ts']
    const allowlist: MigrationPrefixAllowlist = {
      zzzz20270101000000: ['zzzz20270101000000_a.ts', 'zzzz20270101000000_b.ts'],
    }
    expect(validateMigrationPrefixAllowlist(files, allowlist)).toEqual([])
  })

  it('the current migrations directory (read from disk) passes against ALLOWLIST', async () => {
    const filenames = await readMigrationFilenames()
    expect(validateMigrationPrefixAllowlist(filenames, ALLOWLIST)).toEqual([])
  })

  it('non-zzzz-prefixed and non-migration files never participate in grouping', () => {
    const files = [
      '20250924105000_create_approval_tables.ts',
      '20250926_create_audit_tables.sql',
      '_template.ts',
      '_patterns.ts',
      'applied.json',
    ]
    expect(groupMigrationFilenamesByPrefix(files).size).toBe(0)
    expect(validateMigrationPrefixAllowlist(files, {})).toEqual([])
  })
})
