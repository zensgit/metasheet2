import { promises as fs } from 'fs'
import * as path from 'path'
import { describe, expect, it } from 'vitest'

/**
 * MIGRATION TIMESTAMP PREFIX UNIQUENESS — ALLOWLISTED COLLISIONS ONLY. (#5912)
 *
 * ── Why ───────────────────────────────────────────────────────────────────────
 * Migration filenames are `zzzz<14-digit timestamp>_<slug>.ts`. The runner keys applied
 * migrations by the FULL filename, not by the timestamp prefix alone
 * (`packages/core-backend/src/db/migration-provider.ts:212-214` — `addProviderMigrations` throws
 * `Duplicate migration name detected` only on an exact full-name collision), so two files that
 * share a 14-digit prefix both still run. Their relative order then falls out of kysely's plain
 * lexical sort over the full name (`kysely` `Migrator#resolveMigrations`,
 * `node_modules/kysely/dist/cjs/migration/migrator.js:457-464` — `Object.keys(allMigrations).sort()`),
 * which for a shared prefix means it is decided by whatever the slug (the part after the prefix)
 * happens to sort as — an ordering nobody chose on purpose. Kysely does have a check that would
 * normally catch a newcomer sorting before an already-applied migration
 * (`#ensureMigrationsInOrder`, migrator.js:492-498, throws `corrupted migrations: ... New
 * migrations must always have a name that comes alphabetically after the last executed
 * migration.`), but this project disables it: `packages/core-backend/src/db/migrate.ts:32` sets
 * `allowUnorderedMigrations: true`. With that check off, a same-prefix newcomer reorders silently
 * instead of erroring. Issue #5912 found 12 such collisions already sitting on main. Concretely,
 * PR #5893 (multitable template-install ledger) and PR #5915 (ai-bulk-fill commit-phase claim)
 * both independently picked `zzzz20260919140000` this week — proof the failure mode reproduces in
 * practice, not just in theory.
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
 * - Two PRs racing on the SAME prefix that are both pre-approved to land independently (so neither
 *   should be blocked by the other's merge order): pin them in PENDING_PAIRS instead of ALLOWLIST
 *   (see below). ALLOWLIST entries require the full set to already be on disk; PENDING_PAIRS
 *   entries tolerate 0 or 1 of the pinned files being on disk yet, because that is the normal
 *   in-between state while the two PRs land in whichever order CI happens to merge them.
 *
 * ── State model for an ALLOWLIST entry (see validateMigrationPrefixAllowlist) ──
 * For a given prefix, comparing the ALLOWLIST's file set against what's really on disk right now
 * yields one of four states:
 *   - MATCH   (disk has >=2 files, exactly equal to the entry)        -> fine, this is the pin working.
 *   - STALE   (disk has 0 files for the prefix)                      -> FAILS. An ordinary ALLOWLIST
 *     entry pins a collision that is assumed to already exist on disk; if it has vanished (both
 *     files renamed/removed) the row is dead weight and must be deleted from ALLOWLIST. Ordinary
 *     rows are NOT used for "pre-approved but not yet landed" — see PENDING_PAIRS for that case.
 *   - ORPHAN  (disk has exactly 1 file for the prefix)                -> FAILS. The collision this
 *     entry pinned no longer exists as a collision (a rename/removal left one side behind); the
 *     entry is now a dead row and must be deleted from ALLOWLIST rather than kept around stale.
 *   - MISMATCH (disk has >=2 files but a different set than the entry) -> FAILS. Someone renamed a
 *     file that participates in a pinned collision without updating the pin.
 * Symmetrically, any prefix with >=2 files on disk that has NO allowlist entry at all -> FAILS
 * (new, un-reviewed collision).
 *
 * ── State model for a PENDING_PAIRS entry ───────────────────────────────────────
 * A PENDING_PAIRS entry pins a prefix that two independently-authored, already-approved PRs raced
 * on, where the merge order of the two PRs is not controlled by this guard. For a given prefix:
 *   - 0 files on disk    -> fine (neither PR has merged yet).
 *   - 1 file on disk, AND that file is one of the pinned names -> fine (one PR merged, the other is
 *     still pending — this is the transitional state the pair exists to survive without reds).
 *   - 1 file on disk, but NOT one of the pinned names -> FAILS. A single unrelated file must not be
 *     silently absorbed into a pending pair's tolerance.
 *   - >=2 files on disk, exactly equal to the pinned set -> fine (both PRs landed; MATCH).
 *   - >=2 files on disk, a different set -> FAILS (MISMATCH).
 * Once both files of a PENDING_PAIRS entry have landed, move the entry from PENDING_PAIRS to
 * ALLOWLIST (it is now an ordinary pinned collision like the other 12).
 */

const MIGRATIONS_DIR = path.join(__dirname, '../../src/db/migrations')

