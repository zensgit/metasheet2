import { Request, Response, NextFunction } from 'express';
export declare function isWhitelisted(path: string): boolean;
export declare function jwtAuthMiddleware(req: Request, res: Response, next: NextFunction): void | Response<any, Record<string, any>>;
//# sourceMappingURL=jwt-middleware.d.ts.map