import { Router, Request, Response } from 'express';
import { AuditService } from '../audit/AuditService';
import { AuditRepository } from '../audit/AuditRepository';

const router = Router();
const auditService = new AuditService(new AuditRepository());

/**
 * Query audit logs with filters
 */
router.get('/audit/logs', async (req: Request, res: Response) => {
  try {
    const filters = {
      eventType: req.query.eventType as string,
      eventCategory: req.query.eventCategory as string,
      resourceType: req.query.resourceType as string,
      resourceId: req.query.resourceId as string,
      userId: req.query.userId ? parseInt(req.query.userId as string) : undefined,
      startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
      endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      severity: req.query.severity as string,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 100,
      offset: req.query.offset ? parseInt(req.query.offset as string) : 0
    };

    const logs = await auditService.queryLogs(filters);
    
    res.json({
      success: true,
      data: logs,
      pagination: {
        limit: filters.limit,
        offset: filters.offset,
        total: logs.length
      }
    });
  } catch (error) {
    console.error('Failed to query audit logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to query audit logs'
    });
  }
});

/**
 * Get user activity summary
 */
router.get('/audit/users/:userId/activity', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const days = req.query.days ? parseInt(req.query.days as string) : 30;

    const activity = await auditService.getUserActivity(userId, days);
    
    res.json({
      success: true,
      data: activity
    });
  } catch (error) {
    console.error('Failed to get user activity:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user activity'
    });
  }
});

/**
 * Get security events summary
 */
router.get('/audit/security/summary', async (req: Request, res: Response) => {
  try {
    const days = req.query.days ? parseInt(req.query.days as string) : 7;

    const summary = await auditService.getSecuritySummary(days);
    
    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    console.error('Failed to get security summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get security summary'
    });
  }
});

/**
 * Log a custom event
 */
router.post('/audit/events', async (req: Request, res: Response) => {
  try {
    const { eventType, action, details } = req.body;

    // Set context from request
    const user = (req as any).user;
    if (user) {
      auditService.setContext({
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        userRoles: user.roles
      });
    }

    const logId = await auditService.logEvent(eventType, action, details);
    
    res.json({
      success: true,
      data: { logId }
    });
  } catch (error) {
    console.error('Failed to log event:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to log event'
    });
  }
});

/**
 * Archive old audit logs
 */
router.post('/audit/archive', async (req: Request, res: Response) => {
  try {
    const daysToKeep = req.body.daysToKeep || 90;

    const archivedCount = await auditService.archiveLogs(daysToKeep);
    
    res.json({
      success: true,
      data: {
        archived: archivedCount,
        message: `Archived ${archivedCount} audit logs older than ${daysToKeep} days`
      }
    });
  } catch (error) {
    console.error('Failed to archive logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to archive logs'
    });
  }
});

/**
 * Export audit logs
 */
router.post('/audit/export', async (req: Request, res: Response) => {
  try {
    const { format = 'json', filters = {} } = req.body;

    // Log the export event
    await auditService.logEvent(
      'EXPORT',
      'Export audit logs',
      {
        eventCategory: 'DATA',
        actionDetails: { format, filters }
      }
    );

    // Query logs with filters
    const logs = await auditService.queryLogs(filters);

    // Format response based on requested format
    if (format === 'csv') {
      // Convert to CSV
      const csv = convertToCSV(logs);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
      res.send(csv);
    } else {
      // Default to JSON
      res.json({
        success: true,
        data: logs,
        exportedAt: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Failed to export logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export logs'
    });
  }
});

/**
 * Get audit statistics
 */
router.get('/audit/stats', async (req: Request, res: Response) => {
  try {
    const days = req.query.days ? parseInt(req.query.days as string) : 30;

    // Query different types of statistics
    const [totalLogs, securityEvents, userActivity] = await Promise.all([
      auditService.queryLogs({ 
        startDate: new Date(Date.now() - days * 24 * 60 * 60 * 1000) 
      }),
      auditService.getSecuritySummary(days),
      auditService.queryLogs({ 
        eventCategory: 'USER',
        startDate: new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      })
    ]);

    const stats = {
      period: `${days} days`,
      totalEvents: totalLogs.length,
      eventsByCategory: groupBy(totalLogs, 'event_category'),
      eventsBySeverity: groupBy(totalLogs, 'event_severity'),
      securityEvents: securityEvents.length,
      userActions: userActivity.length,
      topResources: getTopItems(totalLogs, 'resource_type', 10),
      topUsers: getTopItems(totalLogs, 'user_name', 10)
    };
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Failed to get audit stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get audit statistics'
    });
  }
});

// Helper functions
function convertToCSV(logs: any[]): string {
  if (logs.length === 0) return '';
  
  const headers = Object.keys(logs[0]);
  const csvHeaders = headers.join(',');
  
  const csvRows = logs.map(log => {
    return headers.map(header => {
      const value = log[header];
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value).includes(',') ? `"${value}"` : value;
    }).join(',');
  });
  
  return [csvHeaders, ...csvRows].join('\n');
}

function groupBy(array: any[], key: string): Record<string, number> {
  return array.reduce((acc, item) => {
    const value = item[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function getTopItems(array: any[], key: string, limit: number): Array<{ name: string; count: number }> {
  const grouped = groupBy(array, key);
  return Object.entries(grouped)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

export default router;

// Export service for use in other modules
export { auditService };