import { EventEmitter } from 'eventemitter3'
import { coreMetrics } from '../metrics/metrics'
import { Logger } from '../../core/logger'

const logger = new Logger('EventBus')

// Generic event payload type - can be extended by specific event types
type EventPayload = Record<string, unknown> | unknown

// Event handler that returns void or Promise<void>
type EventHandler<T = EventPayload> = (payload: T) => void | Promise<void>

interface ListenerMeta {
  id: string
  plugin?: string
  pattern: string | RegExp
  handler: EventHandler
}

let _idSeq = 0

export class EventBus {
  private emitter = new EventEmitter()
  private listeners: Map<string, ListenerMeta> = new Map()

  private dispatch(type: string, payload: EventPayload): void {
    coreMetrics.inc('eventsEmitted')
    this.emitter.emit(type, payload)
    // regex listeners
    for (const meta of this.listeners.values()) {
      if (meta.pattern instanceof RegExp && meta.pattern.test(type)) {
        try {
          meta.handler(payload)
        } catch (err) {
          logger.error(`Regex handler error for pattern ${meta.pattern.toString()} (plugin: ${meta.plugin})`, err instanceof Error ? err : undefined)
        }
      }
    }
  }

  subscribe<T = EventPayload>(pattern: string | RegExp, handler: EventHandler<T>, plugin?: string): string {
    const id = `evt_${++_idSeq}`
    // Type assertion needed here as we're storing generic handlers
    const meta: ListenerMeta = { id, plugin, pattern, handler: handler as EventHandler }
    this.listeners.set(id, meta)

    const wrapper = (data: unknown) => {
      try {
        handler(data as T)
      } catch (e) {
        logger.error(`Handler error for pattern ${String(pattern)} (id: ${id})`, e instanceof Error ? e : undefined)
      }
    }

    // If pattern is string, direct subscribe.
    if (typeof pattern === 'string') {
      this.emitter.on(pattern, wrapper)
    } else {
      // For RegExp, wrap a generic listener: track all emits
      const _regexWrapper = (event: string, data: unknown) => {
        if (pattern.test(event)) wrapper(data)
      }
      // Attach low-level listener map (simulate by hooking into emit path)
      // Simpler approach: monkey patch publish side to iterate regex subs — here we maintain map & manual match.
      // We'll implement a lightweight manual dispatch below.
      // Store original wrapper referencing pattern for manual dispatch migration (future enhancement).
      // For MVP we just store meta and rely on manual dispatch when publish is called.
    }
    return id
  }

  emit<T = EventPayload>(type: string, payload?: T): void {
    this.dispatch(type, payload ?? {})
  }

  // Deprecated: publish alias to emit (kept for backward compatibility)
  publish<T = EventPayload>(type: string, payload?: T): void {
    this.dispatch(type, payload ?? {})
  }

  unsubscribe(id: string): boolean {
    const meta = this.listeners.get(id)
    if (!meta) return false
    if (typeof meta.pattern === 'string') {
      this.emitter.removeAllListeners(meta.pattern)
    }
    this.listeners.delete(id)
    return true
  }

  unsubscribeByPlugin(plugin: string): number {
    let count = 0
    for (const [id, meta] of this.listeners.entries()) {
      if (meta.plugin === plugin) {
        this.unsubscribe(id)
        count++
      }
    }
    return count
  }

  subscribeForPlugin<T = EventPayload>(pattern: string | RegExp, handler: EventHandler<T>, plugin: string): string {
    return this.subscribe(pattern, handler, plugin)
  }
}

export const eventBus = new EventBus()
