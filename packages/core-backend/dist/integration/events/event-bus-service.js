/**
 * EventBusService Singleton
 * 事件总线服务单例
 */
import { EventBusService } from '../../core/EventBusService';
let eventBusServiceInstance = null;
/**
 * Initialize the EventBusService singleton
 */
export function initializeEventBusService(coreAPI) {
    if (!eventBusServiceInstance) {
        eventBusServiceInstance = new EventBusService();
    }
    return eventBusServiceInstance.initialize(coreAPI);
}
/**
 * Get the EventBusService singleton instance
 */
export async function getEventBus() {
    if (!eventBusServiceInstance) {
        throw new Error('EventBusService not initialized. Call initializeEventBusService first.');
    }
    return eventBusServiceInstance;
}
/**
 * Get the EventBusService instance directly (without async)
 */
export function getEventBusSync() {
    if (!eventBusServiceInstance) {
        throw new Error('EventBusService not initialized. Call initializeEventBusService first.');
    }
    return eventBusServiceInstance;
}
//# sourceMappingURL=event-bus-service.js.map