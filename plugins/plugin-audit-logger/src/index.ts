import type { PluginContext } from '@metasheet/core-backend'

export interface AuditLogEntry {
  id: string
  timestamp: Date
  userId: string
  action: string
  resource: string
  details: Record<string, any>
  ipAddress?: string
  userAgent?: string
}

export interface AuditLoggerConfig {
  logRetentionDays: number
  enableRealTimeLogging: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export class AuditLoggerService {
  private context: PluginContext
  private config: AuditLoggerConfig

  constructor(context: PluginContext, config: AuditLoggerConfig) {
    this.context = context
    this.config = config
  }

  async logAction(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<void> {
    const logEntry: AuditLogEntry = {
      id: this.generateId(),
      timestamp: new Date(),
      ...entry
    }

    try {
      // Store in database
      await this.storeLogEntry(logEntry)

      // Emit event if real-time logging is enabled
      if (this.config.enableRealTimeLogging) {
        this.context.core.events.emit('audit.log.created', logEntry)
      }

      console.log(`[audit-logger] Action logged: ${entry.action} on ${entry.resource}`)
    } catch (error) {
      console.error('[audit-logger] Failed to log action:', error)
    }
  }

  private generateId(): string {
    return `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  private async storeLogEntry(entry: AuditLogEntry): Promise<void> {
    // This would normally store in the database
    // For now, we'll just log to console
    console.log('[audit-logger] Log entry stored:', {
      id: entry.id,
      action: entry.action,
      resource: entry.resource,
      userId: entry.userId,
      timestamp: entry.timestamp.toISOString()
    })
  }

  async getLogs(filters?: {
    userId?: string
    action?: string
    resource?: string
    startDate?: Date
    endDate?: Date
    limit?: number
  }): Promise<AuditLogEntry[]> {
    // This would normally query the database
    console.log('[audit-logger] Getting logs with filters:', filters)
    return []
  }

  async exportLogs(format: 'csv' | 'json' = 'json'): Promise<string> {
    const logs = await this.getLogs()

    if (format === 'csv') {
      // Convert to CSV format
      const headers = ['ID', 'Timestamp', 'User ID', 'Action', 'Resource', 'Details']
      const csvRows = logs.map(log => [
        log.id,
        log.timestamp.toISOString(),
        log.userId,
        log.action,
        log.resource,
        JSON.stringify(log.details)
      ])
      return [headers, ...csvRows].map(row => row.join(',')).join('\n')
    }

    return JSON.stringify(logs, null, 2)
  }

  async clearOldLogs(): Promise<void> {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - this.config.logRetentionDays)

    console.log(`[audit-logger] Clearing logs older than ${cutoffDate.toISOString()}`)
    // This would normally delete from database
  }
}

export default {
  activate(context: PluginContext) {
    console.log('Audit Logger Plugin activated')

    // Get plugin configuration
    const config: AuditLoggerConfig = {
      logRetentionDays: 365,
      enableRealTimeLogging: true,
      logLevel: 'info'
    }

    // Initialize the audit logger service
    const auditLogger = new AuditLoggerService(context, config)

    // Register API routes
    if (context.core.http && context.core.http.addRoute) {
      // GET /api/v2/audit/logs - 获取审计日志列表
      context.core.http.addRoute('GET', '/api/v2/audit/logs', async (req, res) => {
        try {
          const logs = await auditLogger.getLogs({
            userId: req.query.userId as string,
            action: req.query.action as string,
            resource: req.query.resource as string,
            limit: req.query.limit ? parseInt(req.query.limit as string) : undefined
          })
          res.json({ success: true, data: logs })
        } catch (error) {
          res.status(500).json({ success: false, error: error.message })
        }
      })

      // GET /api/v2/audit/logs/:logId - 获取特定审计日志详情
      context.core.http.addRoute('GET', '/api/v2/audit/logs/:logId', async (req, res) => {
        try {
          const logs = await auditLogger.getLogs()
          const log = logs.find(l => l.id === req.params.logId)
          if (log) {
            res.json({ success: true, data: log })
          } else {
            res.status(404).json({ success: false, error: 'Log not found' })
          }
        } catch (error) {
          res.status(500).json({ success: false, error: error.message })
        }
      })

      // POST /api/v2/audit/export - 导出审计日志
      context.core.http.addRoute('POST', '/api/v2/audit/export', async (req, res) => {
        try {
          const format = req.body.format || 'json'
          const exportData = await auditLogger.exportLogs(format)

          res.setHeader('Content-Type', format === 'csv' ? 'text/csv' : 'application/json')
          res.setHeader('Content-Disposition', `attachment; filename="audit-logs.${format}"`)
          res.send(exportData)

          // Emit export event
          context.core.events.emit('audit.log.exported', { format, timestamp: new Date() })
        } catch (error) {
          res.status(500).json({ success: false, error: error.message })
        }
      })

      console.log('Audit Logger API routes registered')
    }

    // Register commands
    if (context.core.events) {
      context.core.events.emit('plugin:command:register', {
        id: 'audit.viewLogs',
        title: '查看审计日志',
        handler: async (args: any) => {
          console.log('Viewing audit logs', args)
          const logs = await auditLogger.getLogs()
          return { success: true, data: logs }
        }
      })

      context.core.events.emit('plugin:command:register', {
        id: 'audit.exportLogs',
        title: '导出日志',
        handler: async (args: any) => {
          console.log('Exporting audit logs', args)
          const format = args.format || 'json'
          const exportData = await auditLogger.exportLogs(format)
          return { success: true, data: exportData }
        }
      })

      context.core.events.emit('plugin:command:register', {
        id: 'audit.clearOldLogs',
        title: '清理旧日志',
        handler: async (args: any) => {
          console.log('Clearing old audit logs', args)
          await auditLogger.clearOldLogs()
          return { success: true, message: 'Old logs cleared successfully' }
        }
      })

      console.log('Audit Logger commands registered')
    }

    // Register the audit logger service globally
    context.core.events.emit('plugin:service:register', {
      name: 'audit-logger',
      service: auditLogger,
      version: '1.0.0'
    })

    // Auto-log system startup
    auditLogger.logAction({
      userId: 'system',
      action: 'plugin.activated',
      resource: 'audit-logger',
      details: { plugin: 'audit-logger', version: '1.0.0' }
    })

    console.log('Audit Logger Plugin registration complete')
  },

  deactivate() {
    console.log('Audit Logger Plugin deactivated')
  }
}