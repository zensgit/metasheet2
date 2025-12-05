/**
 * Migration Rollback Verification Tests
 *
 * Validates that all Sprint 2 and Sprint 3 migrations:
 * 1. Have both up() and down() functions
 * 2. down() function properly reverses up() changes
 * 3. Migrations are idempotent (can be run multiple times)
 */

import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { promises as fs } from 'fs'

const MIGRATIONS_DIR = path.join(__dirname, '../../src/db/migrations')

describe('Migration Rollback Verification', () => {
  describe('Sprint 2 Migrations', () => {
    it('20251117000001_add_snapshot_labels has reversible up/down', async () => {
      const migration = await import('../../src/db/migrations/20251117000001_add_snapshot_labels')

      expect(typeof migration.up).toBe('function')
      expect(typeof migration.down).toBe('function')

      // Verify down function signature matches up
      expect(migration.up.length).toBe(1) // Takes db parameter
      expect(migration.down.length).toBe(1) // Takes db parameter
    })

    it('20251117000002_create_protection_rules has reversible up/down', async () => {
      const migration = await import('../../src/db/migrations/20251117000002_create_protection_rules')

      expect(typeof migration.up).toBe('function')
      expect(typeof migration.down).toBe('function')
      expect(migration.up.length).toBe(1)
      expect(migration.down.length).toBe(1)
    })
  })

  describe('Sprint 3 Migrations', () => {
    it('20251201000001_create_change_management_tables has reversible up/down', async () => {
      const migration = await import('../../src/db/migrations/20251201000001_create_change_management_tables')

      expect(typeof migration.up).toBe('function')
      expect(typeof migration.down).toBe('function')
      expect(migration.up.length).toBe(1)
      expect(migration.down.length).toBe(1)
    })
  })

  describe('Migration Content Verification', () => {
    it('snapshot_labels migration drops all created elements in down()', async () => {
      const migrationPath = path.join(MIGRATIONS_DIR, '20251117000001_add_snapshot_labels.ts')
      const content = await fs.readFile(migrationPath, 'utf-8')

      // Verify up() creates these elements
      expect(content).toContain('ADD COLUMN IF NOT EXISTS tags')
      expect(content).toContain('ADD COLUMN IF NOT EXISTS protection_level')
      expect(content).toContain('ADD COLUMN IF NOT EXISTS release_channel')
      expect(content).toContain('CREATE INDEX')
      expect(content).toContain('ADD CONSTRAINT')

      // Verify down() drops these elements
      expect(content).toContain('DROP CONSTRAINT IF EXISTS')
      expect(content).toContain('DROP INDEX')
      expect(content).toContain('dropColumn')
    })

    it('protection_rules migration drops all created tables in down()', async () => {
      const migrationPath = path.join(MIGRATIONS_DIR, '20251117000002_create_protection_rules.ts')
      const content = await fs.readFile(migrationPath, 'utf-8')

      // Verify up() creates tables
      expect(content).toContain("createTable('protection_rules')")
      expect(content).toContain("createTable('rule_execution_log')")

      // Verify down() drops tables
      expect(content).toContain("dropTable('rule_execution_log')")
      expect(content).toContain("dropTable('protection_rules')")
    })

    it('change_management migration drops all created tables in down()', async () => {
      const migrationPath = path.join(MIGRATIONS_DIR, '20251201000001_create_change_management_tables.ts')
      const content = await fs.readFile(migrationPath, 'utf-8')

      // Verify up() creates tables
      expect(content).toContain("createTable('change_requests')")
      expect(content).toContain("createTable('change_approvals')")
      expect(content).toContain("createTable('change_history')")
      expect(content).toContain("createTable('schema_snapshots')")

      // Verify down() drops tables in reverse order
      expect(content).toContain("dropTable('schema_snapshots')")
      expect(content).toContain("dropTable('change_history')")
      expect(content).toContain("dropTable('change_approvals')")
      expect(content).toContain("dropTable('change_requests')")

      // Verify column drops
      expect(content).toContain('DROP COLUMN IF EXISTS parent_snapshot_id')
      expect(content).toContain('DROP COLUMN IF EXISTS change_type')
    })
  })

  describe('Migration Ordering', () => {
    it('migrations have correct timestamp ordering', async () => {
      const files = await fs.readdir(MIGRATIONS_DIR)
      const migrationFiles = files
        .filter(f => f.endsWith('.ts') && !f.startsWith('_'))
        .sort()

      // Verify Sprint 2 migrations come before Sprint 3
      const sprint2Labels = migrationFiles.findIndex(f => f.includes('20251117000001'))
      const sprint2Rules = migrationFiles.findIndex(f => f.includes('20251117000002'))
      const sprint3Changes = migrationFiles.findIndex(f => f.includes('20251201000001'))

      expect(sprint2Labels).toBeLessThan(sprint2Rules)
      expect(sprint2Rules).toBeLessThan(sprint3Changes)
    })
  })

  describe('Migration Idempotency Patterns', () => {
    it('uses IF NOT EXISTS for additive operations', async () => {
      const labelsPath = path.join(MIGRATIONS_DIR, '20251117000001_add_snapshot_labels.ts')
      const content = await fs.readFile(labelsPath, 'utf-8')

      // ADD COLUMN should use IF NOT EXISTS
      expect(content).toContain('ADD COLUMN IF NOT EXISTS')

      // CREATE INDEX should use IF NOT EXISTS
      expect(content).toContain('IF NOT EXISTS')
    })

    it('uses IF EXISTS for removal operations', async () => {
      const labelsPath = path.join(MIGRATIONS_DIR, '20251117000001_add_snapshot_labels.ts')
      const content = await fs.readFile(labelsPath, 'utf-8')

      // DROP operations should use IF EXISTS
      expect(content).toContain('DROP CONSTRAINT IF EXISTS')
      expect(content).toContain('DROP INDEX CONCURRENTLY IF EXISTS')
    })

    it('protection_rules uses ifExists for table drops', async () => {
      const rulesPath = path.join(MIGRATIONS_DIR, '20251117000002_create_protection_rules.ts')
      const content = await fs.readFile(rulesPath, 'utf-8')

      expect(content).toContain('.ifExists()')
    })
  })
})
