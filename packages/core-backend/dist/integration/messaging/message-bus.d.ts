export type MessagePriority = 'low' | 'normal' | 'high';
interface PublishOptions {
    priority?: MessagePriority;
    correlationId?: string;
    replyTo?: string;
    maxRetries?: number;
    timeoutMs?: number;
    expiryMs?: number;
    expiresAt?: number;
}
interface InternalMessage {
    id: string;
    topic: string;
    payload: any;
    priority: MessagePriority;
    attempts: number;
    maxRetries: number;
    correlationId?: string;
    replyTo?: string;
    source?: string;
    createdAt: number;
    expiresAt?: number;
}
type Handler = (msg: InternalMessage) => Promise<any> | any;
declare class MessageBus {
    private subs;
    private patternSubs;
    private queue;
    private processing;
    private pendingRpc;
    private defaultRetries;
    subscribe(topic: string, handler: Handler, plugin?: string): string;
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
    subscribePattern(pattern: string, handler: Handler, plugin?: string): string;
    unsubscribe(subId: string): boolean;
    unsubscribeByPlugin(plugin: string): number;
    /** Track subscriptions by plugin name for lifecycle cleanup */
    subscribeWithPlugin(topic: string, handler: Handler, plugin: string): string;
    publish(topic: string, payload: any, opts?: PublishOptions): Promise<string>;
    private enqueue;
    private processQueue;
    request(topic: string, payload: any, timeoutMs?: number): Promise<any>;
    createRpcHandler(topic: string, handler: (payload: any) => Promise<any> | any, plugin?: string): string;
}
export declare const messageBus: MessageBus;
export {};
//# sourceMappingURL=message-bus.d.ts.map