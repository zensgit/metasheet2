/**
 * Example Event Bus Plugin
 * 事件总线插件示例
 *
 * This plugin demonstrates how to use the Event Bus System for inter-plugin communication.
 * 此插件演示如何使用事件总线系统进行插件间通信。
 */
import { PluginLifecycle, PluginContext, PluginManifest } from '../types/plugin';
export declare class EventExamplePlugin implements PluginLifecycle {
    manifest: PluginManifest;
    status: 'loading' | 'active' | 'error';
    private context?;
    private subscriptions;
    activate(context: PluginContext): Promise<void>;
    private registerEventHandlers;
    private registerRoutes;
    private setupPeriodicEvents;
    private handleSpreadsheetCreated;
    private triggerCalculation;
    private trackWorkflowExecution;
    private prepareForMaintenance;
    private emitUsageStatistics;
    private getEventStatistics;
    destroy(): Promise<void>;
    /**
     * Event aggregation pattern
     * 聚合多个事件并在满足条件时触发
     */
    private setupEventAggregation;
    /**
     * Event chaining pattern
     * 事件链式处理
     */
    private setupEventChaining;
    /**
     * Event filtering pattern
     * 事件过滤模式
     */
    private setupEventFiltering;
}
export default function createPlugin(): PluginLifecycle;
//# sourceMappingURL=event-example-plugin.d.ts.map