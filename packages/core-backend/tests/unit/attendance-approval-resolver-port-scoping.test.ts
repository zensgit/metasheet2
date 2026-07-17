import { describe, expect, it } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import type { PluginContext } from '../../src/types/plugin'

// S7-2 precursor (owner P3 on #4415, RATIFIED S7 lock OD-S7-5=d): the approval-assignee resolver port
// is a CAPABILITY BOUNDARY, not a type description — the host injects it into plugin-attendance ONLY.
// Behavior-anchored: we build real plugin contexts through the same private builder the loader uses
// (constructor-initialized injector; no server start, no DB touch on this path) and observe the
// services surface a plugin would actually receive. The positive control (attendance HAS the port,
// with the host-resolved max) keeps the negative leg from passing vacuously if the builder ever
// stops injecting the port at all.

type ContextBuilder = { createPluginContext: (loaded: unknown) => PluginContext }

function contextFor(name: string): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1' })
  return (server as unknown as ContextBuilder).createPluginContext({
    manifest: { name, version: '0.0.0' },
    path: `/nonexistent/${name}`,
  })
}

describe('S7-2 precursor — approvalAssigneeResolver port is scoped to plugin-attendance', () => {
  it('plugin-attendance receives the port (positive control, host-resolved max present)', () => {
    const services = contextFor('plugin-attendance').services as {
      approvalAssigneeResolver?: { maxManagerChainLevels: number; implementedKinds: readonly string[] }
    }
    expect(services.approvalAssigneeResolver).toBeDefined()
    expect(typeof services.approvalAssigneeResolver?.maxManagerChainLevels).toBe('number')
    expect(services.approvalAssigneeResolver?.maxManagerChainLevels).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(services.approvalAssigneeResolver?.implementedKinds)).toBe(true)
  })

  it('a non-attendance plugin does NOT receive the port', () => {
    const services = contextFor('plugin-some-other').services as { approvalAssigneeResolver?: unknown }
    expect(services.approvalAssigneeResolver).toBeUndefined()
  })

  it('plugin-integration-core (the other allowlisted capability holder) does NOT receive this port', () => {
    const services = contextFor('plugin-integration-core').services as { approvalAssigneeResolver?: unknown }
    expect(services.approvalAssigneeResolver).toBeUndefined()
  })

  it('scoping removes ONLY the resolver port — other shared services stay present for other plugins', () => {
    const services = contextFor('plugin-some-other').services as Record<string, unknown>
    expect(services.workdayCalendar).toBeDefined()
    expect(services.attendanceScheduler).toBeDefined()
    expect(services.notification).toBeDefined()
  })
})
