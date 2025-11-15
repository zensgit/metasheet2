/**
 * 甘特图视图插件
 */

import type { PluginLifecycle, PluginContext } from '@metasheet/core-backend/src/types/plugin'
import { GanttAPIHandler } from './api'
import { GanttEventHandlers } from './handlers'

export interface GanttTask {
  id: string
  viewId: string
  name: string
  description?: string
  startDate: Date
  endDate: Date
  progress: number
  parentId?: string
  orderIndex: number
  isMilestone: boolean
  priority?: 'low' | 'normal' | 'high' | 'critical'
  assignedTo?: string
  estimatedHours?: number
  actualHours?: number
  status: 'not_started' | 'in_progress' | 'completed' | 'cancelled' | 'on_hold'
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

export interface GanttDependency {
  id: string
  sourceTaskId: string
  targetTaskId: string
  type: 'finish_to_start' | 'start_to_start' | 'finish_to_finish' | 'start_to_finish'
  lagDays: number
  createdAt: Date
}

export interface GanttResource {
  id: string
  viewId: string
  name: string
  type: 'person' | 'equipment' | 'material'
  capacity: number
  costPerHour?: number
  createdAt: Date
  updatedAt: Date
}

export interface GanttTaskResource {
  id: string
  taskId: string
  resourceId: string
  allocationPercent: number
  assignedAt: Date
}

export interface CriticalPath {
  tasks: string[]
  totalDuration: number
  startDate: Date
  endDate: Date
}

export interface GanttViewData {
  tasks: GanttTask[]
  dependencies: GanttDependency[]
  resources: GanttResource[]
  taskResources: GanttTaskResource[]
  criticalPath?: CriticalPath
  timeline: {
    startDate: Date
    endDate: Date
    workingDays: number[]
    hoursPerDay: number
  }
}

export default class GanttPlugin implements PluginLifecycle {
  private context!: PluginContext
  private apiHandler!: GanttAPIHandler
  private eventHandlers!: GanttEventHandlers
  private ganttData = new Map<string, GanttViewData>()

  /**
   * 插件激活
   */
  async activate(context: PluginContext): Promise<void> {
    this.context = context

    // Initialize handlers
    this.apiHandler = new GanttAPIHandler(context, this)
    this.eventHandlers = new GanttEventHandlers(context, this)

    // Register API routes
    this.registerRoutes()

    // Register event listeners
    this.registerEventListeners()

    // Register plugin API
    this.registerPluginAPI()

    // Register WebSocket events
    this.registerWebSocketEvents()

    context.logger.info('Gantt plugin activated successfully')
  }

  /**
   * 插件停用
   */
  async deactivate(): Promise<void> {
    // Clean up resources
    this.ganttData.clear()
    this.context.logger.info('Gantt plugin deactivated')
  }

  /**
   * 注册API路由
   */
  private registerRoutes(): void {
    const { api } = this.context

    // Get gantt data for a view
    api.http.addRoute('GET', '/api/gantt/:viewId', this.apiHandler.getGanttData.bind(this.apiHandler))

    // Create task
    api.http.addRoute('POST', '/api/gantt/:viewId/tasks', this.apiHandler.createTask.bind(this.apiHandler))

    // Update task
    api.http.addRoute('PUT', '/api/gantt/:viewId/tasks/:taskId', this.apiHandler.updateTask.bind(this.apiHandler))

    // Delete task
    api.http.addRoute('DELETE', '/api/gantt/:viewId/tasks/:taskId', this.apiHandler.deleteTask.bind(this.apiHandler))

    // Create dependency
    api.http.addRoute('POST', '/api/gantt/:viewId/dependencies', this.apiHandler.createDependency.bind(this.apiHandler))

    // Delete dependency
    api.http.addRoute('DELETE', '/api/gantt/:viewId/dependencies/:dependencyId', this.apiHandler.deleteDependency.bind(this.apiHandler))

    // Calculate critical path
    api.http.addRoute('GET', '/api/gantt/:viewId/critical-path', this.apiHandler.calculateCriticalPath.bind(this.apiHandler))

    // Resource management endpoints
    api.http.addRoute('GET', '/api/gantt/:viewId/resources', this.apiHandler.getResources.bind(this.apiHandler))
    api.http.addRoute('POST', '/api/gantt/:viewId/resources', this.apiHandler.createResource.bind(this.apiHandler))
    api.http.addRoute('PUT', '/api/gantt/:viewId/resources/:resourceId', this.apiHandler.updateResource.bind(this.apiHandler))
    api.http.addRoute('DELETE', '/api/gantt/:viewId/resources/:resourceId', this.apiHandler.deleteResource.bind(this.apiHandler))

    // Task resource assignment endpoints
    api.http.addRoute('POST', '/api/gantt/:viewId/tasks/:taskId/resources', this.apiHandler.assignResource.bind(this.apiHandler))
    api.http.addRoute('DELETE', '/api/gantt/:viewId/tasks/:taskId/resources/:resourceId', this.apiHandler.unassignResource.bind(this.apiHandler))

    // Export project
    api.http.addRoute('GET', '/api/gantt/:viewId/export', this.apiHandler.exportProject.bind(this.apiHandler))

    this.context.logger.info('Gantt routes registered')
  }

