"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isWhitelisted = isWhitelisted;
exports.jwtAuthMiddleware = jwtAuthMiddleware;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const metrics_1 = require("../metrics/metrics");
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
function isWhitelisted(path) {
    return AUTH_WHITELIST.some(p => path.startsWith(p));
}
function jwtAuthMiddleware(req, res, next) {
    try {
        const auth = req.headers['authorization'] || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
        if (!token) {
            metrics_1.metrics.jwtAuthFail.inc({ reason: 'missing_token' });
            metrics_1.metrics.authFailures.inc();
            return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } });
        }
        const secret = process.env.JWT_SECRET || 'dev-secret';
        const payload = jsonwebtoken_1.default.verify(token, secret);
        req.user = payload;
        return next();
    }
    catch (err) {
        metrics_1.metrics.jwtAuthFail.inc({ reason: 'invalid_token' });
        metrics_1.metrics.authFailures.inc();
        return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
    }
}
//# sourceMappingURL=jwt-middleware.js.map