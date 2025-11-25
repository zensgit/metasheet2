import { randomUUID } from 'crypto';
import { coreMetrics } from '../metrics/metrics';
class MessageBus {
    subs = new Map();
    patternSubs = [];
    queue = [];
    processing = false;
    pendingRpc = new Map();
    defaultRetries = 2;
    subscribe(topic, handler, plugin) {
        const sub = { id: `sub_${randomUUID()}`, topic, handler, plugin };
        if (!this.subs.has(topic))
            this.subs.set(topic, []);
        this.subs.get(topic).push(sub);
        return sub.id;
    }
    /**
     * Pattern subscription (Variant 2):
     * Supported forms:
     *   - Exact topic: e.g. "order.created"
     *   - Prefix form: "prefix.*" meaning any topic beginning with `prefix.` and at least one more segment/char
     * Constraints:
     *   - Only single trailing "prefix.*" allowed
     *   - Reject multiple '*' or middle '*' usages (e.g. order.*.created)
     *   - Reject lone '*' (ambiguous / too broad)
     */
    subscribePattern(pattern, handler, plugin) {
        const stars = (pattern.match(/\*/g) || []).length;
        if (pattern === '*' || pattern === '.*') {
            throw new Error('Wildcard "*" alone not supported; use specific prefix like "order.*"');
        }
        if (stars > 1 || (stars === 1 && !pattern.endsWith('.*'))) {
            throw new Error('Only single trailing prefix.* supported (e.g. "order.*")');
        }
        let regex;
        if (pattern.endsWith('.*')) {
            const prefix = pattern.slice(0, -2);
            const escaped = prefix.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
            // Require at least one char after the dot
            regex = new RegExp('^' + escaped + '\\..+');
        }
        else {
            const escapedExact = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
            regex = new RegExp('^' + escapedExact + '$');
        }
        const id = `psub_${randomUUID()}`;
        this.patternSubs.push({ id, pattern, regex, handler, plugin });
        return id;
    }
    unsubscribe(subId) {
        // exact subs
        for (const [topic, arr] of this.subs.entries()) {
            const idx = arr.findIndex(s => s.id === subId);
            if (idx >= 0) {
                arr.splice(idx, 1);
                if (arr.length === 0)
                    this.subs.delete(topic);
                return true;
            }
        }
        // pattern subs
        const pIdx = this.patternSubs.findIndex(p => p.id === subId);
        if (pIdx >= 0) {
            this.patternSubs.splice(pIdx, 1);
            return true;
        }
        return false;
    }
    unsubscribeByPlugin(plugin) {
        let count = 0;
        for (const arr of this.subs.values()) {
            for (let i = arr.length - 1; i >= 0; i--) {
                if (arr[i].plugin === plugin) {
                    arr.splice(i, 1);
                    count++;
                }
            }
        }
        for (let i = this.patternSubs.length - 1; i >= 0; i--) {
            if (this.patternSubs[i].plugin === plugin) {
                this.patternSubs.splice(i, 1);
                count++;
            }
        }
        return count;
    }
    /** Track subscriptions by plugin name for lifecycle cleanup */
    subscribeWithPlugin(topic, handler, plugin) {
        return this.subscribe(topic, handler, plugin);
    }
    async publish(topic, payload, opts = {}) {
        const msg = {
            id: `msg_${randomUUID()}`,
            topic,
            payload,
            priority: opts.priority || 'normal',
            attempts: 0,
            maxRetries: opts.maxRetries ?? this.defaultRetries,
            correlationId: opts.correlationId,
            replyTo: opts.replyTo,
            createdAt: Date.now(),
            expiresAt: opts.expiresAt ?? (opts.expiryMs ? Date.now() + opts.expiryMs : undefined)
        };
        // Immediate expiry short-circuit (avoid enqueuing stale messages)
        if (msg.expiresAt && msg.expiresAt <= Date.now()) {
            coreMetrics.inc('messagesExpired');
            return msg.id;
        }
        this.enqueue(msg);
        this.processQueue();
        return msg.id;
    }
    enqueue(msg) {
        // Insert based on priority (simple approach: unshift high, push low)
        if (msg.priority === 'high') {
            this.queue.unshift(msg);
        }
        else if (msg.priority === 'low') {
            this.queue.push(msg);
        }
        else {
            // normal -> middle: push then slight bubble behind high items
            const hiCount = this.queue.findIndex(m => m.priority !== 'high');
            if (hiCount === -1)
                this.queue.push(msg);
            else
                this.queue.splice(hiCount, 0, msg);
        }
    }
    async processQueue() {
        if (this.processing)
            return;
        this.processing = true;
        while (this.queue.length) {
            const msg = this.queue.shift();
            // expiry check
            if (msg.expiresAt && Date.now() >= msg.expiresAt) {
                coreMetrics.inc('messagesExpired');
                continue;
            }
            const subs = this.subs.get(msg.topic);
            const matchedPatternSubs = this.patternSubs.filter(p => p.regex.test(msg.topic));
            const allSubs = [...(subs || []), ...matchedPatternSubs.map(p => ({ id: p.id, topic: p.pattern, handler: p.handler, plugin: p.plugin }))];
            if (allSubs.length === 0) {
                // No subscriber -> if RPC request and expecting reply -> reject
                if (msg.replyTo && msg.correlationId) {
                    const pending = this.pendingRpc.get(msg.correlationId);
                    pending?.reject(new Error('No subscriber for RPC target'));
                    this.pendingRpc.delete(msg.correlationId);
                }
                continue;
            }
            for (const sub of allSubs) {
                try {
                    await sub.handler(msg);
                    coreMetrics.inc('messagesProcessed');
                }
                catch (e) {
                    msg.attempts += 1;
                    coreMetrics.inc('messagesRetried');
                    if (msg.attempts <= msg.maxRetries) {
                        this.enqueue(msg);
                    }
                    else if (msg.correlationId && this.pendingRpc.has(msg.correlationId)) {
                        const pending = this.pendingRpc.get(msg.correlationId);
                        pending.reject(e);
                        this.pendingRpc.delete(msg.correlationId);
                    }
                }
            }
        }
        this.processing = false;
    }
    // RPC request
    async request(topic, payload, timeoutMs = 3000) {
        const correlationId = randomUUID();
        const replyTopic = `__rpc.reply.${correlationId}`;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRpc.delete(correlationId);
                coreMetrics.inc('rpcTimeouts');
                reject(new Error('RPC timeout'));
            }, timeoutMs);
            this.pendingRpc.set(correlationId, { resolve, reject, timeout });
            // subscribe once for reply & capture id for cleanup
            const replySubId = this.subscribe(replyTopic, (msg) => {
                if (msg.correlationId !== correlationId)
                    return;
                const pending = this.pendingRpc.get(correlationId);
                pending?.resolve(msg.payload);
                if (pending)
                    clearTimeout(pending.timeout);
                this.pendingRpc.delete(correlationId);
                this.unsubscribe(replySubId);
            });
            this.publish(topic, payload, { correlationId, replyTo: replyTopic });
        });
    }
    // Handler utility for RPC responders
    createRpcHandler(topic, handler, plugin) {
        return this.subscribe(topic, async (msg) => {
            if (!msg.replyTo || !msg.correlationId)
                return;
            try {
                const result = await handler(msg.payload);
                await this.publish(msg.replyTo, result, { correlationId: msg.correlationId });
            }
            catch (e) {
                await this.publish(msg.replyTo, { error: e.message || 'RPC_ERROR' }, { correlationId: msg.correlationId });
            }
        }, plugin);
    }
}
export const messageBus = new MessageBus();
//# sourceMappingURL=message-bus.js.map