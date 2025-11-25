import { isAdmin, userHasPermission } from './service';
import { metrics } from '../metrics/metrics';
export async function hasPermission(user, perm) {
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
    if (await isAdmin(uid))
        return true;
    return await userHasPermission(uid, code);
}
export function rbacGuard(resource, action) {
    return async (req, res, next) => {
        const user = req.user;
        if (!(await hasPermission(user, { resource, action }))) {
            metrics.rbacDenials.inc();
            return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permission' } });
        }
        next();
    };
}
//# sourceMappingURL=rbac.js.map