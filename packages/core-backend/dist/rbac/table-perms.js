/**
 * Table-level RBAC permission checks
 *
 * Provides high-level permission check functions for table read/write access.
 * Integrates with the core RBAC service for permission evaluation.
 */
import { Logger } from '../core/logger';
import { metrics } from '../metrics/metrics';
const logger = new Logger('TablePerms');
/**
 * Check if user can read from a table
 * @param user User object with id, roles, and permissions
 * @param tableId Table ID to check access for
 * @returns Promise<boolean> true if user has read access
 */
export async function canReadTable(user, tableId) {
    const start = process.hrtime.bigint();
    try {
        // MVP: Allow all authenticated users to read tables
        // TODO: Implement granular RBAC checks with permission service
        const canRead = Boolean(user?.id);
        try {
            metrics.rbacPermissionChecksTotal.labels('read', String(canRead ? 'allow' : 'deny')).inc();
        }
        catch { }
        return canRead;
    }
    catch (error) {
        logger.error(`Error checking read permission for table ${tableId}:`, error);
        try {
            metrics.rbacPermissionChecksTotal.labels('read', 'error').inc();
        }
        catch { }
        // Fail closed: deny access on error
        return false;
    }
    finally {
        try {
            const dur = Number((process.hrtime.bigint() - start)) / 1e9;
            metrics.rbacCheckLatencySeconds.labels('read').observe(dur);
        }
        catch { }
    }
}
/**
 * Check if user can write to a table
 * @param user User object with id, roles, and permissions
 * @param tableId Table ID to check access for
 * @returns Promise<boolean> true if user has write access
 */
export async function canWriteTable(user, tableId) {
    const start = process.hrtime.bigint();
    try {
        // MVP: Allow all authenticated users to write tables
        // TODO: Implement granular RBAC checks with permission service
        const canWrite = Boolean(user?.id);
        try {
            metrics.rbacPermissionChecksTotal.labels('write', String(canWrite ? 'allow' : 'deny')).inc();
        }
        catch { }
        return canWrite;
    }
    catch (error) {
        logger.error(`Error checking write permission for table ${tableId}:`, error);
        try {
            metrics.rbacPermissionChecksTotal.labels('write', 'error').inc();
        }
        catch { }
        // Fail closed: deny access on error
        return false;
    }
    finally {
        try {
            const dur = Number((process.hrtime.bigint() - start)) / 1e9;
            metrics.rbacCheckLatencySeconds.labels('write').observe(dur);
        }
        catch { }
    }
}
//# sourceMappingURL=table-perms.js.map