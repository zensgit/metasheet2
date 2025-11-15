import { Request, Response, Router } from 'express'
import { metrics } from '../metrics/metrics'
import { auditLog } from '../audit/audit'
import { pool, withTransaction } from '../db/pg'

// Graceful degradation for missing approval tables (Phase B)
let approvalDegraded = false
const allowDegradation = process.env.APPROVAL_OPTIONAL === '1'

function isDatabaseSchemaError(error: any): boolean {
  // PostgreSQL error code 42P01: relation does not exist
  if (error?.code === '42P01') return true
  if (error?.message && typeof error.message === 'string') {
    const msg = error.message.toLowerCase()
    return (msg.includes('relation') || msg.includes('table')) && msg.includes('does not exist')
  }
  return false
}

// 简化的内存存储用于演示乐观锁协议
const instances = new Map<string, { id: string; status: string; version: number }>()
instances.set('demo-1', { id: 'demo-1', status: 'PENDING', version: 0 })

export function approvalsRouter(): Router {
  const r = Router()

  r.get('/api/approvals/:id', async (req: Request, res: Response) => {
    if (pool) {
      try {
        const { rows } = await pool.query('SELECT id, status, version FROM approval_instances WHERE id = $1', [req.params.id])
        if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Instance not found' } })
        return res.json({ ok: true, data: rows[0] })
      } catch (error) {
        if (isDatabaseSchemaError(error) && allowDegradation) {
          if (!approvalDegraded) {
            console.warn('⚠️  Approval service degraded - approval_instances table not found')
            console.warn('⚠️  Falling back to in-memory approval storage')
            console.warn('⚠️  Set APPROVAL_OPTIONAL=1 environment variable is active')
            approvalDegraded = true
          }
          // Fallback to memory
          const inst = instances.get(req.params.id)
          if (!inst) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Instance not found' } })
          return res.json({ ok: true, data: inst })
        }
        throw error
      }
    } else {
      const inst = instances.get(req.params.id)
      if (!inst) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Instance not found' } })
      return res.json({ ok: true, data: inst })
    }
  })

  function canTransition(from: string, action: 'approve'|'reject'|'return'|'revoke'): boolean {
    const allowedFrom: Record<typeof action, string[]> = {
      approve: ['PENDING'],
      reject: ['PENDING'],
      return: ['APPROVED'],
      revoke: ['APPROVED']
    } as const
    return allowedFrom[action].includes(from)
  }

  async function transition(req: Request, res: Response, action: 'approve'|'reject'|'return'|'revoke', newStatus: 'APPROVED'|'REJECTED'|'RETURNED'|'REVOKED') {
    const reqVersion = Number(req.body?.version)
    if (!Number.isInteger(reqVersion)) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'version required' } })
    }

    if (pool) {
      // 使用事务：读取当前状态 -> 校验版本与状态机 -> 更新并记录
      try {
        const result = await withTransaction(async (client) => {
          const cur = await client.query('SELECT id, status, version FROM approval_instances WHERE id=$1', [req.params.id])
          if (!cur.rows.length) {
            return { type: 'not_found' as const }
          }
          const row = cur.rows[0] as { id: string; status: string; version: number }

          if (row.version !== reqVersion) {
            return { type: 'conflict' as const, currentVersion: row.version }
          }

          if (!canTransition(row.status, action)) {
            return { type: 'invalid' as const, from: row.status }
          }

          const newVersion = reqVersion + 1
          await client.query(
            'UPDATE approval_instances SET status=$2, version=$3 WHERE id=$1',
            [row.id, newStatus, newVersion]
          )
          const actorId = (req as any).user?.id || '00000000-0000-0000-0000-000000000001'
          await client.query(
            'INSERT INTO approval_records(instance_id, action, actor_id, comment, from_status, to_status, from_version, to_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [row.id, action, actorId, req.body?.comment || null, row.status, newStatus, reqVersion, newVersion]
          )
          return { type: 'ok' as const, id: row.id, from: row.status, to: newStatus, prevVersion: reqVersion, version: newVersion }
        })

        if (result.type === 'not_found') {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Instance not found' } })
        }
        if (result.type === 'conflict') {
          metrics.approvalActions.inc({ action, result: 'conflict' })
          metrics.approvalConflict.inc({ action })
          return res.status(409).json({ ok: false, error: { code: 'APPROVAL_VERSION_CONFLICT', message: 'Approval instance version mismatch', currentVersion: (result as any).currentVersion } })
        }
        if (result.type === 'invalid') {
          return res.status(422).json({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: `Cannot ${action} from ${(result as any).from}` } })
        }

        const ok = result as any
        metrics.approvalActions.inc({ action, result: 'success' })
        await auditLog({
          actorId: (req as any).user?.id,
          actorType: 'user',
          action,
          resourceType: 'approval',
          resourceId: ok.id,
          ip: req.ip,
          userAgent: req.headers['user-agent'] as string,
          meta: { from: ok.from, to: ok.to, prevVersion: ok.prevVersion, newVersion: ok.version }
        })
        return res.json({ ok: true, data: { id: ok.id, status: ok.to, version: ok.version, prevVersion: ok.prevVersion } })
      } catch (e) {
        if (isDatabaseSchemaError(e) && allowDegradation) {
          if (!approvalDegraded) {
            console.warn('⚠️  Approval service degraded - approval_instances table not found')
            console.warn('⚠️  Falling back to in-memory approval storage')
            console.warn('⚠️  Set APPROVAL_OPTIONAL=1 environment variable is active')
            approvalDegraded = true
          }
          // Fallback to memory logic (same as else branch below)
          const inst = instances.get(req.params.id)
          if (!inst) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Instance not found' } })

          if (inst.version !== reqVersion) {
            metrics.approvalActions.inc({ action, result: 'conflict' })
            metrics.approvalConflict.inc({ action })
            return res.status(409).json({ ok: false, error: { code: 'APPROVAL_VERSION_CONFLICT', message: 'Approval instance version mismatch', currentVersion: inst.version } })
          }
          if (!canTransition(inst.status, action)) {
            return res.status(422).json({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: `Cannot ${action} from ${inst.status}` } })
          }
          inst.status = newStatus
          inst.version += 1
          metrics.approvalActions.inc({ action, result: 'success' })
          await auditLog({
            actorId: (req as any).user?.id,
            actorType: 'user',
            action,
            resourceType: 'approval',
            resourceId: inst.id,
            ip: req.ip,
            userAgent: req.headers['user-agent'] as string,
            meta: { from: null, to: newStatus, version: inst.version }
          })
          return res.json({ ok: true, data: { id: inst.id, status: inst.status, version: inst.version } })
        }
        return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: `${action} failed` } })
      }
    } else {
      // 内存 fallback（开发场景）
      const inst = instances.get(req.params.id)
      if (!inst) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Instance not found' } })

      if (inst.version !== reqVersion) {
        metrics.approvalActions.inc({ action, result: 'conflict' })
        metrics.approvalConflict.inc({ action })
        return res.status(409).json({ ok: false, error: { code: 'APPROVAL_VERSION_CONFLICT', message: 'Approval instance version mismatch', currentVersion: inst.version } })
      }
      if (!canTransition(inst.status, action)) {
        return res.status(422).json({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: `Cannot ${action} from ${inst.status}` } })
      }
      inst.status = newStatus
      inst.version += 1
      metrics.approvalActions.inc({ action, result: 'success' })
      await auditLog({
        actorId: (req as any).user?.id,
        actorType: 'user',
        action,
        resourceType: 'approval',
        resourceId: inst.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'] as string,
        meta: { from: 'PENDING', to: newStatus, prevVersion: reqVersion, newVersion: inst.version }
      })
      return res.json({ ok: true, data: inst })
    }
  }

  r.post('/api/approvals/:id/approve', async (req, res) => transition(req, res, 'approve', 'APPROVED'))
  r.post('/api/approvals/:id/reject', async (req, res) => transition(req, res, 'reject', 'REJECTED'))
  r.post('/api/approvals/:id/return', async (req, res) => transition(req, res, 'return', 'RETURNED'))
  r.post('/api/approvals/:id/revoke', async (req, res) => transition(req, res, 'revoke', 'REVOKED'))

  return r
}
