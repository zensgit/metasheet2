export declare function isAdmin(userId: string): Promise<boolean>;
export declare function userHasPermission(userId: string, code: string): Promise<boolean>;
export declare function listUserPermissions(userId: string): Promise<string[]>;
export declare function invalidateUserPerms(userId: string): void;
export declare function getPermCacheStatus(): {
    cacheSize: number;
    ttlMs: number;
    keys: string[];
};
//# sourceMappingURL=service.d.ts.map