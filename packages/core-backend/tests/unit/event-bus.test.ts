import { describe, expect, test, vi } from 'vitest'
import { EventBus } from '../../src/integration/events/event-bus'

describe('EventBus subscription lifecycle', () => {
  test('unsubscribe removes only the named subscription from a shared event', () => {
    const bus = new EventBus()
    const removed = vi.fn()
    const sibling = vi.fn()
    const removedId = bus.subscribe('approval.approved', removed)
    bus.subscribe('approval.approved', sibling)

    bus.emit('approval.approved')
    expect(bus.unsubscribe(removedId)).toBe(true)
    bus.emit('approval.approved')

    expect(removed).toHaveBeenCalledTimes(1)
    expect(sibling).toHaveBeenCalledTimes(2)
  })

  test('unsubscribeByPlugin removes only that plugin across events', () => {
    const bus = new EventBus()
    const pluginAApproved = vi.fn()
    const pluginARejected = vi.fn()
    const pluginBApproved = vi.fn()
    bus.subscribeForPlugin('approval.approved', pluginAApproved, 'plugin-a')
    bus.subscribeForPlugin('approval.rejected', pluginARejected, 'plugin-a')
    bus.subscribeForPlugin('approval.approved', pluginBApproved, 'plugin-b')

    expect(bus.unsubscribeByPlugin('plugin-a')).toBe(2)
    bus.emit('approval.approved')
    bus.emit('approval.rejected')

    expect(pluginAApproved).not.toHaveBeenCalled()
    expect(pluginARejected).not.toHaveBeenCalled()
    expect(pluginBApproved).toHaveBeenCalledTimes(1)
  })

  test('unknown and repeated unsubscriptions are no-ops', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    const id = bus.subscribe('approval.approved', handler)

    expect(bus.unsubscribe('evt_missing')).toBe(false)
    expect(bus.unsubscribe(id)).toBe(true)
    expect(bus.unsubscribe(id)).toBe(false)
    expect(bus.unsubscribeByPlugin('plugin-missing')).toBe(0)

    bus.emit('approval.approved')
    expect(handler).not.toHaveBeenCalled()
  })

  test('a throwing subscription does not prevent its same-event sibling', () => {
    const bus = new EventBus()
    const failing = vi.fn(() => {
      throw new Error('expected listener failure')
    })
    const sibling = vi.fn()
    bus.subscribe('approval.approved', failing)
    bus.subscribe('approval.approved', sibling)

    expect(() => bus.emit('approval.approved')).not.toThrow()
    expect(failing).toHaveBeenCalledTimes(1)
    expect(sibling).toHaveBeenCalledTimes(1)
  })

  test('a regex subscription remains active after a same-event string subscription is removed', () => {
    const bus = new EventBus()
    const direct = vi.fn()
    const regex = vi.fn()
    const directId = bus.subscribe('approval.approved', direct)
    bus.subscribe(/^approval\./, regex)

    expect(bus.unsubscribe(directId)).toBe(true)
    bus.emit('approval.approved')

    expect(direct).not.toHaveBeenCalled()
    expect(regex).toHaveBeenCalledTimes(1)
  })
})
