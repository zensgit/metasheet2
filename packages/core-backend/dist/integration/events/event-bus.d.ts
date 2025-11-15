export declare class EventBus {
    private emitter;
    private listeners;
    private dispatch;
    subscribe(pattern: string | RegExp, handler: (payload: any) => any, plugin?: string): string;
    emit(type: string, payload?: any): void;
    publish(type: string, payload?: any): void;
    unsubscribe(id: string): boolean;
    unsubscribeByPlugin(plugin: string): number;
    subscribeForPlugin(pattern: string | RegExp, handler: (payload: any) => any, plugin: string): string;
}
export declare const eventBus: EventBus;
//# sourceMappingURL=event-bus.d.ts.map