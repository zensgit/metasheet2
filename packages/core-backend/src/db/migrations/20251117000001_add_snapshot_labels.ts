/**
 * Migration: Add snapshot labeling and protection fields
 *
 * Adds tags, protection_level, and release_channel to snapshots table
 * with appropriate indexes for query performance.
 */

import type { Kysely} from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add new columns to snapshots table using raw SQL for PostgreSQL array type
  await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}'`.execute(db);
  await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS protection_level text DEFAULT 'normal'`.execute(db);
  await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS release_channel text`.execute(db);

  // Create GIN index for array operations on tags
  await sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_snapshots_tags ON snapshots USING GIN(tags)`.execute(
    db
  );

  // Create B-tree indexes for protection_level and release_channel
  await sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_snapshots_protection_level ON snapshots(protection_level)`.execute(
    db
  );

  await sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_snapshots_release_channel ON snapshots(release_channel) WHERE release_channel IS NOT NULL`.execute(
    db
  );

  // Add check constraint for protection_level
  await sql`ALTER TABLE snapshots ADD CONSTRAINT chk_protection_level CHECK (protection_level IN ('normal', 'protected', 'critical'))`.execute(
    db
  );

  // Add check constraint for release_channel
  await sql`ALTER TABLE snapshots ADD CONSTRAINT chk_release_channel CHECK (release_channel IS NULL OR release_channel IN ('stable', 'canary', 'beta', 'experimental'))`.execute(
    db
  );

  console.log('✅ Added snapshot labeling columns and indexes');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop constraints first
  await sql`ALTER TABLE snapshots DROP CONSTRAINT IF EXISTS chk_protection_level`.execute(
    db
  );
  await sql`ALTER TABLE snapshots DROP CONSTRAINT IF EXISTS chk_release_channel`.execute(
    db
  );

  // Drop indexes
  await sql`DROP INDEX CONCURRENTLY IF EXISTS idx_snapshots_tags`.execute(db);
  await sql`DROP INDEX CONCURRENTLY IF EXISTS idx_snapshots_protection_level`.execute(
    db
  );
  await sql`DROP INDEX CONCURRENTLY IF EXISTS idx_snapshots_release_channel`.execute(
    db
  );

  // Drop columns
  await db.schema
    .alterTable('snapshots')
    .dropColumn('tags')
    .dropColumn('protection_level')
    .dropColumn('release_channel')
    .execute();

  console.log('✅ Rolled back snapshot labeling columns');
}
