// @ts-nocheck
/**
 * BPMN Workflow Engine
 * Core engine for executing BPMN 2.0 compliant workflows
 */

import { EventEmitter } from 'events'
import { db } from '../db/db'
import { Logger } from '../core/logger'
import { v4 as uuidv4 } from 'uuid'
import * as xml2js from 'xml2js'
import * as cron from 'node-cron'
import { metrics } from '../metrics/metrics'

export interface ProcessDefinition {
  id?: string
  key: string
  name: string
  description?: string
  version?: number
  bpmnXml: string
  category?: string
  tenantId?: string
  isExecutable?: boolean
}

export interface ProcessInstance {
  id: string
  processDefinitionId: string
  processDefinitionKey: string
  businessKey?: string
  name?: string
  state: 'ACTIVE' | 'SUSPENDED' | 'COMPLETED' | 'EXTERNALLY_TERMINATED' | 'INTERNALLY_TERMINATED'
  variables: Record<string, any>
  startTime: Date
  endTime?: Date
  startUserId?: string
}

export interface UserTask {
  id: string
  processInstanceId: string
  name: string
  description?: string
  assignee?: string
  candidateUsers?: string[]
  candidateGroups?: string[]
  priority?: number
  dueDate?: Date
  formKey?: string
  formData?: any
  state: 'CREATED' | 'READY' | 'RESERVED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'SUSPENDED'
  variables?: Record<string, any>
}

export interface ActivityDefinition {
  id: string
  name?: string
  type: string // userTask, serviceTask, scriptTask, etc.
  incoming?: string[]
  outgoing?: string[]
  properties?: Record<string, any>
}

export interface TimerDefinition {
  type: 'duration' | 'date' | 'cycle'
  value: string
  activityId: string
}

export class BPMNWorkflowEngine extends EventEmitter {
  private logger: Logger
  private processDefinitions: Map<string, any>
  private runningInstances: Map<string, ProcessInstance>
  private timerJobs: Map<string, cron.ScheduledTask>
  private messageSubscriptions: Map<string, Set<string>>
  private signalSubscriptions: Map<string, Set<string>>

  constructor() {
    super()
    this.logger = new Logger('BPMNWorkflowEngine')
    this.processDefinitions = new Map()
    this.runningInstances = new Map()
    this.timerJobs = new Map()
    this.messageSubscriptions = new Map()
    this.signalSubscriptions = new Map()
  }

  /**
   * Initialize the workflow engine
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing BPMN Workflow Engine')

    try {
      // Load process definitions
      await this.loadProcessDefinitions()

      // Resume active instances
      await this.resumeActiveInstances()

      // Start timer job processor
      this.startTimerProcessor()

      // Initialize metrics
      this.initializeMetrics()

      // Start health check interval
      this.startHealthCheck()

      this.logger.info('BPMN Workflow Engine initialized successfully')
    } catch (error) {
      this.logger.error('Failed to initialize BPMN Workflow Engine:', error)
      throw error
    }
  }

  /**
   * Deploy a new process definition
   */
  async deployProcess(definition: ProcessDefinition): Promise<string> {
    const definitionId = definition.id || uuidv4()

    try {
      // Parse and validate BPMN XML
      const parsed = await this.parseBPMN(definition.bpmnXml)
      
      // Extract process information
      const process = parsed.definitions.process[0]
      const processKey = process.$.id || definition.key
      const processName = process.$.name || definition.name

      // Get next version number
      const latestVersion = await this.getLatestVersion(processKey, definition.tenantId)
      const version = latestVersion + 1

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
        .execute()

      // Cache the definition
      this.processDefinitions.set(definitionId, parsed)

      // Register event subscriptions
      this.registerEventSubscriptions(definitionId, parsed)

      this.emit('process:deployed', { definitionId, key: processKey, version })
      this.logger.info(`Deployed process: ${processKey} v${version}`)

      return definitionId
    } catch (error) {
      this.logger.error(`Failed to deploy process: ${error}`)
      throw error
    }
  }