  /**
   * 注册事件监听
   */
  private registerEventListeners(): void {
    const { api } = this.context

    // Listen for view updates
    api.events.on('view:update', this.eventHandlers.handleViewUpdate.bind(this.eventHandlers))

    // Listen for task updates
    api.events.on('gantt:task:created', this.eventHandlers.handleTaskCreated.bind(this.eventHandlers))
    api.events.on('gantt:task:updated', this.eventHandlers.handleTaskUpdated.bind(this.eventHandlers))
    api.events.on('gantt:task:deleted', this.eventHandlers.handleTaskDeleted.bind(this.eventHandlers))

    // Listen for dependency updates
    api.events.on('gantt:dependency:created', this.eventHandlers.handleDependencyCreated.bind(this.eventHandlers))
    api.events.on('gantt:dependency:deleted', this.eventHandlers.handleDependencyDeleted.bind(this.eventHandlers))

    this.context.logger.info('Event listeners registered')
  }

  /**
   * 注册插件API
   */
  private registerPluginAPI(): void {
    this.context.communication.register('gantt', {
      getGanttData: this.getGanttData.bind(this),
      createTask: this.createTask.bind(this),
      updateTask: this.updateTask.bind(this),
      deleteTask: this.deleteTask.bind(this),
      createDependency: this.createDependency.bind(this),
      calculateCriticalPath: this.calculateCriticalPath.bind(this),
      syncData: this.syncGanttData.bind(this)
    })

    this.context.logger.info('Plugin API registered')
  }

  /**
   * 注册WebSocket事件
   */
  private registerWebSocketEvents(): void {
    const { api } = this.context

    api.websocket.onConnection((socket: any) => {
      // Handle subscribe requests
      socket.on('gantt:subscribe', async (data: any) => {
        const { viewId } = data
        socket.join(`gantt:${viewId}`)

        // Send initial data
        const ganttData = await this.getGanttData(viewId)
        socket.emit('gantt:data', ganttData)
      })

      // Handle unsubscribe
      socket.on('gantt:unsubscribe', (data: any) => {
        const { viewId } = data
        socket.leave(`gantt:${viewId}`)
      })

      // Handle task updates via WebSocket
      socket.on('gantt:task:update', async (data: any) => {
        const { viewId, taskId, updates } = data
        try {
          await this.updateTask(viewId, taskId, updates)
          socket.to(`gantt:${viewId}`).emit('gantt:task:updated', { taskId, updates })
        } catch (error) {
          socket.emit('gantt:error', { error: error.message })
        }
      })
    })

    this.context.logger.info('WebSocket events registered')
  }

  /**
   * Get gantt data for a view
   */
  async getGanttData(viewId: string): Promise<GanttViewData> {
    // Check cache first
    if (this.ganttData.has(viewId)) {
      return this.ganttData.get(viewId)!
    }

    // Load from database
    const data = await this.loadGanttDataFromDatabase(viewId)

    // Cache the data
    this.ganttData.set(viewId, data)

    return data
  }

