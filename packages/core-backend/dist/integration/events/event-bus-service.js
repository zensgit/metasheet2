"use strict";
/**
 * EventBusService Singleton
 * 事件总线服务单例
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeEventBusService = initializeEventBusService;
exports.getEventBus = getEventBus;
exports.getEventBusSync = getEventBusSync;
const EventBusService_1 = require("../../core/EventBusService");
let eventBusServiceInstance = null;
/**
 * Initialize the EventBusService singleton
 */
function initializeEventBusService(coreAPI) {
    if (!eventBusServiceInstance) {
        eventBusServiceInstance = new EventBusService_1.EventBusService();
    }
    return eventBusServiceInstance.initialize(coreAPI);
}
/**
 * Get the EventBusService singleton instance
 */
async function getEventBus() {
    if (!eventBusServiceInstance) {
        throw new Error('EventBusService not initialized. Call initializeEventBusService first.');
    }
    return eventBusServiceInstance;
}
/**
 * Get the EventBusService instance directly (without async)
 */
function getEventBusSync() {
    if (!eventBusServiceInstance) {
        throw new Error('EventBusService not initialized. Call initializeEventBusService first.');
    }
    return eventBusServiceInstance;
}
//# sourceMappingURL=event-bus-service.js.map