/**
 * Migration: Create Plugin KV and Communication tables
 * Timestamp: 2025-09-24 17:00:00
 *
 * Fixed version that resolves "db.fn.now is not a function" error
 * by using proper sql template literals instead of db.fn.now()
 */
import { Kysely } from 'kysely';
export declare function up(db: Kysely<any>): Promise<void>;
export declare function down(db: Kysely<any>): Promise<void>;
//# sourceMappingURL=20250924170000_create_plugin_kv_and_comm.d.ts.map