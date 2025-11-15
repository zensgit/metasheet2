"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventBus = exports.EventBus = void 0;
const eventemitter3_1 = require("eventemitter3");
const metrics_1 = require("../metrics/metrics");
let _idSeq = 0;
class EventBus {
    emitter = new eventemitter3_1.EventEmitter();
    listeners = new Map();
    dispatch(type, payload) {
        metrics_1.coreMetrics.inc('eventsEmitted');
        this.emitter.emit(type, payload);
        // regex listeners
        for (const meta of this.listeners.values()) {
            if (meta.pattern instanceof RegExp && meta.pattern.test(type)) {
                try {
                    meta.handler(payload);
                }
                catch { /* swallow */ }
            }
        }
    }
    subscribe(pattern, handler, plugin) {
        const id = `evt_${++_idSeq}`;
        const meta = { id, plugin, pattern, handler };
        this.listeners.set(id, meta);
        const wrapper = (data) => {
            try {
                handler(data);
            }
            catch (e) {
                // eslint-disable-next-line no-console
                console.error('[event-bus][handler-error]', { id, pattern, error: e.message });
            }
        };
        // If pattern is string, direct subscribe.
        if (typeof pattern === 'string') {
            this.emitter.on(pattern, wrapper);
        }
        else {
            // For RegExp, wrap a generic listener: track all emits
            const regexWrapper = (event, data) => {
                if (pattern.test(event))
                    wrapper(data);
            };
            // Attach low-level listener map (simulate by hooking into emit path)
            // Simpler approach: monkey patch publish side to iterate regex subs — here we maintain map & manual match.
            // We'll implement a lightweight manual dispatch below.
            // Store original wrapper referencing pattern for manual dispatch migration (future enhancement).
            // For MVP we just store meta and rely on manual dispatch when publish is called.
        }
        return id;
    }
    emit(type, payload) {
        this.dispatch(type, payload);
    }
    // Deprecated: publish alias to emit (kept for backward compatibility)
    publish(type, payload) {
        this.dispatch(type, payload);
    }
    unsubscribe(id) {
        const meta = this.listeners.get(id);
        if (!meta)
            return false;
        if (typeof meta.pattern === 'string') {
            this.emitter.removeAllListeners(meta.pattern);
        }
        this.listeners.delete(id);
        return true;
    }
    unsubscribeByPlugin(plugin) {
        let count = 0;
        for (const [id, meta] of this.listeners.entries()) {
            if (meta.plugin === plugin) {
                this.unsubscribe(id);
                count++;
            }
        }
        return count;
    }
    subscribeForPlugin(pattern, handler, plugin) {
        return this.subscribe(pattern, handler, plugin);
    }
}
exports.EventBus = EventBus;
exports.eventBus = new EventBus();
//# sourceMappingURL=event-bus.js.map