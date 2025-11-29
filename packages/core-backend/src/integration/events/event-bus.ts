import { EventEmitter } from 'eventemitter3'
import { coreMetrics } from '../metrics/metrics'

interface ListenerMeta {
  id: string
  plugin?: string
  pattern: string | RegExp
  handler: (payload: any) => any | Promise<any>
}

let _idSeq = 0

export class EventBus {
  private emitter = new EventEmitter()
  private listeners: Map<string, ListenerMeta> = new Map()

  private dispatch(type: string, payload: any): void {
    coreMetrics.inc('eventsEmitted')
    this.emitter.emit(type, payload)
    // regex listeners
    for (const meta of this.listeners.values()) {
      if (meta.pattern instanceof RegExp && meta.pattern.test(type)) {
        try {
          meta.handler(payload)
        } catch (err) {
          console.error('[event-bus][regex-handler-error]', {
            pattern: meta.pattern.toString(),
            plugin: meta.plugin,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }
  }

  subscribe(pattern: string | RegExp, handler: (payload: any) => any, plugin?: string): string {
    const id = `evt_${++_idSeq}`
    const meta: ListenerMeta = { id, plugin, pattern, handler }
    this.listeners.set(id, meta)

    const wrapper = (data: any) => {
      try {
        handler(data)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[event-bus][handler-error]', { id, pattern, error: (e as Error).message })
      }
    }

    // If pattern is string, direct subscribe.
    if (typeof pattern === 'string') {
      this.emitter.on(pattern, wrapper)
    } else {
      // For RegExp, wrap a generic listener: track all emits
      const regexWrapper = (event: string, data: any) => {
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

  emit(type: string, payload?: any): void {
    this.dispatch(type, payload)
  }

  // Deprecated: publish alias to emit (kept for backward compatibility)
  publish(type: string, payload?: any): void {
    this.dispatch(type, payload)
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

  subscribeForPlugin(pattern: string | RegExp, handler: (payload: any) => any, plugin: string): string {
    return this.subscribe(pattern, handler, plugin)
  }
}

export const eventBus = new EventBus()
