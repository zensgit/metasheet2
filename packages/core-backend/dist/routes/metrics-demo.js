/**
 * Metrics Demo Routes
 * Issue #35: Demonstrates permission metrics in action
 */
import { Router } from 'express';
import PermissionMetricsMiddleware from '../middleware/permission-metrics-middleware';
const router = Router();
// Apply timing middleware to all routes
router.use(PermissionMetricsMiddleware.startTimer);
router.use(PermissionMetricsMiddleware.trackAuthFailure);
/**
 * Public endpoint - no auth required
 */
router.get('/public/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
/**
 * Protected endpoint - requires authentication
 */
router.get('/api/user/profile', PermissionMetricsMiddleware.validateToken, (req, res) => {
    res.json({
        user: req.user,
        message: 'Profile retrieved successfully'
    });
});
/**
 * Admin endpoint - requires admin role
 */
router.get('/api/admin/users', PermissionMetricsMiddleware.validateToken, PermissionMetricsMiddleware.checkPermission('admin:read'), (req, res) => {
    res.json({
        users: [
            { id: '1', name: 'Admin User', role: 'admin' },
            { id: '2', name: 'Editor User', role: 'editor' }
        ]
    });
});
/**
 * Department-restricted endpoint
 */
router.get('/api/hr/employees', PermissionMetricsMiddleware.validateToken, PermissionMetricsMiddleware.checkDepartmentAccess(['hr', 'admin']), (req, res) => {
    res.json({
        employees: [
            { id: 'emp1', name: 'John Doe', department: 'hr' },
            { id: 'emp2', name: 'Jane Smith', department: 'hr' }
        ]
    });
});
/**
 * Spreadsheet operations - various permission levels
 */
router.get('/api/spreadsheets/:id', PermissionMetricsMiddleware.validateToken, PermissionMetricsMiddleware.checkPermission('spreadsheet:read'), (req, res) => {
    res.json({
        id: req.params.id,
        name: 'Sample Spreadsheet',
        data: [[1, 2, 3], [4, 5, 6]]
    });
});
router.put('/api/spreadsheets/:id', PermissionMetricsMiddleware.validateToken, PermissionMetricsMiddleware.checkPermission('spreadsheet:write'), (req, res) => {
    res.json({
        id: req.params.id,
        message: 'Spreadsheet updated successfully'
    });
});
router.delete('/api/spreadsheets/:id', PermissionMetricsMiddleware.validateToken, PermissionMetricsMiddleware.checkPermission('spreadsheet:delete'), (req, res) => {
    // Only admins and owners can delete
    const user = req.user;
    if (user.role !== 'admin') {
        return res.status(403).json({
            error: 'Only admins can delete spreadsheets',
            reason: 'not_owner'
        });
    }
    res.json({
        id: req.params.id,
        message: 'Spreadsheet deleted successfully'
    });
});
/**
 * Workflow operations
 */
router.post('/api/workflows', PermissionMetricsMiddleware.validateToken, PermissionMetricsMiddleware.checkPermission('workflow:create'), (req, res) => {
    res.status(201).json({
        id: 'wf-' + Date.now(),
        message: 'Workflow created successfully'
    });
});
/**
 * Approval operations - department restricted
 */
router.get('/api/approvals/finance', PermissionMetricsMiddleware.validateToken, PermissionMetricsMiddleware.checkDepartmentAccess(['finance', 'admin']), (req, res) => {
    res.json({
        approvals: [
            { id: 'apr1', type: 'expense', amount: 5000 },
            { id: 'apr2', type: 'budget', amount: 100000 }
        ]
    });
});
/**
 * Metrics endpoint
 */
router.get('/metrics', PermissionMetricsMiddleware.metricsEndpoint);
/**
 * Demo endpoints to trigger various failures
 */
router.get('/demo/trigger-failures', async (req, res) => {
    const results = [];
    // Trigger no token failure
    await fetch('http://localhost:8900/api/admin/users')
        .then(r => results.push({ test: 'no_token', status: r.status }))
        .catch(() => results.push({ test: 'no_token', error: true }));
    // Trigger expired token
    await fetch('http://localhost:8900/api/user/profile', {
        headers: { Authorization: 'Bearer expired-token' }
    })
        .then(r => results.push({ test: 'expired_token', status: r.status }))
        .catch(() => results.push({ test: 'expired_token', error: true }));
    // Trigger insufficient permission
    await fetch('http://localhost:8900/api/admin/users', {
        headers: { Authorization: 'Bearer viewer-token' }
    })
        .then(r => results.push({ test: 'insufficient_permission', status: r.status }))
        .catch(() => results.push({ test: 'insufficient_permission', error: true }));
    // Trigger department restriction
    await fetch('http://localhost:8900/api/hr/employees', {
        headers: { Authorization: 'Bearer engineering-token' }
    })
        .then(r => results.push({ test: 'department_restricted', status: r.status }))
        .catch(() => results.push({ test: 'department_restricted', error: true }));
    res.json({
        message: 'Failure scenarios triggered',
        results,
        hint: 'Check /metrics endpoint for Prometheus metrics'
    });
});
/**
 * Session simulation endpoints
 */
router.post('/api/auth/login', (req, res) => {
    PermissionMetricsMiddleware.trackSession('login');
    res.json({
        token: 'sample-token-' + Date.now(),
        user: { id: 'user123', role: 'editor' }
    });
});
router.post('/api/auth/logout', PermissionMetricsMiddleware.validateToken, (req, res) => {
    PermissionMetricsMiddleware.trackSession('logout');
    res.json({ message: 'Logged out successfully' });
});
export default router;
//# sourceMappingURL=metrics-demo.js.map