  /**
   * Start a new process instance
   */
  async startProcess(
    processKey: string,
    variables: Record<string, any> = {},
    businessKey?: string,
    tenantId?: string
  ): Promise<string> {
    const instanceId = uuidv4()

    try {
      // Get latest process definition
      const definition = await this.getProcessDefinition(processKey, tenantId)
      if (!definition) {
        throw new Error(`Process definition not found: ${processKey}`)
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
        .execute()

      // Create the process instance object
      const instance: ProcessInstance = {
        id: instanceId,
        processDefinitionId: definition.id,
        processDefinitionKey: processKey,
        businessKey,
        name: definition.name,
        state: 'ACTIVE',
        variables,
        startTime: new Date(),
        startUserId: variables._startUserId
      }

      // Cache the instance
      this.runningInstances.set(instanceId, instance)

      // Parse definition
      const parsed = this.processDefinitions.get(definition.id) || await this.parseBPMN(definition.bpmn_xml)

      // Execute start events
      await this.executeStartEvents(instanceId, parsed)

      this.emit('process:started', { instanceId, processKey, businessKey })
      this.logger.info(`Started process instance: ${instanceId}`)

      return instanceId
    } catch (error) {
      this.logger.error(`Failed to start process: ${error}`)
      throw error
    }
  }

  /**
   * Execute activities in a process
   */
  async executeActivity(
    instanceId: string,
    activityId: string,
    activityDef: ActivityDefinition
  ): Promise<void> {
    const activityInstanceId = uuidv4()

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
        .execute()

      // Execute based on activity type
      switch (activityDef.type) {
        case 'userTask':
          await this.createUserTask(instanceId, activityInstanceId, activityDef)
          break

        case 'serviceTask':
          await this.executeServiceTask(instanceId, activityDef)
          await this.completeActivity(instanceId, activityInstanceId, activityDef)
          break

        case 'scriptTask':
          await this.executeScriptTask(instanceId, activityDef)
          await this.completeActivity(instanceId, activityInstanceId, activityDef)
          break

        case 'exclusiveGateway':
          await this.evaluateGateway(instanceId, activityDef)
          await this.completeActivity(instanceId, activityInstanceId, activityDef)
          break

        case 'parallelGateway':
          await this.executeParallelGateway(instanceId, activityDef)
          await this.completeActivity(instanceId, activityInstanceId, activityDef)
          break

        case 'intermediateCatchEvent':
          await this.handleIntermediateEvent(instanceId, activityDef)
          break

        case 'endEvent':
          await this.completeActivity(instanceId, activityInstanceId, activityDef)
          await this.completeProcess(instanceId)
          break

        default:
          // Default execution
          await this.completeActivity(instanceId, activityInstanceId, activityDef)
          break
      }

      this.emit('activity:executed', { instanceId, activityId, type: activityDef.type })
    } catch (error) {
      await this.handleActivityError(instanceId, activityInstanceId, error)
      throw error
    }
  }

  /**
   * Create a user task
   */
  private async createUserTask(
    instanceId: string,
    activityInstanceId: string,
    activityDef: ActivityDefinition
  ): Promise<string> {
    const taskId = uuidv4()
    const instance = this.runningInstances.get(instanceId)

    // Extract task properties
    const props = activityDef.properties || {}
    const assignee = this.resolveExpression(props.assignee, instance?.variables)
    const candidateUsers = this.resolveExpression(props.candidateUsers, instance?.variables)
    const candidateGroups = this.resolveExpression(props.candidateGroups, instance?.variables)

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
      .execute()

    this.emit('task:created', { taskId, instanceId, assignee })
    this.logger.info(`Created user task: ${taskId}`)

    return taskId
  }

  /**
   * Complete a user task
   */
  async completeUserTask(
    taskId: string,
    variables: Record<string, any> = {},
    userId?: string
  ): Promise<void> {
    try {
      // Get task details
      const task = await db
        .selectFrom('bpmn_user_tasks')
        .selectAll()
        .where('id', '=', taskId)
        .executeTakeFirst()

      if (!task) {
        throw new Error(`Task not found: ${taskId}`)
      }

      if (task.state === 'COMPLETED') {
        throw new Error(`Task already completed: ${taskId}`)
      }

      // Update task
      await db
        .updateTable('bpmn_user_tasks')
        .set({
          state: 'COMPLETED',
          completed_at: new Date(),
          variables: JSON.stringify({ ...JSON.parse(task.variables as string || '{}'), ...variables })
        })
        .where('id', '=', taskId)
        .execute()

      // Update process variables
      await this.updateProcessVariables(task.process_instance_id, variables)

      // Complete the activity
      if (task.activity_instance_id) {
        await db
          .updateTable('bpmn_activity_instances')
          .set({
            state: 'COMPLETED',
            end_time: new Date()
          })
          .where('id', '=', task.activity_instance_id)
          .execute()

        // Continue process execution
        await this.continueProcess(task.process_instance_id, task.task_definition_key)
      }

      this.emit('task:completed', { taskId, userId, variables })
      this.logger.info(`Completed user task: ${taskId}`)
    } catch (error) {
      this.logger.error(`Failed to complete user task: ${error}`)
      throw error
    }
  }