const MIGRATION_FILENAME_PATTERN = /^(zzzz\d{14})_.+\.ts$/

export type MigrationPrefixAllowlist = Readonly<Record<string, readonly string[]>>

/** The 12 pre-existing collisions from #5912. Every entry's file array must be kept in ascending
 *  sort order (the same order `validateMigrationPrefixAllowlist` sorts disk reads into) so a diff
 *  against disk is a plain array equality. Every entry here is assumed to already exist on disk as
 *  a 2-file collision (MATCH) — a row whose files have vanished (STALE) or shrunk to one (ORPHAN)
 *  fails. For a prefix two in-flight PRs are independently racing on and that is NOT yet fully
 *  landed, use PENDING_PAIRS instead, not this map. */
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
}

/** Prefixes that two independently-authored, already-approved PRs raced on, where this guard must
 *  not block either PR regardless of which merges first. Unlike ALLOWLIST, a PENDING_PAIRS entry
 *  tolerates 0 or 1 of its pinned files being on disk (see the header's "State model for a
 *  PENDING_PAIRS entry" note). Once both files land, move the entry to ALLOWLIST. */
export const PENDING_PAIRS: MigrationPrefixAllowlist = {
  // PR #5893 (multitable template-install ledger) and PR #5915 (ai-bulk-fill commit-phase claim)
  // both independently picked this prefix this week. Whichever merges first leaves exactly one of
  // the two files below on disk (fine — see state model), both merged leaves both files on disk
  // (fine — MATCH). Move this row to ALLOWLIST once both have landed.
  zzzz20260919140000: [
    'zzzz20260919140000_ai_bulk_job_commit_phase_claim.ts',
    'zzzz20260919140000_create_multitable_template_install_ledger.ts',
  ],
}

/** Reads a filename's 14-digit `zzzz` prefix, or null for filenames that don't match the migration
 *  naming convention at all (non-`zzzz` legacy migrations, `.sql` files, `_template.ts`, etc.).
 *  Legacy non-`zzzz` filenames and `.sql` migrations are excluded deliberately: as of this guard's
 *  own commit no legacy prefix is duplicated and no `zzzz`-prefixed `.sql` file exists (both
 *  `.sql` migrations under this directory predate the `zzzz` convention), so neither participates
 *  in the runner's "same prefix, both run" hazard today. If either ever changes — a `.sql` file
 *  picks up a `zzzz` prefix, or a legacy-named migration reuses a legacy prefix — this pattern
 *  needs widening; it is not a structural guarantee, just today's fact. */
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

/** Pure validation: given a filename list, an ordinary ALLOWLIST, and an optional PENDING_PAIRS
 *  map, returns human-readable violation strings (empty array = valid). See the header's state
 *  model notes for what each map tolerates. */
