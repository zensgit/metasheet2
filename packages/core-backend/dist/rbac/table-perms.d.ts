/**
 * Table-level RBAC permission checks
 *
 * Provides high-level permission check functions for table read/write access.
 * Integrates with the core RBAC service for permission evaluation.
 */
export interface User {
    id: string;
    roles?: string[];
    permissions?: string[];
}
/**
 * Check if user can read from a table
 * @param user User object with id, roles, and permissions
 * @param tableId Table ID to check access for
 * @returns Promise<boolean> true if user has read access
 */
export declare function canReadTable(user: User, tableId: string): Promise<boolean>;
/**
 * Check if user can write to a table
 * @param user User object with id, roles, and permissions
 * @param tableId Table ID to check access for
 * @returns Promise<boolean> true if user has write access
 */
export declare function canWriteTable(user: User, tableId: string): Promise<boolean>;
//# sourceMappingURL=table-perms.d.ts.map