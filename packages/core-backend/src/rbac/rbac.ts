import { Request, Response, NextFunction } from 'express'
import { isAdmin, userHasPermission } from './service'
import { metrics } from '../metrics/metrics'

export type Permission = {
  resource: string
  action: string
}

export async function hasPermission(user: any, perm: Permission): Promise<boolean> {
  if (!user) return false
  const code = `${perm.resource}:${perm.action}`
  // 内联令牌权限
  if (Array.isArray(user.roles) && user.roles.includes('admin')) return true
  if (Array.isArray(user.perms) && user.perms.includes(code)) return true
  // DB 判定
  const uid = user.id as string
  if (!uid) return false
  if (await isAdmin(uid)) return true
  return await userHasPermission(uid, code)
}

export function rbacGuard(resource: string, action: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user
    if (!(await hasPermission(user, { resource, action }))) {
      metrics.rbacDenials.inc()
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permission' } })
    }
    next()
  }
}
