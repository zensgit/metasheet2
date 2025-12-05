/**
 * Approvals Router
 * Handles approval workflow endpoints
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { authenticate } from '../middleware/auth'
import { Logger } from '../core/logger'
import { pool } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'

const logger = new Logger('ApprovalsRouter')

// Graceful degradation for missing tables
let approvalsDegraded = false
const allowDegradation = process.env.APPROVALS_OPTIONAL === '1'

interface ApprovalRecord {
  id: string
  instance_id: string
  action: string
  actor_id: string
  actor_name: string | null
  comment: string | null
  reason: string | null
  from_status: string | null
  to_status: string
  from_version: number | null
  to_version: number
  metadata: Record<string, unknown>
  occurred_at: Date
  created_at: Date
}

interface ApprovalInstance {
  id: string
  status: string
  version: number
  created_at: Date
  updated_at: Date
}

export function approvalsRouter(): Router {
  const r = Router()

  // Get pending approvals for current user
  r.get('/api/approvals/pending', authenticate, async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json({ error: 'Database not available' })
      }

      const userId = req.user?.sub || req.user?.userId
      if (!userId) {
        return res.status(401).json({ error: 'User ID not found in token' })
      }

      const limit = parseInt(req.query.limit as string) || 50
      const offset = parseInt(req.query.offset as string) || 0

      const result = await pool.query<ApprovalInstance>(
        `SELECT ai.* FROM approval_instances ai
         WHERE ai.status = 'pending'
         ORDER BY ai.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      )

      const countResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM approval_instances WHERE status = 'pending'`
      )

      res.json({
        data: result.rows,
        total: parseInt(countResult.rows[0]?.count || '0'),
        limit,
        offset
      })
    } catch (error) {
      if (isDatabaseSchemaError(error) && allowDegradation) {
        if (!approvalsDegraded) {
          logger.warn('Approvals service degraded - tables not found')
          approvalsDegraded = true
        }
        return res.json({ data: [], total: 0, degraded: true })
      }
      logger.error('Failed to get pending approvals', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to get pending approvals' })
    }
  })

  // Get approval history for an instance
  r.get('/api/approvals/:instanceId/history', authenticate, async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json({ error: 'Database not available' })
      }

      const { instanceId } = req.params

      const result = await pool.query<ApprovalRecord>(
        `SELECT * FROM approval_records
         WHERE instance_id = $1
         ORDER BY occurred_at DESC`,
        [instanceId]
      )

      res.json({
        data: result.rows,
        total: result.rowCount || 0
      })
    } catch (error) {
      if (isDatabaseSchemaError(error) && allowDegradation) {
        if (!approvalsDegraded) {
          logger.warn('Approvals service degraded - tables not found')
          approvalsDegraded = true
        }
        return res.json({ data: [], total: 0, degraded: true })
      }
      logger.error('Failed to get approval history', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to get approval history' })
    }
  })

  // Approve a request
  r.post('/api/approvals/:id/approve', authenticate, async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json({ error: 'Database not available' })
      }

      const { id } = req.params
      const { comment, metadata = {} } = req.body
      const userId = req.user?.sub || req.user?.userId
      const userName = req.user?.name || req.user?.email || userId

      if (!userId) {
        return res.status(401).json({ error: 'User ID not found in token' })
      }

      // Start transaction
      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Get current instance
        const instanceResult = await client.query<ApprovalInstance>(
          'SELECT * FROM approval_instances WHERE id = $1 FOR UPDATE',
          [id]
        )

        if (instanceResult.rows.length === 0) {
          await client.query('ROLLBACK')
          return res.status(404).json({ error: 'Approval instance not found' })
        }

        const instance = instanceResult.rows[0]
        if (instance.status !== 'pending') {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: `Cannot approve: current status is ${instance.status}` })
        }

        const newVersion = instance.version + 1

        // Update instance
        await client.query(
          `UPDATE approval_instances
           SET status = 'approved', version = $1, updated_at = now()
           WHERE id = $2`,
          [newVersion, id]
        )

        // Create approval record
        await client.query(
          `INSERT INTO approval_records
           (instance_id, action, actor_id, actor_name, comment, from_status, to_status, from_version, to_version, metadata, ip_address, user_agent)
           VALUES ($1, 'approve', $2, $3, $4, $5, 'approved', $6, $7, $8, $9, $10)`,
          [
            id,
            userId,
            userName,
            comment || null,
            instance.status,
            instance.version,
            newVersion,
            JSON.stringify(metadata),
            req.ip || null,
            req.get('user-agent') || null
          ]
        )

        await client.query('COMMIT')

        logger.info(`Approval ${id} approved by ${userId}`)
        res.json({
          success: true,
          id,
          status: 'approved',
          version: newVersion
        })
      } catch (innerError) {
        await client.query('ROLLBACK')
        throw innerError
      } finally {
        client.release()
      }
    } catch (error) {
      if (isDatabaseSchemaError(error) && allowDegradation) {
        if (!approvalsDegraded) {
          logger.warn('Approvals service degraded - tables not found')
          approvalsDegraded = true
        }
        return res.json({ success: true, id: req.params.id, degraded: true })
      }
      logger.error('Failed to approve request', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to approve request' })
    }
  })

  // Reject a request
  r.post('/api/approvals/:id/reject', authenticate, async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json({ error: 'Database not available' })
      }

      const { id } = req.params
      const { reason, comment, metadata = {} } = req.body
      const userId = req.user?.sub || req.user?.userId
      const userName = req.user?.name || req.user?.email || userId

      if (!userId) {
        return res.status(401).json({ error: 'User ID not found in token' })
      }

      if (!reason) {
        return res.status(400).json({ error: 'Rejection reason is required' })
      }

      // Start transaction
      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Get current instance
        const instanceResult = await client.query<ApprovalInstance>(
          'SELECT * FROM approval_instances WHERE id = $1 FOR UPDATE',
          [id]
        )

        if (instanceResult.rows.length === 0) {
          await client.query('ROLLBACK')
          return res.status(404).json({ error: 'Approval instance not found' })
        }

        const instance = instanceResult.rows[0]
        if (instance.status !== 'pending') {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: `Cannot reject: current status is ${instance.status}` })
        }

        const newVersion = instance.version + 1

        // Update instance
        await client.query(
          `UPDATE approval_instances
           SET status = 'rejected', version = $1, updated_at = now()
           WHERE id = $2`,
          [newVersion, id]
        )

        // Create rejection record
        await client.query(
          `INSERT INTO approval_records
           (instance_id, action, actor_id, actor_name, reason, comment, from_status, to_status, from_version, to_version, metadata, ip_address, user_agent)
           VALUES ($1, 'reject', $2, $3, $4, $5, $6, 'rejected', $7, $8, $9, $10, $11)`,
          [
            id,
            userId,
            userName,
            reason,
            comment || null,
            instance.status,
            instance.version,
            newVersion,
            JSON.stringify(metadata),
            req.ip || null,
            req.get('user-agent') || null
          ]
        )

        await client.query('COMMIT')

        logger.info(`Approval ${id} rejected by ${userId}: ${reason}`)
        res.json({
          success: true,
          id,
          status: 'rejected',
          version: newVersion
        })
      } catch (innerError) {
        await client.query('ROLLBACK')
        throw innerError
      } finally {
        client.release()
      }
    } catch (error) {
      if (isDatabaseSchemaError(error) && allowDegradation) {
        if (!approvalsDegraded) {
          logger.warn('Approvals service degraded - tables not found')
          approvalsDegraded = true
        }
        return res.json({ success: true, id: req.params.id, degraded: true })
      }
      logger.error('Failed to reject request', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to reject request' })
    }
  })

  // Get single approval instance details
  r.get('/api/approvals/:id', authenticate, async (req: Request, res: Response) => {
    try {
      if (!pool) {
        return res.status(503).json({ error: 'Database not available' })
      }

      const { id } = req.params

      const result = await pool.query<ApprovalInstance>(
        'SELECT * FROM approval_instances WHERE id = $1',
        [id]
      )

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Approval instance not found' })
      }

      res.json(result.rows[0])
    } catch (error) {
      if (isDatabaseSchemaError(error) && allowDegradation) {
        if (!approvalsDegraded) {
          logger.warn('Approvals service degraded - tables not found')
          approvalsDegraded = true
        }
        return res.status(404).json({ error: 'Not found', degraded: true })
      }
      logger.error('Failed to get approval', error instanceof Error ? error : undefined)
      res.status(500).json({ error: 'Failed to get approval' })
    }
  })

  return r
}
