import { Request, Response, NextFunction } from 'express';
export type Permission = {
    resource: string;
    action: string;
};
export declare function hasPermission(user: any, perm: Permission): Promise<boolean>;
export declare function rbacGuard(resource: string, action: string): (req: Request, res: Response, next: NextFunction) => Promise<any>;
//# sourceMappingURL=rbac.d.ts.map