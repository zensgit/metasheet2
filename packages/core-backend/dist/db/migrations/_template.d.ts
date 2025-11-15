/**
 * Migration Template
 *
 * Purpose: [Describe what this migration does]
 * Tables: [List the tables this migration affects]
 * Breaking: [Yes/No - Does this introduce breaking changes?]
 *
 * Usage:
 * 1. Copy this template to a new file
 * 2. Rename to: YYYYMMDDHHMMSS_descriptive_name.ts
 * 3. Implement the up() and down() methods
 * 4. Add idempotency checks (hasTable, hasColumn, etc.)
 * 5. Test by running the migration twice
 *
 * Example filename: 20251029120000_create_user_preferences.ts
 */
import { Kysely } from 'kysely';
/**
 * Apply the migration
 *
 * This function should:
 * - Check if changes already exist (idempotency)
 * - Create tables, indexes, constraints
 * - Migrate data if needed
 * - Use IF NOT EXISTS where possible
 */
export declare function up(db: Kysely<any>): Promise<void>;
/**
 * Rollback the migration
 *
 * This function should:
 * - Drop triggers
 * - Drop constraints
 * - Drop indexes
 * - Drop tables
 * - Use IF EXISTS where possible
 * - Be safe to run multiple times
 */
export declare function down(db: Kysely<any>): Promise<void>;
//# sourceMappingURL=_template.d.ts.map