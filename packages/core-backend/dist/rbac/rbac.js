"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasPermission = hasPermission;
exports.rbacGuard = rbacGuard;
const service_1 = require("./service");
const metrics_1 = require("../metrics/metrics");
async function hasPermission(user, perm) {
    if (!user)
        return false;
    const code = `${perm.resource}:${perm.action}`;
    // 内联令牌权限
    if (Array.isArray(user.roles) && user.roles.includes('admin'))
        return true;
    if (Array.isArray(user.perms) && user.perms.includes(code))
        return true;
    // DB 判定
    const uid = user.id;
    if (!uid)
        return false;
    if (await (0, service_1.isAdmin)(uid))
        return true;
    return await (0, service_1.userHasPermission)(uid, code);
}
function rbacGuard(resource, action) {
    return async (req, res, next) => {
        const user = req.user;
        if (!(await hasPermission(user, { resource, action }))) {
            metrics_1.metrics.rbacDenials.inc();
            return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permission' } });
        }
        next();
    };
}
//# sourceMappingURL=rbac.js.map