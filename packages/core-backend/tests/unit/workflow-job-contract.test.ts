import { describe, it, expect } from 'vitest'
import {
  WORKFLOW_JOB_STATUSES,
  WORKFLOW_JOB_SUSPEND_REASONS,
  isWorkflowJobStatus,
  normalizeWorkflowJobStatus,
  normalizeWorkflowJob,
  legacyAutomationStatusToJobStatus,
  jobStatusToLegacyAutomationStatus,
  type WorkflowJobStatus,
  type LegacyAutomationStatus,
} from '../../src/multitable/workflow-job-contract'

describe('workflow-job-contract (RFC C1)', () => {
  describe('status enum is strict', () => {
    it('accepts every known status', () => {
      for (const s of WORKFLOW_JOB_STATUSES) {
        expect(isWorkflowJobStatus(s)).toBe(true)
        expect(normalizeWorkflowJobStatus(s)).toBe(s)
      }
    })

    it('rejects unknown / malformed statuses', () => {
      for (const bad of ['SUCCESS', 'pending', 'done', '', null, undefined, 3, {}]) {
        expect(isWorkflowJobStatus(bad)).toBe(false)
        expect(() => normalizeWorkflowJobStatus(bad)).toThrow(TypeError)
      }
    })
  })

  describe('normalizeWorkflowJob', () => {
    const base = { id: 'job_1', executionId: 'axe_1', stepKey: 'action:0', status: 'resolved' as const }

    it('normalizes a minimal valid job', () => {
      expect(normalizeWorkflowJob(base)).toEqual(base)
    })

    it('preserves optional fields', () => {
      const job = { ...base, upstreamJobId: 'job_0', result: { rowsWritten: 1 }, error: undefined }
      const out = normalizeWorkflowJob(job)
      expect(out.upstreamJobId).toBe('job_0')
      expect(out.result).toEqual({ rowsWritten: 1 })
    })

    it('rejects non-object / missing required fields', () => {
      expect(() => normalizeWorkflowJob(null)).toThrow(TypeError)
      expect(() => normalizeWorkflowJob({ ...base, id: '' })).toThrow(/id/)
      expect(() => normalizeWorkflowJob({ id: 'j', executionId: 'e', stepKey: 's', status: 'nope' })).toThrow(/status/)
      expect(() => normalizeWorkflowJob({ ...base, upstreamJobId: 3 })).toThrow(/upstreamJobId/)
    })

    it('enforces suspended ⇔ suspend descriptor (both directions)', () => {
      // suspended WITHOUT descriptor → reject
      expect(() => normalizeWorkflowJob({ ...base, status: 'suspended' })).toThrow(/suspend/)
      // suspend descriptor on a NON-suspended status → reject
      expect(() =>
        normalizeWorkflowJob({ ...base, status: 'resolved', suspend: { reason: 'delay', resumeToken: 't' } }),
      ).toThrow(/suspend is only allowed/)
      // valid suspended job
      const suspended = normalizeWorkflowJob({
        ...base,
        status: 'suspended',
        suspend: { reason: 'manual_task', resumeToken: 'task_42' },
      })
      expect(suspended.suspend).toEqual({ reason: 'manual_task', resumeToken: 'task_42' })
    })

    it('rejects an unknown suspend reason and an empty resumeToken', () => {
      expect(() =>
        normalizeWorkflowJob({ ...base, status: 'suspended', suspend: { reason: 'whenever', resumeToken: 't' } }),
      ).toThrow(/reason/)
      expect(() =>
        normalizeWorkflowJob({ ...base, status: 'suspended', suspend: { reason: 'delay', resumeToken: '' } }),
      ).toThrow(/resumeToken/)
    })

    it('every declared suspend reason is accepted', () => {
      for (const reason of WORKFLOW_JOB_SUSPEND_REASONS) {
        const out = normalizeWorkflowJob({ ...base, status: 'suspended', suspend: { reason, resumeToken: 'tok' } })
        expect(out.suspend?.reason).toBe(reason)
      }
    })
  })

  describe('legacy ↔ converged status bridge', () => {
    const legacyStatuses: LegacyAutomationStatus[] = ['running', 'success', 'failed', 'skipped']

    it('maps legacy → converged with success→resolved, rest identity', () => {
      expect(legacyAutomationStatusToJobStatus('running')).toBe('running')
      expect(legacyAutomationStatusToJobStatus('success')).toBe('resolved')
      expect(legacyAutomationStatusToJobStatus('failed')).toBe('failed')
      expect(legacyAutomationStatusToJobStatus('skipped')).toBe('skipped')
    })

    it('legacy → converged → legacy is identity (no data loss for legacy states)', () => {
      for (const s of legacyStatuses) {
        expect(jobStatusToLegacyAutomationStatus(legacyAutomationStatusToJobStatus(s))).toBe(s)
      }
    })

    it('collapses the new states to the nearest legacy meaning (documented lossiness)', () => {
      expect(jobStatusToLegacyAutomationStatus('queued')).toBe('running')
      expect(jobStatusToLegacyAutomationStatus('suspended')).toBe('running')
      expect(jobStatusToLegacyAutomationStatus('rejected')).toBe('failed')
      expect(jobStatusToLegacyAutomationStatus('errored')).toBe('failed')
    })

    it('the converged → legacy bridge is total over every status', () => {
      for (const s of WORKFLOW_JOB_STATUSES) {
        const legacy = jobStatusToLegacyAutomationStatus(s as WorkflowJobStatus)
        expect(legacyStatuses).toContain(legacy)
      }
    })
  })
})
