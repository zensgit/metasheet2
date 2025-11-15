/**
 * BPMN Workflow Engine
 * Core engine for executing BPMN 2.0 compliant workflows
 */
import { EventEmitter } from 'events';
export interface ProcessDefinition {
    id?: string;
    key: string;
    name: string;
    description?: string;
    version?: number;
    bpmnXml: string;
    category?: string;
    tenantId?: string;
    isExecutable?: boolean;
}
export interface ProcessInstance {
    id: string;
    processDefinitionId: string;
    processDefinitionKey: string;
    businessKey?: string;
    name?: string;
    state: 'ACTIVE' | 'SUSPENDED' | 'COMPLETED' | 'EXTERNALLY_TERMINATED' | 'INTERNALLY_TERMINATED';
    variables: Record<string, any>;
    startTime: Date;
    endTime?: Date;
    startUserId?: string;
}
export interface UserTask {
    id: string;
    processInstanceId: string;
    name: string;
    description?: string;
    assignee?: string;
    candidateUsers?: string[];
    candidateGroups?: string[];
    priority?: number;
    dueDate?: Date;
    formKey?: string;
    formData?: any;
    state: 'CREATED' | 'READY' | 'RESERVED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'SUSPENDED';
    variables?: Record<string, any>;
}
export interface ActivityDefinition {
    id: string;
    name?: string;
    type: string;
    incoming?: string[];
    outgoing?: string[];
    properties?: Record<string, any>;
}
export interface TimerDefinition {
    type: 'duration' | 'date' | 'cycle';
    value: string;
    activityId: string;
}
export declare class BPMNWorkflowEngine extends EventEmitter {
    private logger;
    private processDefinitions;
    private runningInstances;
    private timerJobs;
    private messageSubscriptions;
    private signalSubscriptions;
    constructor();
    /**
     * Initialize the workflow engine
     */
    initialize(): Promise<void>;
    /**
     * Deploy a new process definition
     */
    deployProcess(definition: ProcessDefinition): Promise<string>;
    /**
     * Start a new process instance
     */
    startProcess(processKey: string, variables?: Record<string, any>, businessKey?: string, tenantId?: string): Promise<string>;
    /**
     * Execute activities in a process
     */
    executeActivity(instanceId: string, activityId: string, activityDef: ActivityDefinition): Promise<void>;
    /**
     * Create a user task
     */
    private createUserTask;
    /**
     * Complete a user task
     */
    completeUserTask(taskId: string, variables?: Record<string, any>, userId?: string): Promise<void>;
    /**
     * Execute a service task
     */
    private executeServiceTask;
    /**
     * Execute an HTTP task
     */
    private executeHttpTask;
    /**
     * Execute a script task
     */
    private executeScriptTask;
    /**
     * Evaluate gateway conditions
     */
    private evaluateGateway;
    /**
     * Execute parallel gateway
     */
    private executeParallelGateway;
    /**
     * Complete an activity
     */
    private completeActivity;
    /**
     * Complete a process instance
     */
    private completeProcess;
    /**
     * Send a message event
     */
    sendMessage(messageName: string, correlationKey?: string, variables?: Record<string, any>): Promise<void>;
    /**
     * Broadcast a signal event
     */
    broadcastSignal(signalName: string, variables?: Record<string, any>): Promise<void>;
    private findActivity;
    private takeSequenceFlow;
    private getSequenceFlow;
    private evaluateCondition;
    private evaluateExpression;
    private resolveExpression;
    private updateProcessVariables;
    private handleActivityError;
    private createExternalTask;
    private handleIntermediateEvent;
    private createTimerJob;
    private parseDuration;
    private scheduleRecurringTimer;
    private fireTimer;
    private cleanupInstanceTimers;
    private startTimerProcessor;
    private processTimerJob;
    private deliverMessage;
    private deliverSignal;
    /**
     * Initialize metrics collection
     * Note: Metrics module doesn't currently expose Gauge/Counter/Histogram constructors
     * This would need integration with prom-client if custom metrics are required
     */
    private initializeMetrics;
    /**
     * Start health check interval
     */
    private startHealthCheck;
    /**
     * Load process definitions from database
     */
    private loadProcessDefinitions;
    /**
     * Resume active instances on startup
     */
    private resumeActiveInstances;
    /**
     * Parse BPMN XML definition
     */
    private parseBPMN;
    /**
     * Register event subscriptions for process definition
     */
    private registerEventSubscriptions;
    /**
     * Find elements by type in BPMN definition
     */
    private findElementsByType;
    /**
     * Get latest version of process definition
     */
    private getLatestVersion;
    /**
     * Get process definition
     */
    private getProcessDefinition;
    /**
     * Execute start events
     */
    private executeStartEvents;
    /**
     * Continue process execution from specific activity
     */
    private continueProcess;
    /**
     * Enhanced incident handling with classification
     */
    private createIncident;
    /**
     * Shutdown the engine
     */
    shutdown(): Promise<void>;
}
export default BPMNWorkflowEngine;
//# sourceMappingURL=BPMNWorkflowEngine.d.ts.map