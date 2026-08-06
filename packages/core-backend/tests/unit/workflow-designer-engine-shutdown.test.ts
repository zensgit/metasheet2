/**
 * #4783 owner review P3-a — `routes/workflow-designer.ts` constructs its OWN independent
 * `BPMNWorkflowEngine` instance (separate from `routes/workflow.ts`'s), so
 * `routes/workflow.ts`'s pre-existing `shutdownWorkflowEngine()` never reached it: its
 * poller (when `ENABLE_BPMN_TIMER_POLLER=true`) and any in-flight tick were unstoppable
 * from `index.ts`'s `stop()`. `shutdownWorkflowDesignerEngine()` closes that gap,
 * mirrored from the existing `routes/workflow.ts` export and wired into `stop()`
 * alongside it.
 *
 * This spies on the REAL `BPMNWorkflowEngine.prototype.shutdown` (never a mock of the
 * whole class — a full-class mock would make this test pass even if the export called
 * some OTHER object's `.shutdown()`, or nothing at all) to prove the new export actually
 * calls through to THIS module's own engine instance, not merely that it resolves.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/db/db', () => ({
  db: {
    selectFrom: vi.fn(),
    insertInto: vi.fn(),
    updateTable: vi.fn(),
    deleteFrom: vi.fn(),
  },
}))

describe('shutdownWorkflowDesignerEngine (#4783 P3-a)', () => {
  it('calls through to this module\'s own BPMNWorkflowEngine instance\'s real shutdown()', async () => {
    const { BPMNWorkflowEngine } = await import('../../src/workflow/BPMNWorkflowEngine')
    const shutdownSpy = vi.spyOn(BPMNWorkflowEngine.prototype, 'shutdown')

    const { shutdownWorkflowDesignerEngine } = await import('../../src/routes/workflow-designer')
    await expect(shutdownWorkflowDesignerEngine()).resolves.toBeUndefined()

    expect(shutdownSpy).toHaveBeenCalledTimes(1)
    shutdownSpy.mockRestore()
  })

  it('is safe to call when the designer engine was never initialized (no route ever hit)', async () => {
    const { shutdownWorkflowDesignerEngine } = await import('../../src/routes/workflow-designer')
    await expect(shutdownWorkflowDesignerEngine()).resolves.toBeUndefined()
  })
})