export function validateMigrationPrefixAllowlist(
  filenames: readonly string[],
  allowlist: MigrationPrefixAllowlist,
  pendingPairs: MigrationPrefixAllowlist = {},
): string[] {
  const violations: string[] = []
  const groups = groupMigrationFilenamesByPrefix(filenames)
  const allPrefixes = new Set<string>([
    ...groups.keys(),
    ...Object.keys(allowlist),
    ...Object.keys(pendingPairs),
  ])

  for (const prefix of allPrefixes) {
    const actual = [...(groups.get(prefix) ?? [])].sort()
    const pending = pendingPairs[prefix]

    if (pending) {
      const pendingSorted = [...pending].sort()

      if (actual.length === 0) {
        // Neither pinned file has landed yet. Fine — this is the pre-approved-but-not-yet-realized
        // state PENDING_PAIRS exists for.
        continue
      }

      if (actual.length === 1) {
        if (pendingSorted.includes(actual[0])) {
          // Exactly one of the two pinned PRs has landed. Fine — the transitional state.
          continue
        }
        violations.push(
          `UNEXPECTED file for pending-pair prefix "${prefix}": disk has "${actual[0]}", which is ` +
            `not one of the pinned files [${pendingSorted.join(', ')}]. This prefix is reserved for ` +
            `a pre-approved pending pair — rename this file to an unused prefix.`,
        )
        continue
      }

      // actual.length >= 2
      const pendingMatches =
        pendingSorted.length === actual.length && pendingSorted.every((name, i) => name === actual[i])
      if (!pendingMatches) {
        violations.push(
          `MISMATCH for pending-pair prefix "${prefix}": disk has [${actual.join(', ')}] but ` +
            `PENDING_PAIRS expects [${pendingSorted.join(', ')}]. Update PENDING_PAIRS to match, or ` +
            `investigate the rename. If both pinned files have now landed, move this row to ` +
            `ALLOWLIST instead.`,
        )
      }
      continue
    }

    const allowed = allowlist[prefix]

    if (actual.length === 0) {
      if (allowed) {
        violations.push(
          `STALE allowlist entry for prefix "${prefix}": entry expects ` +
            `[${[...allowed].sort().join(', ')}] but no files with this prefix exist on disk. ` +
            `Delete this ALLOWLIST entry — the collision it pinned no longer exists.`,
        )
      }
      continue
    }

    if (actual.length === 1) {
      // ORPHAN: an allowlisted collision that now has exactly one file left is a dead row — the
      // collision it pinned no longer exists.
      if (allowed) {
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
    const violations = validateMigrationPrefixAllowlist(filenames, ALLOWLIST, PENDING_PAIRS)
    expect(violations).toEqual([])
  })

  it('the disk read is not vacuous (a layout/extension change must not silently empty the scan)', async () => {
    const filenames = await readMigrationFilenames()
    const matched = filenames.filter((name) => extractMigrationPrefix(name) !== null)
    // As of this guard's own commit there are 331 zzzz-prefixed .ts migration files spread over
    // 319 distinct prefixes. A directory move, a `.mts`/`.cts` rename, or a build step that leaves
    // only compiled `.js` behind would make this collapse toward 0 while every ALLOWLIST/
    // PENDING_PAIRS row falls into the deliberately-harmless MISSING/STALE-free state — i.e. the
    // guard would go silently green while scanning nothing. Floors well below the real counts so
    // ordinary migration additions/removals never trip it.
    expect(matched.length).toBeGreaterThan(300)
    expect(groupMigrationFilenamesByPrefix(filenames).size).toBeGreaterThan(300)
  })

  it('every ALLOWLIST entry is sorted ascending (so the disk-diff comparison above is meaningful)', () => {
    for (const [prefix, files] of Object.entries(ALLOWLIST)) {
      const sorted = [...files].sort()
      expect(files, `ALLOWLIST["${prefix}"] must be sorted ascending`).toEqual(sorted)
    }
  })

  it('every PENDING_PAIRS entry is sorted ascending', () => {
    for (const [prefix, files] of Object.entries(PENDING_PAIRS)) {
      const sorted = [...files].sort()
      expect(files, `PENDING_PAIRS["${prefix}"] must be sorted ascending`).toEqual(sorted)
    }
  })

  it('ALLOWLIST and PENDING_PAIRS do not share a prefix (a prefix is one or the other, never both)', () => {
    const allowlistPrefixes = new Set(Object.keys(ALLOWLIST))
    const overlap = Object.keys(PENDING_PAIRS).filter((prefix) => allowlistPrefixes.has(prefix))
    expect(overlap).toEqual([])
  })

  it('every ALLOWLIST prefix is a real 14-digit zzzz prefix, and every filename actually carries it', () => {
    for (const [prefix, files] of Object.entries(ALLOWLIST)) {
      expect(prefix).toMatch(/^zzzz\d{14}$/)
      for (const file of files) {
        expect(extractMigrationPrefix(file)).toBe(prefix)
      }
    }
  })

  it('every PENDING_PAIRS prefix is a real 14-digit zzzz prefix, and every filename actually carries it', () => {
    for (const [prefix, files] of Object.entries(PENDING_PAIRS)) {
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

  it('an allowlisted group with zero files on disk fails as STALE (ordinary rows are not pre-approval)', () => {
    const files: string[] = ['zzzz20270303000000_unrelated.ts']
    const allowlist: MigrationPrefixAllowlist = {
      zzzz20270101000000: ['zzzz20270101000000_a.ts', 'zzzz20270101000000_b.ts'],
    }
    const violations = validateMigrationPrefixAllowlist(files, allowlist)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('STALE')
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

  it('a matching allowlisted group (order-independent) passes', () => {
    const files = ['zzzz20270101000000_b.ts', 'zzzz20270101000000_a.ts']
    const allowlist: MigrationPrefixAllowlist = {
      zzzz20270101000000: ['zzzz20270101000000_a.ts', 'zzzz20270101000000_b.ts'],
    }
    expect(validateMigrationPrefixAllowlist(files, allowlist)).toEqual([])
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

  describe('PENDING_PAIRS — models the real #5893/#5915 race on zzzz20260919140000', () => {
    it('a pending-pair prefix with zero files on disk (neither PR merged yet) is NOT a violation', () => {
      const files: string[] = ['zzzz20270101000000_unrelated.ts']
      const pendingPairs: MigrationPrefixAllowlist = {
        zzzz20260919140000: [
          'zzzz20260919140000_ai_bulk_job_commit_phase_claim.ts',
          'zzzz20260919140000_create_multitable_template_install_ledger.ts',
        ],
      }
      const violations = validateMigrationPrefixAllowlist(files, {}, pendingPairs)
      expect(violations).toEqual([])
    })

    it('a pending-pair prefix with exactly one of its two pinned files landed is NOT a violation', () => {
      // The transitional state after ONE of #5893/#5915 merges and before the other does. Unlike an
      // ordinary ALLOWLIST row (which fails as ORPHAN for a single file), PENDING_PAIRS exists
      // specifically so this in-between state does not red main between the two merges.
      const files = ['zzzz20260919140000_create_multitable_template_install_ledger.ts']
      const pendingPairs: MigrationPrefixAllowlist = {
        zzzz20260919140000: [
          'zzzz20260919140000_ai_bulk_job_commit_phase_claim.ts',
          'zzzz20260919140000_create_multitable_template_install_ledger.ts',
        ],
      }
      const violations = validateMigrationPrefixAllowlist(files, {}, pendingPairs)
      expect(violations).toEqual([])
    })

    it('a pending-pair prefix with only the OTHER pinned file landed is also NOT a violation', () => {
      const files = ['zzzz20260919140000_ai_bulk_job_commit_phase_claim.ts']
      const pendingPairs: MigrationPrefixAllowlist = {
        zzzz20260919140000: [
          'zzzz20260919140000_ai_bulk_job_commit_phase_claim.ts',
          'zzzz20260919140000_create_multitable_template_install_ledger.ts',
        ],
      }
      const violations = validateMigrationPrefixAllowlist(files, {}, pendingPairs)
      expect(violations).toEqual([])
    })

    it('a pending-pair prefix with both pinned files landed passes (MATCH)', () => {
      const files = [
        'zzzz20260919140000_create_multitable_template_install_ledger.ts',
        'zzzz20260919140000_ai_bulk_job_commit_phase_claim.ts',
      ]
      const pendingPairs: MigrationPrefixAllowlist = {
        zzzz20260919140000: [
          'zzzz20260919140000_ai_bulk_job_commit_phase_claim.ts',
          'zzzz20260919140000_create_multitable_template_install_ledger.ts',
        ],
      }
      const violations = validateMigrationPrefixAllowlist(files, {}, pendingPairs)
      expect(violations).toEqual([])
    })

    it('a pending-pair prefix with a single UNRELATED file (not one of the pinned names) fails', () => {
      const files = ['zzzz20260919140000_some_third_unplanned_migration.ts']
      const pendingPairs: MigrationPrefixAllowlist = {
        zzzz20260919140000: [
          'zzzz20260919140000_ai_bulk_job_commit_phase_claim.ts',
          'zzzz20260919140000_create_multitable_template_install_ledger.ts',
        ],
      }
      const violations = validateMigrationPrefixAllowlist(files, {}, pendingPairs)
      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('UNEXPECTED')
      expect(violations[0]).toContain('zzzz20260919140000')
    })

    it('a pending-pair prefix with >=2 files that do not match the pinned set fails as MISMATCH', () => {
      const files = [
        'zzzz20260919140000_ai_bulk_job_commit_phase_claim.ts',
        'zzzz20260919140000_some_third_unplanned_migration.ts',
      ]
      const pendingPairs: MigrationPrefixAllowlist = {
        zzzz20260919140000: [
          'zzzz20260919140000_ai_bulk_job_commit_phase_claim.ts',
          'zzzz20260919140000_create_multitable_template_install_ledger.ts',
        ],
      }
      const violations = validateMigrationPrefixAllowlist(files, {}, pendingPairs)
      expect(violations).toHaveLength(1)
      expect(violations[0]).toContain('MISMATCH')
    })

    it('the real PENDING_PAIRS entry (zzzz20260919140000) reproduces the transitional-state fix against the live disk', async () => {
      // Regression test for the bug this fix round addresses: before the fix, landing exactly one
      // of #5893 / #5915 turned the real ALLOWLIST row into an ORPHAN and reddened this guard. This
      // exercises the REAL exported PENDING_PAIRS (not a synthetic copy) so a future edit that
      // silently drops the real prefix from PENDING_PAIRS, or reverts to putting it back in
      // ALLOWLIST, is caught here.
      expect(Object.keys(PENDING_PAIRS)).toContain('zzzz20260919140000')
      const pinned = PENDING_PAIRS.zzzz20260919140000
      expect(pinned).toBeDefined()

      // Simulate every reachable real-world state for this exact prefix using the actual pinned
      // filenames, independent of what has landed on this branch's own disk.
      expect(validateMigrationPrefixAllowlist([], {}, PENDING_PAIRS)).toEqual([])
      expect(validateMigrationPrefixAllowlist([pinned[0]], {}, PENDING_PAIRS)).toEqual([])
      expect(validateMigrationPrefixAllowlist([pinned[1]], {}, PENDING_PAIRS)).toEqual([])
      expect(validateMigrationPrefixAllowlist([...pinned], {}, PENDING_PAIRS)).toEqual([])
    })
  })
})