  /**
   * Execute a service task
   */
  private async executeServiceTask(
    instanceId: string,
    activityDef: ActivityDefinition
  ): Promise<void> {
    const props = activityDef.properties || {}
    const instance = this.runningInstances.get(instanceId)

    // Execute based on implementation type
    if (props.class) {
      // Java class delegation (not supported, log only)
      this.logger.info(`Service task would execute class: ${props.class}`)
    } else if (props.expression) {
      // Expression execution
      const result = this.evaluateExpression(props.expression, instance?.variables)
      if (props.resultVariable) {
        await this.updateProcessVariables(instanceId, { [props.resultVariable]: result })
      }
    } else if (props.delegateExpression) {
      // Delegate expression
      this.logger.info(`Service task would execute delegate: ${props.delegateExpression}`)
    } else if (props.type === 'http') {
      // HTTP task
      await this.executeHttpTask(instanceId, props)
    } else if (props.topic) {
      // External task
      await this.createExternalTask(instanceId, activityDef)
    }

    this.emit('service:executed', { instanceId, activityId: activityDef.id })
  }

  /**
   * Execute an HTTP task
   */
  private async executeHttpTask(
    instanceId: string,
    props: any
  ): Promise<void> {
    const instance = this.runningInstances.get(instanceId)
    const url = this.resolveExpression(props.url, instance?.variables)
    const method = props.method || 'GET'
    const headers = this.resolveExpression(props.headers, instance?.variables) || {}
    const body = this.resolveExpression(props.body, instance?.variables)

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body: body ? JSON.stringify(body) : undefined
      })

      const responseData = await response.json()

      // Store response if variable specified
      if (props.responseVariable) {
        await this.updateProcessVariables(instanceId, {
          [props.responseVariable]: responseData
        })
      }

      this.logger.info(`HTTP task completed: ${method} ${url}`)
    } catch (error) {
      this.logger.error(`HTTP task failed: ${error}`)
      throw error
    }
  }

  /**
   * Execute a script task
   */
  private async executeScriptTask(
    instanceId: string,
    activityDef: ActivityDefinition
  ): Promise<void> {
    const props = activityDef.properties || {}
    const instance = this.runningInstances.get(instanceId)

    if (props.scriptFormat === 'javascript' && props.script) {
      try {
        // SECURITY: Validate script before execution - NO arbitrary code execution
        const script = String(props.script || '').trim()

        // Check for dangerous patterns
        const dangerousPatterns = [
          /\beval\b/i,
          /\bFunction\b/i,
          /\brequire\b/i,
          /\bimport\b/i,
          /\bprocess\b/,
          /\bglobal\b/,
          /\b__proto__\b/,
          /\bconstructor\b/,
          /\bprototype\b/,
          /\bchild_process\b/i,
          /\bfs\b/,
          /\bexec\b/,
          /\bspawn\b/,
        ]

        for (const pattern of dangerousPatterns) {
          if (pattern.test(script)) {
            this.logger.error(`Script rejected: dangerous pattern detected - ${pattern}`)
            throw new Error(`Script contains unsafe pattern: ${pattern}`)
          }
        }

        // Safe script execution using limited sandbox
        const variables = instance?.variables || {}
        const result: Record<string, any> = {}

        // Parse safe operations only:
        // - Variable assignments: result.varName = value
        // - Simple expressions: result.sum = variables.a + variables.b
        const assignmentPattern = /result\.(\w+)\s*=\s*(.+)/g
        let match

        while ((match = assignmentPattern.exec(script)) !== null) {
          const [, varName, expression] = match
          const value = this.safeEvaluateExpression(expression.trim(), variables)
          result[varName] = value
        }

        // Update process variables with results
        if (Object.keys(result).length > 0) {
          await this.updateProcessVariables(instanceId, result)
        }

        this.logger.info(`Script task executed safely: ${activityDef.id}`)
      } catch (error) {
        this.logger.error(`Script execution failed: ${error}`)
        throw error
      }
    }
  }

  /**
   * Safely evaluate simple expressions without code execution
   */
  private safeEvaluateExpression(expression: string, variables: Record<string, any>): any {
    // Replace variable references with actual values
    let result = expression

    // Handle variables.fieldName pattern
    result = result.replace(/variables\.(\w+)/g, (_, field) => {
      const value = variables[field]
      if (typeof value === 'string') return `"${value}"`
      if (value === null || value === undefined) return 'null'
      return String(value)
    })

    // Only allow safe numeric/string operations
    const numericPattern = /^[\d\s+\-*/().]+$/
    if (numericPattern.test(result)) {
      try {
        // Safe arithmetic evaluation
        return this.safeArithmetic(result)
      } catch {
        return null
      }
    }

    // String value
    const stringPattern = /^"([^"]*)"$/
    const stringMatch = result.match(stringPattern)
    if (stringMatch) {
      return stringMatch[1]
    }

    // Boolean
    if (result === 'true') return true
    if (result === 'false') return false
    if (result === 'null') return null

    // Number
    const num = parseFloat(result)
    if (!isNaN(num)) return num

    return result
  }

  /**
   * Safe arithmetic evaluation without eval/Function
   */
  private safeArithmetic(expr: string): number {
    const tokens = expr.match(/[\d.]+|[+\-*/()]/g) || []
    let pos = 0

    const parseNumber = (): number => {
      const num = parseFloat(tokens[pos] || '0')
      pos++
      return num
    }

    const parseFactor = (): number => {
      if (tokens[pos] === '(') {
        pos++
        const result = parseExpression()
        pos++
        return result
      }
      return parseNumber()
    }

    const parseTerm = (): number => {
      let result = parseFactor()
      while (tokens[pos] === '*' || tokens[pos] === '/') {
        const op = tokens[pos]
        pos++
        const right = parseFactor()
        result = op === '*' ? result * right : result / right
      }
      return result
    }

    const parseExpression = (): number => {
      let result = parseTerm()
      while (tokens[pos] === '+' || tokens[pos] === '-') {
        const op = tokens[pos]
        pos++
        const right = parseTerm()
        result = op === '+' ? result + right : result - right
      }
      return result
    }

    return parseExpression()
  }

  /**
   * Evaluate gateway conditions
   */
  private async evaluateGateway(
    instanceId: string,
    activityDef: ActivityDefinition
  ): Promise<void> {
    const instance = this.runningInstances.get(instanceId)
    const outgoing = activityDef.outgoing || []

    // Evaluate conditions on outgoing flows
    for (const flowId of outgoing) {
      const flow = await this.getSequenceFlow(flowId)
      if (!flow) continue

      const condition = flow.conditionExpression
      if (!condition || this.evaluateCondition(condition, instance?.variables)) {
        // Take this path
        await this.takeSequenceFlow(instanceId, flowId)
        break // Exclusive gateway takes only one path
      }
    }
  }

  /**
   * Execute parallel gateway
   */
  private async executeParallelGateway(
    instanceId: string,
    activityDef: ActivityDefinition
  ): Promise<void> {
    const outgoing = activityDef.outgoing || []

    // Create parallel executions for all outgoing flows
    for (const flowId of outgoing) {
      await this.takeSequenceFlow(instanceId, flowId)
    }
  }

  /**
   * Complete an activity
   */
  private async completeActivity(
    instanceId: string,
    activityInstanceId: string,
    activityDef: ActivityDefinition
  ): Promise<void> {
    // Update activity instance
    await db
      .updateTable('bpmn_activity_instances')
      .set({
        state: 'COMPLETED',
        end_time: new Date()
      })
      .where('id', '=', activityInstanceId)
      .execute()

    // Continue with outgoing flows
    const outgoing = activityDef.outgoing || []
    for (const flowId of outgoing) {
      await this.takeSequenceFlow(instanceId, flowId)
    }
  }

  /**
   * Complete a process instance
   */
  private async completeProcess(instanceId: string): Promise<void> {
    // Update instance state
    await db
      .updateTable('bpmn_process_instances')
      .set({
        state: 'COMPLETED',
        end_time: new Date()
      })
      .where('id', '=', instanceId)
      .execute()

    // Remove from cache
    this.runningInstances.delete(instanceId)

    // Clean up timers
    this.cleanupInstanceTimers(instanceId)

    this.emit('process:completed', { instanceId })
    this.logger.info(`Process completed: ${instanceId}`)
  }

  /**
   * Send a message event
   */
  async sendMessage(
    messageName: string,
    correlationKey?: string,
    variables?: Record<string, any>
  ): Promise<void> {
    const messageId = uuidv4()

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
      .execute()

    // Find subscriptions
    const subscriptions = this.messageSubscriptions.get(messageName)
    if (subscriptions) {
      for (const instanceId of subscriptions) {
        await this.deliverMessage(instanceId, messageName, variables)
      }
    }

    this.emit('message:sent', { messageName, correlationKey })
  }

  /**
   * Broadcast a signal event
   */
  async broadcastSignal(
    signalName: string,
    variables?: Record<string, any>
  ): Promise<void> {
    const signalId = uuidv4()

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
      .execute()

    // Find subscriptions
    const subscriptions = this.signalSubscriptions.get(signalName)
    if (subscriptions) {
      for (const instanceId of subscriptions) {
        await this.deliverSignal(instanceId, signalName, variables)
      }
    }

    this.emit('signal:broadcast', { signalName })
  }

  private findActivity(definition: any, activityId: string): ActivityDefinition | null {
    // Search in process definition for activity
    // Return activity definition
    return null
  }

  private async takeSequenceFlow(instanceId: string, flowId: string): Promise<void> {
    // Find target activity and execute it
    // Implementation depends on BPMN structure
  }

  private async getSequenceFlow(flowId: string): Promise<any> {
    // Get sequence flow definition
    return null
  }

  private evaluateCondition(condition: string, variables?: Record<string, any>): boolean {
    // SECURITY: Safe condition evaluation without Function constructor
    // Supports: comparisons (==, !=, >, <, >=, <=), boolean operators (&&, ||, !)
    try {
      const cond = String(condition || '').trim()
      const vars = variables || {}

      // Check for dangerous patterns
      const dangerousPatterns = [
        /\beval\b/i,
        /\bFunction\b/i,
        /\brequire\b/i,
        /\bimport\b/i,
        /\bprocess\b/,
        /\bglobal\b/,
        /\b__proto__\b/,
        /\bconstructor\b/,
      ]

      for (const pattern of dangerousPatterns) {
        if (pattern.test(cond)) {
          this.logger.warn(`Condition rejected: dangerous pattern - ${pattern}`)
          return false
        }
      }

      // Replace variable references: variables.name or ${name}
      let processed = cond
        .replace(/variables\.(\w+)/g, (_, key) => JSON.stringify(vars[key]))
        .replace(/\$\{(\w+)\}/g, (_, key) => JSON.stringify(vars[key]))

      // Parse simple comparisons: value1 op value2
      const comparisonPattern = /^(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/
      const match = processed.match(comparisonPattern)

      if (match) {
        const [, left, op, right] = match
        const leftVal = this.parseConditionValue(left.trim(), vars)
        const rightVal = this.parseConditionValue(right.trim(), vars)

        switch (op) {
          case '===':
          case '==': return leftVal === rightVal
          case '!==':
          case '!=': return leftVal !== rightVal
          case '>': return leftVal > rightVal
          case '<': return leftVal < rightVal
          case '>=': return leftVal >= rightVal
          case '<=': return leftVal <= rightVal
          default: return false
        }
      }

      // Handle simple truthy check
      const value = this.parseConditionValue(processed, vars)
      return Boolean(value)
    } catch (error) {
      this.logger.error('Condition evaluation error:', error instanceof Error ? error : new Error(String(error)))
      return false
    }
  }

  private parseConditionValue(value: string, variables: Record<string, any>): any {
    const trimmed = value.trim()

    // Boolean literals
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
    if (trimmed === 'null') return null
    if (trimmed === 'undefined') return undefined

    // String literals
    const stringMatch = trimmed.match(/^["'](.*)["']$/)
    if (stringMatch) return stringMatch[1]

    // Number literals
    const num = parseFloat(trimmed)
    if (!isNaN(num) && /^-?\d+(\.\d+)?$/.test(trimmed)) return num

    // Variable reference (already resolved)
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed
    }
  }

  private evaluateExpression(expression: string, variables?: Record<string, any>): any {
    if (!expression) return null
    
    // Handle ${variable} syntax
    const processed = expression.replace(/\$\{([^}]+)\}/g, (_, key) => {
      return variables?.[key] || ''
    })
    
    return processed
  }

  private resolveExpression(expression: any, variables?: Record<string, any>): any {
    if (typeof expression === 'string') {
      return this.evaluateExpression(expression, variables)
    }
    return expression
  }

  private async updateProcessVariables(
    instanceId: string,
    variables: Record<string, any>
  ): Promise<void> {
    const instance = this.runningInstances.get(instanceId)
    if (instance) {
      instance.variables = { ...instance.variables, ...variables }
    }

    // Update in database
    await db
      .updateTable('bpmn_process_instances')
      .set({
        variables: JSON.stringify({ ...(instance?.variables || {}), ...variables })
      })
      .where('id', '=', instanceId)
      .execute()

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
        .onConflict((oc) =>
          oc.columns(['name', 'process_instance_id', 'execution_id', 'task_id'])
            .doUpdateSet({
              value: typeof value === 'object' ? null : String(value),
              json_value: typeof value === 'object' ? JSON.stringify(value) : null
            })
        )
        .execute()
    }
  }

  private async handleActivityError(
    instanceId: string,
    activityInstanceId: string,
    error: any
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error)

    // Update activity with error
    await db
      .updateTable('bpmn_activity_instances')
      .set({
        state: 'FAILED',
        incident_message: errorMessage
      })
      .where('id', '=', activityInstanceId)
      .execute()

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
      .execute()

    this.emit('activity:error', { instanceId, activityInstanceId, error: errorMessage })
  }

  private async createExternalTask(
    instanceId: string,
    activityDef: ActivityDefinition
  ): Promise<void> {
    const props = activityDef.properties || {}
    const instance = this.runningInstances.get(instanceId)

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
      .execute()
  }

  private async handleIntermediateEvent(
    instanceId: string,
    activityDef: ActivityDefinition
  ): Promise<void> {
    const props = activityDef.properties || {}

    if (props.messageRef) {
      // Subscribe to message
      const subscriptions = this.messageSubscriptions.get(props.messageRef) || new Set()
      subscriptions.add(instanceId)
      this.messageSubscriptions.set(props.messageRef, subscriptions)
    }

    if (props.signalRef) {
      // Subscribe to signal
      const subscriptions = this.signalSubscriptions.get(props.signalRef) || new Set()
      subscriptions.add(instanceId)
      this.signalSubscriptions.set(props.signalRef, subscriptions)
    }

    if (props.timerDefinition) {
      // Create timer job
      await this.createTimerJob(instanceId, activityDef.id, props.timerDefinition)
    }
  }

  private async createTimerJob(
    instanceId: string,
    activityId: string,
    timerDef: TimerDefinition
  ): Promise<void> {
    const instance = this.runningInstances.get(instanceId)
    let dueTime: Date

    switch (timerDef.type) {
      case 'date':
        dueTime = new Date(timerDef.value)
        break
      case 'duration':
        // Parse ISO 8601 duration
        dueTime = this.parseDuration(timerDef.value)
        break
      case 'cycle':
        // Create recurring job
        this.scheduleRecurringTimer(instanceId, activityId, timerDef.value)
        return
      default:
        return
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
      .execute()
  }

  private parseDuration(duration: string): Date {
    // Simple ISO 8601 duration parser
    const now = new Date()
    const match = duration.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/)
    
    if (match) {
      const days = parseInt(match[1] || '0')
      const hours = parseInt(match[2] || '0')
      const minutes = parseInt(match[3] || '0')
      const seconds = parseInt(match[4] || '0')
      
      now.setDate(now.getDate() + days)
      now.setHours(now.getHours() + hours)
      now.setMinutes(now.getMinutes() + minutes)
      now.setSeconds(now.getSeconds() + seconds)
    }
    
    return now
  }

  private scheduleRecurringTimer(
    instanceId: string,
    activityId: string,
    cronExpression: string
  ): void {
    const job = cron.schedule(cronExpression, async () => {
      await this.fireTimer(instanceId, activityId)
    })

    const jobId = `${instanceId}-${activityId}`
    this.timerJobs.set(jobId, job)
    job.start()
  }

  private async fireTimer(instanceId: string, activityId: string): Promise<void> {
    // Continue process from timer activity
    await this.continueProcess(instanceId, activityId)
  }

  private cleanupInstanceTimers(instanceId: string): void {
    // Remove all timers for instance
    for (const [key, job] of this.timerJobs.entries()) {
      if (key.startsWith(instanceId)) {
        job.stop()
        this.timerJobs.delete(key)
      }
    }
  }

  private startTimerProcessor(): void {
    // Process due timer jobs every minute
    cron.schedule('* * * * *', async () => {
      const dueJobs = await db
        .selectFrom('bpmn_timer_jobs')
        .selectAll()
        .where('state', '=', 'WAITING')
        .where('due_time', '<=', new Date())
        .execute()

      for (const job of dueJobs) {
        await this.processTimerJob(job)
      }
    })
  }

  private async processTimerJob(job: any): Promise<void> {
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
        .execute()

      // Fire timer
      await this.fireTimer(job.process_instance_id, job.activity_id)

      // Complete job
      await db
        .updateTable('bpmn_timer_jobs')
        .set({ state: 'COMPLETED' })
        .where('id', '=', job.id)
        .execute()
    } catch (error) {
      await db
        .updateTable('bpmn_timer_jobs')
        .set({
          state: 'FAILED',
          retries: job.retries - 1,
          exception_message: error instanceof Error ? error.message : String(error)
        })
        .where('id', '=', job.id)
        .execute()
    }
  }

  private async deliverMessage(
    instanceId: string,
    messageName: string,
    variables?: Record<string, any>
  ): Promise<void> {
    // Update process variables
    if (variables) {
      await this.updateProcessVariables(instanceId, variables)
    }

    // Continue process execution
    // Find waiting message catch event and continue
  }

  private async deliverSignal(
    instanceId: string,
    signalName: string,
    variables?: Record<string, any>
  ): Promise<void> {
    // Update process variables
    if (variables) {
      await this.updateProcessVariables(instanceId, variables)
    }

    // Continue process execution
    // Find waiting signal catch event and continue
  }

  /**
   * Initialize metrics collection
   * Note: Metrics module doesn't currently expose Gauge/Counter/Histogram constructors
   * This would need integration with prom-client if custom metrics are required
   */
  private initializeMetrics(): void {
    // TODO: Implement custom BPMN metrics if prom-client is exposed from metrics module
    // For now, rely on existing metrics in ../metrics/metrics.ts
  }

  /**
   * Start health check interval
   */
  private startHealthCheck(): void {
    setInterval(async () => {
      try {
        // Update metrics
        const activeCount = await db
          .selectFrom('bpmn_process_instances')
          .select('id')
          .where('state', '=', 'ACTIVE')
          .execute()

        if ((this as any).workflowMetrics) {
          ;(this as any).workflowMetrics.processInstancesActive.set(activeCount.length)
        }

        // Check for stuck instances (active for more than 24 hours)
        const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        const stuckInstances = await db
          .selectFrom('bpmn_process_instances')
          .selectAll()
          .where('state', '=', 'ACTIVE')
          .where('start_time', '<', cutoffTime as any)
          .execute()

        if (stuckInstances.length > 0) {
          this.logger.warn(`Found ${stuckInstances.length} potentially stuck process instances`)
        }
      } catch (error) {
        this.logger.error('Health check failed:', error)
      }
    }, 60000) // Every minute
  }

  /**
   * Load process definitions from database
   */
  private async loadProcessDefinitions(): Promise<void> {
    try {
      const definitions = await db
        .selectFrom('bpmn_process_definitions')
        .selectAll()
        .where('is_executable', '=', true)
        .execute()

      for (const definition of definitions) {
        try {
          const parsed = await this.parseBPMN(definition.bpmn_xml)
          this.processDefinitions.set(definition.id, parsed)
          this.registerEventSubscriptions(definition.id, parsed)
        } catch (error) {
          this.logger.error(`Failed to load process definition ${definition.key}:`, error)
        }
      }

      this.logger.info(`Loaded ${this.processDefinitions.size} process definitions`)
    } catch (error) {
      this.logger.error('Failed to load process definitions:', error)
      throw error
    }
  }

  /**
   * Resume active instances on startup
   */
  private async resumeActiveInstances(): Promise<void> {
    try {
      const activeInstances = await db
        .selectFrom('bpmn_process_instances')
        .selectAll()
        .where('state', '=', 'ACTIVE')
        .execute()

      for (const instance of activeInstances) {
        const processInstance: ProcessInstance = {
          id: instance.id,
          processDefinitionId: instance.process_definition_id,
          processDefinitionKey: instance.process_definition_key,
          businessKey: instance.business_key || undefined,
          name: instance.name || undefined,
          state: instance.state as any,
          variables: instance.variables ? JSON.parse(instance.variables as string) : {},
          startTime: new Date(instance.start_time as any),
          endTime: instance.end_time ? new Date(instance.end_time) : undefined,
          startUserId: instance.start_user_id || undefined
        }

        this.runningInstances.set(instance.id, processInstance)
      }

      this.logger.info(`Resumed ${activeInstances.length} active process instances`)
    } catch (error) {
      this.logger.error('Failed to resume active instances:', error)
      throw error
    }
  }

  /**
   * Parse BPMN XML definition
   */
  private async parseBPMN(bpmnXml: string): Promise<any> {
    return new Promise((resolve, reject) => {
      xml2js.parseString(bpmnXml, (err, result) => {
        if (err) {
          reject(new Error(`Invalid BPMN XML: ${err.message}`))
        } else {
          resolve(result)
        }
      })
    })
  }

  /**
   * Register event subscriptions for process definition
   */
  private registerEventSubscriptions(definitionId: string, parsed: any): void {
    try {
      const process = parsed.definitions?.process?.[0]
      if (!process) return

      // Register message events
      const messageEvents = this.findElementsByType(process, 'bpmn:intermediateCatchEvent')
        .filter((event: any) => event['bpmn:messageEventDefinition'])

      messageEvents.forEach((event: any) => {
        const messageRef = event['bpmn:messageEventDefinition']?.[0]?.['$']?.messageRef
        if (messageRef) {
          const subscriptions = this.messageSubscriptions.get(messageRef) || new Set()
          subscriptions.add(definitionId)
          this.messageSubscriptions.set(messageRef, subscriptions)
        }
      })

      // Register signal events
      const signalEvents = this.findElementsByType(process, 'bpmn:intermediateCatchEvent')
        .filter((event: any) => event['bpmn:signalEventDefinition'])

      signalEvents.forEach((event: any) => {
        const signalRef = event['bpmn:signalEventDefinition']?.[0]?.['$']?.signalRef
        if (signalRef) {
          const subscriptions = this.signalSubscriptions.get(signalRef) || new Set()
          subscriptions.add(definitionId)
          this.signalSubscriptions.set(signalRef, subscriptions)
        }
      })
    } catch (error) {
      this.logger.error(`Failed to register event subscriptions for ${definitionId}:`, error)
    }
  }

  /**
   * Find elements by type in BPMN definition
   */
  private findElementsByType(parent: any, type: string): any[] {
    const elements: any[] = []

    const search = (obj: any) => {
      if (obj && typeof obj === 'object') {
        if (obj[type]) {
          elements.push(...obj[type])
        }
        Object.values(obj).forEach(search)
      }
    }

    search(parent)
    return elements
  }

  /**
   * Get latest version of process definition
   */
  private async getLatestVersion(key: string, tenantId?: string): Promise<number> {
    const result = await db
      .selectFrom('bpmn_process_definitions')
      .select('version')
      .where('key', '=', key)
      .where('tenant_id', '=', tenantId || null)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst()

    return result?.version || 0
  }

  /**
   * Get process definition
   */
  private async getProcessDefinition(key: string, tenantId?: string): Promise<any> {
    return await db
      .selectFrom('bpmn_process_definitions')
      .selectAll()
      .where('key', '=', key)
      .where('tenant_id', '=', tenantId || null)
      .where('is_executable', '=', true)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst()
  }

  /**
   * Execute start events
   */
  private async executeStartEvents(instanceId: string, parsed: any): Promise<void> {
    const process = parsed.definitions?.process?.[0]
    if (!process) return

    const startEvents = this.findElementsByType(process, 'bpmn:startEvent')

    for (const startEvent of startEvents) {
      const activityId = startEvent.$.id
      const outgoing = startEvent['bpmn:outgoing']

      // Record start event execution
      const activityInstanceId = uuidv4()
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
        .execute()

      // Follow outgoing sequence flows
      if (outgoing) {
        for (const flowId of outgoing) {
          await this.takeSequenceFlow(instanceId, flowId)
        }
      }
    }
  }

  /**
   * Continue process execution from specific activity
   */
  private async continueProcess(instanceId: string, activityId: string): Promise<void> {
    const instance = this.runningInstances.get(instanceId)
    if (!instance) return

    const definition = this.processDefinitions.get(instance.processDefinitionId)
    if (!definition) return

    // Find activity definition and continue execution
    const activityDef = this.findActivity(definition, activityId)
    if (activityDef) {
      await this.executeActivity(instanceId, activityId, activityDef)
    }
  }

  /**
   * Enhanced incident handling with classification
   */
  private async createIncident(
    type: 'failedJob' | 'failedExternalTask' | 'unhandledError' | 'timeoutError',
    instanceId: string,
    activityId?: string,
    error?: any,
    context?: any
  ): Promise<void> {
    const incidentId = uuidv4()
    const errorMessage = error instanceof Error ? error.message : String(error)

    // Map timeoutError to unhandledError since DB doesn't have timeoutError type
    const dbIncidentType: 'failedJob' | 'failedExternalTask' | 'unhandledError' =
      type === 'timeoutError' ? 'unhandledError' : type

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
      .execute()

    // Update metrics
    if ((this as any).workflowMetrics) {
      ;(this as any).workflowMetrics.incidentsCreated.inc()
    }

    this.emit('incident:created', { incidentId, type, instanceId, activityId, error })
    this.logger.error(`Incident created: ${type} in process ${instanceId}`, error)
  }

  /**
   * Shutdown the engine
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down BPMN Workflow Engine')

    // Stop all timer jobs
    for (const job of this.timerJobs.values()) {
      job.stop()
    }

    // Clear caches
    this.processDefinitions.clear()
    this.runningInstances.clear()
    this.messageSubscriptions.clear()
    this.signalSubscriptions.clear()

    this.logger.info('BPMN Workflow Engine shutdown complete')
  }
}

export default BPMNWorkflowEngine