  /**
   * Load gantt data from database
   */
  private async loadGanttDataFromDatabase(viewId: string): Promise<GanttViewData> {
    const { api } = this.context

    // Load tasks
    const tasksQuery = `
      SELECT * FROM gantt_tasks
      WHERE view_id = $1
      ORDER BY parent_id NULLS FIRST, order_index ASC
    `
    const tasks = await api.database.query(tasksQuery, [viewId])

    // Load dependencies
    const dependenciesQuery = `
      SELECT * FROM gantt_dependencies
      WHERE source_task_id IN (
        SELECT id FROM gantt_tasks WHERE view_id = $1
      )
    `
    const dependencies = await api.database.query(dependenciesQuery, [viewId])

    // Load resources
    const resourcesQuery = `SELECT * FROM gantt_resources WHERE view_id = $1`
    const resources = await api.database.query(resourcesQuery, [viewId])

    // Load task resources
    const taskResourcesQuery = `
      SELECT tr.* FROM gantt_task_resources tr
      INNER JOIN gantt_tasks t ON tr.task_id = t.id
      WHERE t.view_id = $1
    `
    const taskResources = await api.database.query(taskResourcesQuery, [viewId])

    // Calculate timeline
    const timeline = this.calculateTimeline(tasks as GanttTask[])

    return {
      tasks: tasks as GanttTask[],
      dependencies: dependencies as GanttDependency[],
      resources: resources as GanttResource[],
      taskResources: taskResources as GanttTaskResource[],
      timeline
    }
  }

  /**
   * Calculate project timeline
   */
  private calculateTimeline(tasks: GanttTask[]): GanttViewData['timeline'] {
    if (tasks.length === 0) {
      const now = new Date()
      return {
        startDate: now,
        endDate: now,
        workingDays: [1, 2, 3, 4, 5], // Mon-Fri
        hoursPerDay: 8
      }
    }

    const startDates = tasks.map(t => new Date(t.startDate))
    const endDates = tasks.map(t => new Date(t.endDate))

    const startDate = new Date(Math.min(...startDates.map(d => d.getTime())))
    const endDate = new Date(Math.max(...endDates.map(d => d.getTime())))

    return {
      startDate,
      endDate,
      workingDays: [1, 2, 3, 4, 5], // Mon-Fri
      hoursPerDay: 8
    }
  }

  /**
   * Create a new task
   */
  async createTask(viewId: string, taskData: Partial<GanttTask>): Promise<GanttTask> {
    const { api } = this.context

    const query = `
      INSERT INTO gantt_tasks (
        view_id, name, description, start_date, end_date,
        progress, parent_id, order_index, is_milestone,
        priority, assigned_to, estimated_hours, status, created_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
      ) RETURNING *
    `

    const values = [
      viewId,
      taskData.name,
      taskData.description,
      taskData.startDate,
      taskData.endDate,
      taskData.progress || 0,
      taskData.parentId,
      taskData.orderIndex || 0,
      taskData.isMilestone || false,
      taskData.priority,
      taskData.assignedTo,
      taskData.estimatedHours,
      taskData.status || 'not_started',
      taskData.createdBy
    ]

    const result = await api.database.query(query, values)
    const task = result[0] as GanttTask

    // Update cache
    await this.syncGanttData(viewId)

    // Emit event
    api.events.emit('gantt:task:created', { viewId, task })

    return task
  }

