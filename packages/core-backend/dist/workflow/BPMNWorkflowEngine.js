/**
 * BPMN Workflow Engine
 * Core engine for executing BPMN 2.0 compliant workflows
 */
import { EventEmitter } from 'events';
import { db } from '../db/db';
import { Logger } from '../core/logger';
import { v4 as uuidv4 } from 'uuid';
import * as xml2js from 'xml2js';
import * as cron from 'node-cron';
export class BPMNWorkflowEngine extends EventEmitter {
    logger;
    processDefinitions;
    runningInstances;
    timerJobs;
    messageSubscriptions;
    signalSubscriptions;
    constructor() {
        super();
        this.logger = new Logger('BPMNWorkflowEngine');
        this.processDefinitions = new Map();
        this.runningInstances = new Map();
        this.timerJobs = new Map();
        this.messageSubscriptions = new Map();
        this.signalSubscriptions = new Map();
    }
    /**
     * Initialize the workflow engine
     */
    async initialize() {
        this.logger.info('Initializing BPMN Workflow Engine');
        try {
            // Load process definitions
            await this.loadProcessDefinitions();
            // Resume active instances
            await this.resumeActiveInstances();
            // Start timer job processor
            this.startTimerProcessor();
            // Initialize metrics
            this.initializeMetrics();
            // Start health check interval
            this.startHealthCheck();
            this.logger.info('BPMN Workflow Engine initialized successfully');
        }
        catch (error) {
            this.logger.error('Failed to initialize BPMN Workflow Engine:', error);
            throw error;
        }
    }
    /**
     * Deploy a new process definition
     */
    async deployProcess(definition) {
        const definitionId = definition.id || uuidv4();
        try {
            // Parse and validate BPMN XML
            const parsed = await this.parseBPMN(definition.bpmnXml);
            // Extract process information
            const process = parsed.definitions.process[0];
            const processKey = process.$.id || definition.key;
            const processName = process.$.name || definition.name;
            // Get next version number
            const latestVersion = await this.getLatestVersion(processKey, definition.tenantId);
            const version = latestVersion + 1;
            // Store definition
            await db
                .insertInto('bpmn_process_definitions')
                .values({
                id: definitionId,
                key: processKey,
                name: processName,
                description: definition.description,
                version,
                bpmn_xml: definition.bpmnXml,
                diagram_json: JSON.stringify(parsed),
                category: definition.category,
                tenant_id: definition.tenantId,
                is_executable: definition.isExecutable !== false,
                created_by: 'system'
            })
                .execute();
            // Cache the definition
            this.processDefinitions.set(definitionId, parsed);
            // Register event subscriptions
            this.registerEventSubscriptions(definitionId, parsed);
            this.emit('process:deployed', { definitionId, key: processKey, version });
            this.logger.info(`Deployed process: ${processKey} v${version}`);
            return definitionId;
        }
        catch (error) {
            this.logger.error(`Failed to deploy process: ${error}`);
            throw error;
        }
    }
    /**
     * Start a new process instance
     */
    async startProcess(processKey, variables = {}, businessKey, tenantId) {
        const instanceId = uuidv4();
        try {
            // Get latest process definition
            const definition = await this.getProcessDefinition(processKey, tenantId);
            if (!definition) {
                throw new Error(`Process definition not found: ${processKey}`);
            }
            // Create process instance
            await db
                .insertInto('bpmn_process_instances')
                .values({
                id: instanceId,
                process_definition_id: definition.id,
                process_definition_key: processKey,
                business_key: businessKey,
                name: definition.name,
                state: 'ACTIVE',
                variables: JSON.stringify(variables),
                start_user_id: variables._startUserId || 'system',
                tenant_id: tenantId
            })
                .execute();
            // Create the process instance object
            const instance = {
                id: instanceId,
                processDefinitionId: definition.id,
                processDefinitionKey: processKey,
                businessKey,
                name: definition.name,
                state: 'ACTIVE',
                variables,
                startTime: new Date(),
                startUserId: variables._startUserId
            };
            // Cache the instance
            this.runningInstances.set(instanceId, instance);
            // Parse definition
            const parsed = this.processDefinitions.get(definition.id) || await this.parseBPMN(definition.bpmn_xml);
            // Execute start events
            await this.executeStartEvents(instanceId, parsed);
            this.emit('process:started', { instanceId, processKey, businessKey });
            this.logger.info(`Started process instance: ${instanceId}`);
            return instanceId;
        }
        catch (error) {
            this.logger.error(`Failed to start process: ${error}`);
            throw error;
        }
    }
    /**
     * Execute activities in a process
     */
    async executeActivity(instanceId, activityId, activityDef) {
        const activityInstanceId = uuidv4();
        try {
            // Record activity start
            await db
                .insertInto('bpmn_activity_instances')
                .values({
                id: activityInstanceId,
                process_instance_id: instanceId,
                process_definition_id: this.runningInstances.get(instanceId)?.processDefinitionId,
                activity_id: activityId,
                activity_name: activityDef.name,
                activity_type: activityDef.type,
                state: 'ACTIVE'
            })
                .execute();
            // Execute based on activity type
            switch (activityDef.type) {
                case 'userTask':
                    await this.createUserTask(instanceId, activityInstanceId, activityDef);
                    break;
                case 'serviceTask':
                    await this.executeServiceTask(instanceId, activityDef);
                    await this.completeActivity(instanceId, activityInstanceId, activityDef);
                    break;
                case 'scriptTask':
                    await this.executeScriptTask(instanceId, activityDef);
                    await this.completeActivity(instanceId, activityInstanceId, activityDef);
                    break;
                case 'exclusiveGateway':
                    await this.evaluateGateway(instanceId, activityDef);
                    await this.completeActivity(instanceId, activityInstanceId, activityDef);
                    break;
                case 'parallelGateway':
                    await this.executeParallelGateway(instanceId, activityDef);
                    await this.completeActivity(instanceId, activityInstanceId, activityDef);
                    break;
                case 'intermediateCatchEvent':
                    await this.handleIntermediateEvent(instanceId, activityDef);
                    break;
                case 'endEvent':
                    await this.completeActivity(instanceId, activityInstanceId, activityDef);
                    await this.completeProcess(instanceId);
                    break;
                default:
                    // Default execution
                    await this.completeActivity(instanceId, activityInstanceId, activityDef);
                    break;
            }
            this.emit('activity:executed', { instanceId, activityId, type: activityDef.type });
        }
        catch (error) {
            await this.handleActivityError(instanceId, activityInstanceId, error);
            throw error;
        }
    }
    /**
     * Create a user task
     */
    async createUserTask(instanceId, activityInstanceId, activityDef) {
        const taskId = uuidv4();
        const instance = this.runningInstances.get(instanceId);
        // Extract task properties
        const props = activityDef.properties || {};
        const assignee = this.resolveExpression(props.assignee, instance?.variables);
        const candidateUsers = this.resolveExpression(props.candidateUsers, instance?.variables);
        const candidateGroups = this.resolveExpression(props.candidateGroups, instance?.variables);
        await db
            .insertInto('bpmn_user_tasks')
            .values({
            id: taskId,
            process_instance_id: instanceId,
            process_definition_id: instance?.processDefinitionId,
            activity_instance_id: activityInstanceId,
            task_definition_key: activityDef.id,
            name: activityDef.name || 'User Task',
            description: props.documentation,
            assignee,
            candidate_users: Array.isArray(candidateUsers) ? candidateUsers : candidateUsers ? [candidateUsers] : [],
            candidate_groups: Array.isArray(candidateGroups) ? candidateGroups : candidateGroups ? [candidateGroups] : [],
            priority: props.priority || 50,
            due_date: props.dueDate ? new Date(props.dueDate) : null,
            form_key: props.formKey,
            state: assignee ? 'RESERVED' : 'READY',
            variables: JSON.stringify(instance?.variables || {})
        })
            .execute();
        this.emit('task:created', { taskId, instanceId, assignee });
        this.logger.info(`Created user task: ${taskId}`);
        return taskId;
    }
    /**
     * Complete a user task
     */
    async completeUserTask(taskId, variables = {}, userId) {
        try {
            // Get task details
            const task = await db
                .selectFrom('bpmn_user_tasks')
                .selectAll()
                .where('id', '=', taskId)
                .executeTakeFirst();
            if (!task) {
                throw new Error(`Task not found: ${taskId}`);
            }
            if (task.state === 'COMPLETED') {
                throw new Error(`Task already completed: ${taskId}`);
            }
            // Update task
            await db
                .updateTable('bpmn_user_tasks')
                .set({
                state: 'COMPLETED',
                completed_at: new Date(),
                variables: JSON.stringify({ ...JSON.parse(task.variables || '{}'), ...variables })
            })
                .where('id', '=', taskId)
                .execute();
            // Update process variables
            await this.updateProcessVariables(task.process_instance_id, variables);
            // Complete the activity
            if (task.activity_instance_id) {
                await db
                    .updateTable('bpmn_activity_instances')
                    .set({
                    state: 'COMPLETED',
                    end_time: new Date()
                })
                    .where('id', '=', task.activity_instance_id)
                    .execute();
                // Continue process execution
                await this.continueProcess(task.process_instance_id, task.task_definition_key);
            }
            this.emit('task:completed', { taskId, userId, variables });
            this.logger.info(`Completed user task: ${taskId}`);
        }
        catch (error) {
            this.logger.error(`Failed to complete user task: ${error}`);
            throw error;
        }
    }
    /**
     * Execute a service task
     */
    async executeServiceTask(instanceId, activityDef) {
        const props = activityDef.properties || {};
        const instance = this.runningInstances.get(instanceId);
        // Execute based on implementation type
        if (props.class) {
            // Java class delegation (not supported, log only)
            this.logger.info(`Service task would execute class: ${props.class}`);
        }
        else if (props.expression) {
            // Expression execution
            const result = this.evaluateExpression(props.expression, instance?.variables);
            if (props.resultVariable) {
                await this.updateProcessVariables(instanceId, { [props.resultVariable]: result });
            }
        }
        else if (props.delegateExpression) {
            // Delegate expression
            this.logger.info(`Service task would execute delegate: ${props.delegateExpression}`);
        }
        else if (props.type === 'http') {
            // HTTP task
            await this.executeHttpTask(instanceId, props);
        }
        else if (props.topic) {
            // External task
            await this.createExternalTask(instanceId, activityDef);
        }
        this.emit('service:executed', { instanceId, activityId: activityDef.id });
    }
    /**
     * Execute an HTTP task
     */
    async executeHttpTask(instanceId, props) {
        const instance = this.runningInstances.get(instanceId);
        const url = this.resolveExpression(props.url, instance?.variables);
        const method = props.method || 'GET';
        const headers = this.resolveExpression(props.headers, instance?.variables) || {};
        const body = this.resolveExpression(props.body, instance?.variables);
        try {
            const response = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...headers
                },
                body: body ? JSON.stringify(body) : undefined
            });
            const responseData = await response.json();
            // Store response if variable specified
            if (props.responseVariable) {
                await this.updateProcessVariables(instanceId, {
                    [props.responseVariable]: responseData
                });
            }
            this.logger.info(`HTTP task completed: ${method} ${url}`);
        }
        catch (error) {
            this.logger.error(`HTTP task failed: ${error}`);
            throw error;
        }
    }
    /**
     * Execute a script task
     */
    async executeScriptTask(instanceId, activityDef) {
        const props = activityDef.properties || {};
        const instance = this.runningInstances.get(instanceId);
        if (props.scriptFormat === 'javascript' && props.script) {
            try {
                // Create safe execution context
                const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
                const fn = new AsyncFunction('variables', 'execution', props.script);
                const execution = {
                    getVariable: (name) => instance?.variables[name],
                    setVariable: async (name, value) => {
                        await this.updateProcessVariables(instanceId, { [name]: value });
                    },
                    getProcessInstanceId: () => instanceId
                };
                await fn(instance?.variables || {}, execution);
                this.logger.info(`Script task executed: ${activityDef.id}`);
            }
            catch (error) {
                this.logger.error(`Script execution failed: ${error}`);
                throw error;
            }
        }
    }
    /**
     * Evaluate gateway conditions
     */
    async evaluateGateway(instanceId, activityDef) {
        const instance = this.runningInstances.get(instanceId);
        const outgoing = activityDef.outgoing || [];
        // Evaluate conditions on outgoing flows
        for (const flowId of outgoing) {
            const flow = await this.getSequenceFlow(flowId);
            if (!flow)
                continue;
            const condition = flow.conditionExpression;
            if (!condition || this.evaluateCondition(condition, instance?.variables)) {
                // Take this path
                await this.takeSequenceFlow(instanceId, flowId);
                break; // Exclusive gateway takes only one path
            }
        }
    }
    /**
     * Execute parallel gateway
     */
    async executeParallelGateway(instanceId, activityDef) {
        const outgoing = activityDef.outgoing || [];
        // Create parallel executions for all outgoing flows
        for (const flowId of outgoing) {
            await this.takeSequenceFlow(instanceId, flowId);
        }
    }
    /**
     * Complete an activity
     */
    async completeActivity(instanceId, activityInstanceId, activityDef) {
        // Update activity instance
        await db
            .updateTable('bpmn_activity_instances')
            .set({
            state: 'COMPLETED',
            end_time: new Date()
        })
            .where('id', '=', activityInstanceId)
            .execute();
        // Continue with outgoing flows
        const outgoing = activityDef.outgoing || [];
        for (const flowId of outgoing) {
            await this.takeSequenceFlow(instanceId, flowId);
        }
    }
    /**
     * Complete a process instance
     */
    async completeProcess(instanceId) {
        // Update instance state
        await db
            .updateTable('bpmn_process_instances')
            .set({
            state: 'COMPLETED',
            end_time: new Date()
        })
            .where('id', '=', instanceId)
            .execute();
        // Remove from cache
        this.runningInstances.delete(instanceId);
        // Clean up timers
        this.cleanupInstanceTimers(instanceId);
        this.emit('process:completed', { instanceId });
        this.logger.info(`Process completed: ${instanceId}`);
    }
    /**
     * Send a message event
     */
    async sendMessage(messageName, correlationKey, variables) {
        const messageId = uuidv4();
        // Store message
        await db
            .insertInto('bpmn_message_events')
            .values({
            id: messageId,
            message_name: messageName,
            correlation_key: correlationKey,
            payload: variables ? JSON.stringify(variables) : null,
            variables: variables ? JSON.stringify(variables) : null,
            state: 'PENDING'
        })
            .execute();
        // Find subscriptions
        const subscriptions = this.messageSubscriptions.get(messageName);
        if (subscriptions) {
            for (const instanceId of subscriptions) {
                await this.deliverMessage(instanceId, messageName, variables);
            }
        }
        this.emit('message:sent', { messageName, correlationKey });
    }
    /**
     * Broadcast a signal event
     */
    async broadcastSignal(signalName, variables) {
        const signalId = uuidv4();
        // Store signal
        await db
            .insertInto('bpmn_signal_events')
            .values({
            id: signalId,
            signal_name: signalName,
            variables: variables ? JSON.stringify(variables) : null,
            is_broadcast: true,
            state: 'TRIGGERED'
        })
            .execute();
        // Find subscriptions
        const subscriptions = this.signalSubscriptions.get(signalName);
        if (subscriptions) {
            for (const instanceId of subscriptions) {
                await this.deliverSignal(instanceId, signalName, variables);
            }
        }
        this.emit('signal:broadcast', { signalName });
    }
    findActivity(definition, activityId) {
        // Search in process definition for activity
        // Return activity definition
        return null;
    }
    async takeSequenceFlow(instanceId, flowId) {
        // Find target activity and execute it
        // Implementation depends on BPMN structure
    }
    async getSequenceFlow(flowId) {
        // Get sequence flow definition
        return null;
    }
    evaluateCondition(condition, variables) {
        // Evaluate JUEL/SpEL expression
        // For now, simple JavaScript evaluation
        try {
            const fn = new Function('variables', `return ${condition}`);
            return fn(variables || {});
        }
        catch {
            return false;
        }
    }
    evaluateExpression(expression, variables) {
        if (!expression)
            return null;
        // Handle ${variable} syntax
        const processed = expression.replace(/\$\{([^}]+)\}/g, (_, key) => {
            return variables?.[key] || '';
        });
        return processed;
    }
    resolveExpression(expression, variables) {
        if (typeof expression === 'string') {
            return this.evaluateExpression(expression, variables);
        }
        return expression;
    }
    async updateProcessVariables(instanceId, variables) {
        const instance = this.runningInstances.get(instanceId);
        if (instance) {
            instance.variables = { ...instance.variables, ...variables };
        }
        // Update in database
        await db
            .updateTable('bpmn_process_instances')
            .set({
            variables: JSON.stringify({ ...(instance?.variables || {}), ...variables })
        })
            .where('id', '=', instanceId)
            .execute();
        // Store individual variables
        for (const [name, value] of Object.entries(variables)) {
            await db
                .insertInto('bpmn_variables')
                .values({
                id: uuidv4(),
                name,
                type: typeof value,
                value: typeof value === 'object' ? null : String(value),
                json_value: typeof value === 'object' ? JSON.stringify(value) : null,
                process_instance_id: instanceId
            })
                .onConflict((oc) => oc.columns(['name', 'process_instance_id', 'execution_id', 'task_id'])
                .doUpdateSet({
                value: typeof value === 'object' ? null : String(value),
                json_value: typeof value === 'object' ? JSON.stringify(value) : null
            }))
                .execute();
        }
    }
    async handleActivityError(instanceId, activityInstanceId, error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Update activity with error
        await db
            .updateTable('bpmn_activity_instances')
            .set({
            state: 'FAILED',
            incident_message: errorMessage
        })
            .where('id', '=', activityInstanceId)
            .execute();
        // Create incident
        await db
            .insertInto('bpmn_incidents')
            .values({
            id: uuidv4(),
            incident_type: 'unhandledError',
            incident_message: errorMessage,
            process_instance_id: instanceId,
            activity_id: activityInstanceId,
            error_message: errorMessage,
            state: 'OPEN'
        })
            .execute();
        this.emit('activity:error', { instanceId, activityInstanceId, error: errorMessage });
    }
    async createExternalTask(instanceId, activityDef) {
        const props = activityDef.properties || {};
        const instance = this.runningInstances.get(instanceId);
        await db
            .insertInto('bpmn_external_tasks')
            .values({
            id: uuidv4(),
            topic_name: props.topic,
            process_instance_id: instanceId,
            process_definition_id: instance?.processDefinitionId,
            activity_id: activityDef.id,
            priority: props.priority || 0,
            variables: JSON.stringify(instance?.variables || {})
        })
            .execute();
    }
    async handleIntermediateEvent(instanceId, activityDef) {
        const props = activityDef.properties || {};
        if (props.messageRef) {
            // Subscribe to message
            const subscriptions = this.messageSubscriptions.get(props.messageRef) || new Set();
            subscriptions.add(instanceId);
            this.messageSubscriptions.set(props.messageRef, subscriptions);
        }
        if (props.signalRef) {
            // Subscribe to signal
            const subscriptions = this.signalSubscriptions.get(props.signalRef) || new Set();
            subscriptions.add(instanceId);
            this.signalSubscriptions.set(props.signalRef, subscriptions);
        }
        if (props.timerDefinition) {
            // Create timer job
            await this.createTimerJob(instanceId, activityDef.id, props.timerDefinition);
        }
    }
    async createTimerJob(instanceId, activityId, timerDef) {
        const instance = this.runningInstances.get(instanceId);
        let dueTime;
        switch (timerDef.type) {
            case 'date':
                dueTime = new Date(timerDef.value);
                break;
            case 'duration':
                // Parse ISO 8601 duration
                dueTime = this.parseDuration(timerDef.value);
                break;
            case 'cycle':
                // Create recurring job
                this.scheduleRecurringTimer(instanceId, activityId, timerDef.value);
                return;
            default:
                return;
        }
        await db
            .insertInto('bpmn_timer_jobs')
            .values({
            id: uuidv4(),
            process_instance_id: instanceId,
            process_definition_id: instance?.processDefinitionId,
            activity_id: activityId,
            job_type: 'timer',
            timer_type: timerDef.type,
            timer_value: timerDef.value,
            due_time: dueTime,
            state: 'WAITING'
        })
            .execute();
    }
    parseDuration(duration) {
        // Simple ISO 8601 duration parser
        const now = new Date();
        const match = duration.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
        if (match) {
            const days = parseInt(match[1] || '0');
            const hours = parseInt(match[2] || '0');
            const minutes = parseInt(match[3] || '0');
            const seconds = parseInt(match[4] || '0');
            now.setDate(now.getDate() + days);
            now.setHours(now.getHours() + hours);
            now.setMinutes(now.getMinutes() + minutes);
            now.setSeconds(now.getSeconds() + seconds);
        }
        return now;
    }
    scheduleRecurringTimer(instanceId, activityId, cronExpression) {
        const job = cron.schedule(cronExpression, async () => {
            await this.fireTimer(instanceId, activityId);
        });
        const jobId = `${instanceId}-${activityId}`;
        this.timerJobs.set(jobId, job);
        job.start();
    }
    async fireTimer(instanceId, activityId) {
        // Continue process from timer activity
        await this.continueProcess(instanceId, activityId);
    }
    cleanupInstanceTimers(instanceId) {
        // Remove all timers for instance
        for (const [key, job] of this.timerJobs.entries()) {
            if (key.startsWith(instanceId)) {
                job.stop();
                this.timerJobs.delete(key);
            }
        }
    }
    startTimerProcessor() {
        // Process due timer jobs every minute
        cron.schedule('* * * * *', async () => {
            const dueJobs = await db
                .selectFrom('bpmn_timer_jobs')
                .selectAll()
                .where('state', '=', 'WAITING')
                .where('due_time', '<=', new Date())
                .execute();
            for (const job of dueJobs) {
                await this.processTimerJob(job);
            }
        });
    }
    async processTimerJob(job) {
        try {
            // Lock job
            await db
                .updateTable('bpmn_timer_jobs')
                .set({
                state: 'LOCKED',
                lock_owner: 'engine',
                lock_expiry_time: new Date(Date.now() + 60000)
            })
                .where('id', '=', job.id)
                .execute();
            // Fire timer
            await this.fireTimer(job.process_instance_id, job.activity_id);
            // Complete job
            await db
                .updateTable('bpmn_timer_jobs')
                .set({ state: 'COMPLETED' })
                .where('id', '=', job.id)
                .execute();
        }
        catch (error) {
            await db
                .updateTable('bpmn_timer_jobs')
                .set({
                state: 'FAILED',
                retries: job.retries - 1,
                exception_message: error instanceof Error ? error.message : String(error)
            })
                .where('id', '=', job.id)
                .execute();
        }
    }
    async deliverMessage(instanceId, messageName, variables) {
        // Update process variables
        if (variables) {
            await this.updateProcessVariables(instanceId, variables);
        }
        // Continue process execution
        // Find waiting message catch event and continue
    }
    async deliverSignal(instanceId, signalName, variables) {
        // Update process variables
        if (variables) {
            await this.updateProcessVariables(instanceId, variables);
        }
        // Continue process execution
        // Find waiting signal catch event and continue
    }
    /**
     * Initialize metrics collection
     * Note: Metrics module doesn't currently expose Gauge/Counter/Histogram constructors
     * This would need integration with prom-client if custom metrics are required
     */
    initializeMetrics() {
        // TODO: Implement custom BPMN metrics if prom-client is exposed from metrics module
        // For now, rely on existing metrics in ../metrics/metrics.ts
    }
    /**
     * Start health check interval
     */
    startHealthCheck() {
        setInterval(async () => {
            try {
                // Update metrics
                const activeCount = await db
                    .selectFrom('bpmn_process_instances')
                    .select('id')
                    .where('state', '=', 'ACTIVE')
                    .execute();
                if (this.workflowMetrics) {
                    ;
                    this.workflowMetrics.processInstancesActive.set(activeCount.length);
                }
                // Check for stuck instances (active for more than 24 hours)
                const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                const stuckInstances = await db
                    .selectFrom('bpmn_process_instances')
                    .selectAll()
                    .where('state', '=', 'ACTIVE')
                    .where('start_time', '<', cutoffTime)
                    .execute();
                if (stuckInstances.length > 0) {
                    this.logger.warn(`Found ${stuckInstances.length} potentially stuck process instances`);
                }
            }
            catch (error) {
                this.logger.error('Health check failed:', error);
            }
        }, 60000); // Every minute
    }
    /**
     * Load process definitions from database
     */
    async loadProcessDefinitions() {
        try {
            const definitions = await db
                .selectFrom('bpmn_process_definitions')
                .selectAll()
                .where('is_executable', '=', true)
                .execute();
            for (const definition of definitions) {
                try {
                    const parsed = await this.parseBPMN(definition.bpmn_xml);
                    this.processDefinitions.set(definition.id, parsed);
                    this.registerEventSubscriptions(definition.id, parsed);
                }
                catch (error) {
                    this.logger.error(`Failed to load process definition ${definition.key}:`, error);
                }
            }
            this.logger.info(`Loaded ${this.processDefinitions.size} process definitions`);
        }
        catch (error) {
            this.logger.error('Failed to load process definitions:', error);
            throw error;
        }
    }
    /**
     * Resume active instances on startup
     */
    async resumeActiveInstances() {
        try {
            const activeInstances = await db
                .selectFrom('bpmn_process_instances')
                .selectAll()
                .where('state', '=', 'ACTIVE')
                .execute();
            for (const instance of activeInstances) {
                const processInstance = {
                    id: instance.id,
                    processDefinitionId: instance.process_definition_id,
                    processDefinitionKey: instance.process_definition_key,
                    businessKey: instance.business_key || undefined,
                    name: instance.name || undefined,
                    state: instance.state,
                    variables: instance.variables ? JSON.parse(instance.variables) : {},
                    startTime: new Date(instance.start_time),
                    endTime: instance.end_time ? new Date(instance.end_time) : undefined,
                    startUserId: instance.start_user_id || undefined
                };
                this.runningInstances.set(instance.id, processInstance);
            }
            this.logger.info(`Resumed ${activeInstances.length} active process instances`);
        }
        catch (error) {
            this.logger.error('Failed to resume active instances:', error);
            throw error;
        }
    }
    /**
     * Parse BPMN XML definition
     */
    async parseBPMN(bpmnXml) {
        return new Promise((resolve, reject) => {
            xml2js.parseString(bpmnXml, (err, result) => {
                if (err) {
                    reject(new Error(`Invalid BPMN XML: ${err.message}`));
                }
                else {
                    resolve(result);
                }
            });
        });
    }
    /**
     * Register event subscriptions for process definition
     */
    registerEventSubscriptions(definitionId, parsed) {
        try {
            const process = parsed.definitions?.process?.[0];
            if (!process)
                return;
            // Register message events
            const messageEvents = this.findElementsByType(process, 'bpmn:intermediateCatchEvent')
                .filter((event) => event['bpmn:messageEventDefinition']);
            messageEvents.forEach((event) => {
                const messageRef = event['bpmn:messageEventDefinition']?.[0]?.['$']?.messageRef;
                if (messageRef) {
                    const subscriptions = this.messageSubscriptions.get(messageRef) || new Set();
                    subscriptions.add(definitionId);
                    this.messageSubscriptions.set(messageRef, subscriptions);
                }
            });
            // Register signal events
            const signalEvents = this.findElementsByType(process, 'bpmn:intermediateCatchEvent')
                .filter((event) => event['bpmn:signalEventDefinition']);
            signalEvents.forEach((event) => {
                const signalRef = event['bpmn:signalEventDefinition']?.[0]?.['$']?.signalRef;
                if (signalRef) {
                    const subscriptions = this.signalSubscriptions.get(signalRef) || new Set();
                    subscriptions.add(definitionId);
                    this.signalSubscriptions.set(signalRef, subscriptions);
                }
            });
        }
        catch (error) {
            this.logger.error(`Failed to register event subscriptions for ${definitionId}:`, error);
        }
    }
    /**
     * Find elements by type in BPMN definition
     */
    findElementsByType(parent, type) {
        const elements = [];
        const search = (obj) => {
            if (obj && typeof obj === 'object') {
                if (obj[type]) {
                    elements.push(...obj[type]);
                }
                Object.values(obj).forEach(search);
            }
        };
        search(parent);
        return elements;
    }
    /**
     * Get latest version of process definition
     */
    async getLatestVersion(key, tenantId) {
        const result = await db
            .selectFrom('bpmn_process_definitions')
            .select('version')
            .where('key', '=', key)
            .where('tenant_id', '=', tenantId || null)
            .orderBy('version', 'desc')
            .limit(1)
            .executeTakeFirst();
        return result?.version || 0;
    }
    /**
     * Get process definition
     */
    async getProcessDefinition(key, tenantId) {
        return await db
            .selectFrom('bpmn_process_definitions')
            .selectAll()
            .where('key', '=', key)
            .where('tenant_id', '=', tenantId || null)
            .where('is_executable', '=', true)
            .orderBy('version', 'desc')
            .limit(1)
            .executeTakeFirst();
    }
    /**
     * Execute start events
     */
    async executeStartEvents(instanceId, parsed) {
        const process = parsed.definitions?.process?.[0];
        if (!process)
            return;
        const startEvents = this.findElementsByType(process, 'bpmn:startEvent');
        for (const startEvent of startEvents) {
            const activityId = startEvent.$.id;
            const outgoing = startEvent['bpmn:outgoing'];
            // Record start event execution
            const activityInstanceId = uuidv4();
            await db
                .insertInto('bpmn_activity_instances')
                .values({
                id: activityInstanceId,
                process_instance_id: instanceId,
                process_definition_id: this.runningInstances.get(instanceId)?.processDefinitionId,
                activity_id: activityId,
                activity_name: startEvent.$.name || 'Start Event',
                activity_type: 'startEvent',
                state: 'COMPLETED',
                end_time: new Date()
            })
                .execute();
            // Follow outgoing sequence flows
            if (outgoing) {
                for (const flowId of outgoing) {
                    await this.takeSequenceFlow(instanceId, flowId);
                }
            }
        }
    }
    /**
     * Continue process execution from specific activity
     */
    async continueProcess(instanceId, activityId) {
        const instance = this.runningInstances.get(instanceId);
        if (!instance)
            return;
        const definition = this.processDefinitions.get(instance.processDefinitionId);
        if (!definition)
            return;
        // Find activity definition and continue execution
        const activityDef = this.findActivity(definition, activityId);
        if (activityDef) {
            await this.executeActivity(instanceId, activityId, activityDef);
        }
    }
    /**
     * Enhanced incident handling with classification
     */
    async createIncident(type, instanceId, activityId, error, context) {
        const incidentId = uuidv4();
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Map timeoutError to unhandledError since DB doesn't have timeoutError type
        const dbIncidentType = type === 'timeoutError' ? 'unhandledError' : type;
        await db
            .insertInto('bpmn_incidents')
            .values({
            id: incidentId,
            incident_type: dbIncidentType,
            incident_message: `${type}: ${errorMessage}`,
            process_instance_id: instanceId,
            process_definition_id: this.runningInstances.get(instanceId)?.processDefinitionId,
            activity_id: activityId,
            error_message: errorMessage,
            stack_trace: error instanceof Error ? error.stack : undefined,
            state: 'OPEN'
        })
            .execute();
        // Update metrics
        if (this.workflowMetrics) {
            ;
            this.workflowMetrics.incidentsCreated.inc();
        }
        this.emit('incident:created', { incidentId, type, instanceId, activityId, error });
        this.logger.error(`Incident created: ${type} in process ${instanceId}`, error);
    }
    /**
     * Shutdown the engine
     */
    async shutdown() {
        this.logger.info('Shutting down BPMN Workflow Engine');
        // Stop all timer jobs
        for (const job of this.timerJobs.values()) {
            job.stop();
        }
        // Clear caches
        this.processDefinitions.clear();
        this.runningInstances.clear();
        this.messageSubscriptions.clear();
        this.signalSubscriptions.clear();
        this.logger.info('BPMN Workflow Engine shutdown complete');
    }
}
export default BPMNWorkflowEngine;
//# sourceMappingURL=BPMNWorkflowEngine.js.map