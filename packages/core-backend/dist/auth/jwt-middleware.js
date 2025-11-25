import jwt from 'jsonwebtoken';
import { metrics } from '../metrics/metrics';
const AUTH_WHITELIST = [
    '/health',
    '/metrics',
    '/metrics/prom',
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/refresh',
    '/api/plugins',
    '/api/v2/hello',
    '/api/v2/rpc-test',
    '/internal/metrics',
    '/api/cache-test'
];
export function isWhitelisted(path) {
    return AUTH_WHITELIST.some(p => path.startsWith(p));
}
export function jwtAuthMiddleware(req, res, next) {
    try {
        const auth = req.headers['authorization'] || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
        if (!token) {
            metrics.jwtAuthFail.inc({ reason: 'missing_token' });
            metrics.authFailures.inc();
            return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } });
        }
        const secret = process.env.JWT_SECRET || 'dev-secret';
        const payload = jwt.verify(token, secret);
        req.user = payload;
        return next();
    }
    catch (err) {
        metrics.jwtAuthFail.inc({ reason: 'invalid_token' });
        metrics.authFailures.inc();
        return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
    }
}
//# sourceMappingURL=jwt-middleware.js.map