  /**
   * Update a task
   */
  async updateTask(viewId: string, taskId: string, updates: Partial<GanttTask>): Promise<void> {
    const { api } = this.context

    const fields: string[] = []
    const values: any[] = []
    let index = 1

    // Build dynamic update query
    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined && key !== 'id' && key !== 'viewId' && key !== 'createdAt' && key !== 'createdBy') {
        fields.push(`${this.camelToSnake(key)} = $${index++}`)
        values.push(value)
      }
    })

    if (fields.length === 0) return

    fields.push(`updated_at = NOW()`)
    values.push(taskId, viewId)

    const query = `
      UPDATE gantt_tasks
      SET ${fields.join(', ')}
      WHERE id = $${index} AND view_id = $${index + 1}
    `

    await api.database.query(query, values)

    // Update cache
    await this.syncGanttData(viewId)

    // Emit event
    api.events.emit('gantt:task:updated', { viewId, taskId, updates })
  }

  /**
   * Delete a task
   */
  async deleteTask(viewId: string, taskId: string): Promise<void> {
    const { api } = this.context

    await api.database.query(
      'DELETE FROM gantt_tasks WHERE id = $1 AND view_id = $2',
      [taskId, viewId]
    )

    // Update cache
    await this.syncGanttData(viewId)

    // Emit event
    api.events.emit('gantt:task:deleted', { viewId, taskId })
  }

  /**
   * Create a dependency
   */
  async createDependency(viewId: string, dependencyData: Partial<GanttDependency>): Promise<GanttDependency> {
    const { api } = this.context

    const query = `
      INSERT INTO gantt_dependencies (source_task_id, target_task_id, type, lag_days)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `

    const values = [
      dependencyData.sourceTaskId,
      dependencyData.targetTaskId,
      dependencyData.type || 'finish_to_start',
      dependencyData.lagDays || 0
    ]

    const result = await api.database.query(query, values)
    const dependency = result[0] as GanttDependency

    // Update cache
    await this.syncGanttData(viewId)

    // Emit event
    api.events.emit('gantt:dependency:created', { viewId, dependency })

    return dependency
  }

  /**
   * Calculate critical path
   */
  async calculateCriticalPath(viewId: string): Promise<CriticalPath | null> {
    const data = await this.getGanttData(viewId)

    // Simple critical path calculation (can be enhanced with more sophisticated algorithms)
    const tasks = data.tasks
    const dependencies = data.dependencies

    if (tasks.length === 0) return null

    // Find tasks with no dependencies (start tasks)
    const startTasks = tasks.filter(task =>
      !dependencies.some(dep => dep.targetTaskId === task.id)
    )

    // Find tasks with no dependents (end tasks)
    const endTasks = tasks.filter(task =>
      !dependencies.some(dep => dep.sourceTaskId === task.id)
    )

    // For simplicity, find the longest path
    let longestPath: string[] = []
    let maxDuration = 0

    for (const startTask of startTasks) {
      const path = this.findLongestPath(startTask.id, tasks, dependencies)
      const duration = this.calculatePathDuration(path, tasks)

      if (duration > maxDuration) {
        maxDuration = duration
        longestPath = path
      }
    }

    if (longestPath.length === 0) return null

    const criticalTasks = tasks.filter(task => longestPath.includes(task.id))
    const startDate = new Date(Math.min(...criticalTasks.map(t => t.startDate.getTime())))
    const endDate = new Date(Math.max(...criticalTasks.map(t => t.endDate.getTime())))

    return {
      tasks: longestPath,
      totalDuration: maxDuration,
      startDate,
      endDate
    }
  }

  /**
   * Find longest path from a start task
   */
  private findLongestPath(taskId: string, tasks: GanttTask[], dependencies: GanttDependency[]): string[] {
    const visited = new Set<string>()
    const path: string[] = []

    const dfs = (currentTaskId: string): string[] => {
      if (visited.has(currentTaskId)) return []

      visited.add(currentTaskId)
      path.push(currentTaskId)

      const dependents = dependencies
        .filter(dep => dep.sourceTaskId === currentTaskId)
        .map(dep => dep.targetTaskId)

      let longestSubPath: string[] = []

      for (const dependentId of dependents) {
        const subPath = dfs(dependentId)
        if (subPath.length > longestSubPath.length) {
          longestSubPath = subPath
        }
      }

      return [currentTaskId, ...longestSubPath]
    }

    return dfs(taskId)
  }

  /**
   * Calculate duration of a path
   */
  private calculatePathDuration(path: string[], tasks: GanttTask[]): number {
    let totalDuration = 0

    for (const taskId of path) {
      const task = tasks.find(t => t.id === taskId)
      if (task) {
        const duration = Math.ceil((task.endDate.getTime() - task.startDate.getTime()) / (1000 * 60 * 60 * 24))
        totalDuration += duration
      }
    }

    return totalDuration
  }

  /**
   * Sync gantt data (clear cache and reload)
   */
  async syncGanttData(viewId: string): Promise<void> {
    this.ganttData.delete(viewId)
    await this.getGanttData(viewId)
  }

  /**
   * Convert camelCase to snake_case
   */
  private camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
  }

  /**
   * Get gantt data cache
   */
  getGanttDataCache(): Map<string, GanttViewData> {
    return this.ganttData
  }
}