"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAdmin = isAdmin;
exports.userHasPermission = userHasPermission;
exports.listUserPermissions = listUserPermissions;
exports.invalidateUserPerms = invalidateUserPerms;
exports.getPermCacheStatus = getPermCacheStatus;
const pg_1 = require("../db/pg");
const metrics_1 = require("../metrics/metrics");
const cache = new Map();
const TTL_MS = parseInt(process.env.RBAC_CACHE_TTL_MS || '60000', 10);
async function isAdmin(userId) {
    if (!pg_1.pool)
        return false;
    const { rows } = await pg_1.pool.query('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1', [userId, 'admin']);
    return rows.length > 0;
}
async function userHasPermission(userId, code) {
    if (!pg_1.pool)
        return false;
    // direct user permission
    const direct = await pg_1.pool.query('SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_code = $2 LIMIT 1', [userId, code]);
    if (direct.rows.length > 0)
        return true;
    // via roles
    const viaRole = await pg_1.pool.query(`SELECT 1
     FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE ur.user_id = $1 AND rp.permission_code = $2
     LIMIT 1`, [userId, code]);
    return viaRole.rows.length > 0;
}
async function listUserPermissions(userId) {
    const now = Date.now();
    const key = `perms:${userId}`;
    const hit = cache.get(key);
    if (hit && hit.exp > now) {
        metrics_1.metrics.rbacPermCacheHits.inc();
        return hit.codes;
    }
    metrics_1.metrics.rbacPermCacheMiss.inc();
    if (!pg_1.pool)
        return [];
    const { rows } = await pg_1.pool.query(`SELECT DISTINCT permission_code AS code FROM (
       SELECT up.permission_code FROM user_permissions up WHERE up.user_id = $1
       UNION ALL
       SELECT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = $1
     ) t`, [userId]);
    const codes = rows.map(r => r.code);
    cache.set(key, { codes, exp: now + TTL_MS });
    return codes;
}
function invalidateUserPerms(userId) {
    cache.delete(`perms:${userId}`);
}
function getPermCacheStatus() {
    return {
        cacheSize: cache.size,
        ttlMs: TTL_MS,
        keys: Array.from(cache.keys())
    };
}
//# sourceMappingURL=service.js.map