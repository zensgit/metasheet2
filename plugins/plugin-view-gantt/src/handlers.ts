/**
 * Gantt Event Handlers
 */

import type { PluginContext } from '@metasheet/core-backend/src/types/plugin'
import type GanttPlugin from './index'
import type {
  GanttDependency,
  GanttTask,
  GanttTaskResource,
  GanttViewData,
} from './index'

interface GanttViewConfig {
  autoSchedule?: boolean
  autoCalculateCriticalPath?: boolean
}

interface ViewUpdateEvent {
  type?: string
  viewId?: string
}

interface TaskCreatedEvent {
  viewId: string
  task: GanttTask
}

interface TaskUpdatedEvent {
  viewId: string
  taskId: string
  updates: Partial<GanttTask>
}

interface TaskDeletedEvent {
  viewId: string
  taskId: string
}

interface DependencyCreatedEvent {
  viewId: string
  dependency: GanttDependency
}

interface DependencyDeletedEvent {
  viewId: string
  dependencyId: string
}

export class GanttEventHandlers {
  constructor(
    private readonly context: PluginContext,
    private readonly plugin: GanttPlugin,
  ) {}

  async handleViewUpdate(data: ViewUpdateEvent): Promise<void> {
    try {
      if (data.type !== 'gantt' || !data.viewId) {
        return
      }

      const { viewId } = data
      await this.plugin.syncGanttData(viewId)

      this.context.api.websocket.broadcastTo(`gantt:${viewId}`, 'gantt:viewUpdated', {
        viewId,
        timestamp: new Date().toISOString(),
      })

      this.context.logger.info(`Gantt view ${viewId} updated`)
    } catch (error) {
      this.context.logger.error('Error handling view update:', error)
    }
  }

  async handleTaskCreated(data: TaskCreatedEvent): Promise<void> {
    try {
      const { viewId, task } = data
      this.context.logger.info(`Task created in gantt view ${viewId}: ${task.name}`)

      const viewConfig = await this.getViewConfig(viewId)
      if (viewConfig.autoCalculateCriticalPath) {
        const criticalPath = await this.plugin.calculateCriticalPath(viewId)
        this.context.api.websocket.broadcastTo(`gantt:${viewId}`, 'gantt:criticalPathUpdated', {
          viewId,
          criticalPath,
          triggeredBy: 'taskCreated',
          timestamp: new Date().toISOString(),
        })
      }

      if (viewConfig.autoSchedule) {
        await this.autoScheduleDependentTasks(viewId, task.id)
      }

      await this.checkResourceConflicts(viewId, task.id)
    } catch (error) {
      this.context.logger.error('Error handling task created:', error)
    }
  }

  async handleTaskUpdated(data: TaskUpdatedEvent): Promise<void> {
    try {
      const { viewId, taskId, updates } = data
      this.context.logger.info(`Task updated in gantt view ${viewId}: ${taskId}`)

      if (updates.startDate || updates.endDate) {
        const viewConfig = await this.getViewConfig(viewId)

        if (viewConfig.autoSchedule) {
          await this.autoScheduleDependentTasks(viewId, taskId)
        }

        if (viewConfig.autoCalculateCriticalPath) {
          const criticalPath = await this.plugin.calculateCriticalPath(viewId)
          this.context.api.websocket.broadcastTo(`gantt:${viewId}`, 'gantt:criticalPathUpdated', {
            viewId,
            criticalPath,
            triggeredBy: 'taskUpdated',
            timestamp: new Date().toISOString(),
          })
        }

        await this.checkResourceConflicts(viewId, taskId)
      }

      if (updates.progress !== undefined) {
        await this.checkMilestoneCompletion(viewId, taskId, updates.progress)
      }
    } catch (error) {
      this.context.logger.error('Error handling task updated:', error)
    }
  }

  async handleTaskDeleted(data: TaskDeletedEvent): Promise<void> {
    try {
      const { viewId, taskId } = data
      this.context.logger.info(`Task deleted from gantt view ${viewId}: ${taskId}`)

      const viewConfig = await this.getViewConfig(viewId)
      if (viewConfig.autoCalculateCriticalPath) {
        const criticalPath = await this.plugin.calculateCriticalPath(viewId)
        this.context.api.websocket.broadcastTo(`gantt:${viewId}`, 'gantt:criticalPathUpdated', {
          viewId,
          criticalPath,
          triggeredBy: 'taskDeleted',
          timestamp: new Date().toISOString(),
        })
      }

      if (viewConfig.autoSchedule) {
        await this.rescheduleAllTasks(viewId)
      }
    } catch (error) {
      this.context.logger.error('Error handling task deleted:', error)
    }
  }

  async handleDependencyCreated(data: DependencyCreatedEvent): Promise<void> {
    try {
      const { viewId, dependency } = data
      this.context.logger.info(
        `Dependency created in gantt view ${viewId}: ${dependency.sourceTaskId} -> ${dependency.targetTaskId}`,
      )

      const viewConfig = await this.getViewConfig(viewId)
      if (viewConfig.autoSchedule) {
        await this.autoScheduleDependentTasks(viewId, dependency.sourceTaskId)
      }

      if (viewConfig.autoCalculateCriticalPath) {
        const criticalPath = await this.plugin.calculateCriticalPath(viewId)
        this.context.api.websocket.broadcastTo(`gantt:${viewId}`, 'gantt:criticalPathUpdated', {
          viewId,
          criticalPath,
          triggeredBy: 'dependencyCreated',
          timestamp: new Date().toISOString(),
        })
      }
    } catch (error) {
      this.context.logger.error('Error handling dependency created:', error)
    }
  }

  async handleDependencyDeleted(data: DependencyDeletedEvent): Promise<void> {
    try {
      const { viewId, dependencyId } = data
      this.context.logger.info(`Dependency deleted from gantt view ${viewId}: ${dependencyId}`)

      const viewConfig = await this.getViewConfig(viewId)
      if (viewConfig.autoCalculateCriticalPath) {
        const criticalPath = await this.plugin.calculateCriticalPath(viewId)
        this.context.api.websocket.broadcastTo(`gantt:${viewId}`, 'gantt:criticalPathUpdated', {
          viewId,
          criticalPath,
          triggeredBy: 'dependencyDeleted',
          timestamp: new Date().toISOString(),
        })
      }
    } catch (error) {
      this.context.logger.error('Error handling dependency deleted:', error)
    }
  }

  private async getViewConfig(viewId: string): Promise<GanttViewConfig> {
    try {
      const result = await this.context.api.database.query('SELECT config FROM views WHERE id = $1', [viewId])
      const row = result[0] as { config?: GanttViewConfig } | undefined
      return row?.config ?? {}
    } catch (error) {
      this.context.logger.error('Error getting view config:', error)
      return {}
    }
  }

  private async autoScheduleDependentTasks(viewId: string, sourceTaskId: string): Promise<void> {
    try {
      const ganttData = await this.plugin.getGanttData(viewId)
      const sourceTask = ganttData.tasks.find((task) => task.id === sourceTaskId)

      if (!sourceTask) {
        return
      }

      const dependentTaskIds = ganttData.dependencies
        .filter((dependency) => dependency.sourceTaskId === sourceTaskId)
        .map((dependency) => dependency.targetTaskId)

      for (const dependentTaskId of dependentTaskIds) {
        const dependentTask = ganttData.tasks.find((task) => task.id === dependentTaskId)
        const dependency = ganttData.dependencies.find((candidate) => {
          return candidate.sourceTaskId === sourceTaskId && candidate.targetTaskId === dependentTaskId
        })

        if (!dependentTask || !dependency) {
          continue
        }

        let newStartDate: Date | null = null

        switch (dependency.type) {
          case 'finish_to_start':
            newStartDate = new Date(sourceTask.endDate.getTime() + dependency.lagDays * 24 * 60 * 60 * 1000)
            break
          case 'start_to_start':
            newStartDate = new Date(sourceTask.startDate.getTime() + dependency.lagDays * 24 * 60 * 60 * 1000)
            break
          case 'finish_to_finish': {
            const taskDuration = dependentTask.endDate.getTime() - dependentTask.startDate.getTime()
            const finishDate = new Date(sourceTask.endDate.getTime() + dependency.lagDays * 24 * 60 * 60 * 1000)
            newStartDate = new Date(finishDate.getTime() - taskDuration)
            break
          }
          case 'start_to_finish': {
            const dependentDuration = dependentTask.endDate.getTime() - dependentTask.startDate.getTime()
            newStartDate = new Date(
              sourceTask.startDate.getTime() + dependency.lagDays * 24 * 60 * 60 * 1000 - dependentDuration,
            )
            break
          }
        }

        if (!newStartDate || newStartDate.getTime() === dependentTask.startDate.getTime()) {
          continue
        }

        const duration = dependentTask.endDate.getTime() - dependentTask.startDate.getTime()
        const newEndDate = new Date(newStartDate.getTime() + duration)

        await this.plugin.updateTask(viewId, dependentTaskId, {
          startDate: newStartDate,
          endDate: newEndDate,
        })

        await this.autoScheduleDependentTasks(viewId, dependentTaskId)
      }
    } catch (error) {
      this.context.logger.error('Error auto-scheduling dependent tasks:', error)
    }
  }

  private async checkResourceConflicts(viewId: string, taskId: string): Promise<void> {
    try {
      const ganttData = await this.plugin.getGanttData(viewId)
      const task = ganttData.tasks.find((candidate) => candidate.id === taskId)

      if (!task) {
        return
      }

      const taskResources = ganttData.taskResources.filter((resource) => resource.taskId === taskId)
      for (const taskResource of taskResources) {
        const resource = ganttData.resources.find((candidate) => candidate.id === taskResource.resourceId)
        if (!resource) {
          continue
        }

        const overlappingTasks = await this.findOverlappingTasks(ganttData, task, taskResource.resourceId)
        if (overlappingTasks.length === 0) {
          continue
        }

        const totalAllocation = overlappingTasks.reduce((sum, overlappingTask) => {
          const overlappingAssignment = ganttData.taskResources.find((assignment) => {
            return assignment.taskId === overlappingTask.id && assignment.resourceId === taskResource.resourceId
          })

          return sum + (overlappingAssignment?.allocationPercent ?? 0)
        }, 0) + taskResource.allocationPercent

        if (totalAllocation <= resource.capacity) {
          continue
        }

        this.context.api.websocket.broadcastTo(`gantt:${viewId}`, 'gantt:resourceConflict', {
          viewId,
          resourceId: resource.id,
          resourceName: resource.name,
          conflictingTasks: [task.id, ...overlappingTasks.map((overlappingTask) => overlappingTask.id)],
          totalAllocation,
          capacity: resource.capacity,
          overallocation: totalAllocation - resource.capacity,
          timestamp: new Date().toISOString(),
        })

        this.context.logger.warn(
          `Resource conflict detected in gantt view ${viewId}: Resource ${resource.name} overallocated by ${totalAllocation - resource.capacity}%`,
        )
      }
    } catch (error) {
      this.context.logger.error('Error checking resource conflicts:', error)
    }
  }

  private async findOverlappingTasks(
    ganttData: GanttViewData,
    task: GanttTask,
    resourceId: string,
  ): Promise<GanttTask[]> {
    const overlappingTasks: GanttTask[] = []

    for (const otherTask of ganttData.tasks) {
      if (otherTask.id === task.id) {
        continue
      }

      const hasResource = ganttData.taskResources.some((taskResource: GanttTaskResource) => {
        return taskResource.taskId === otherTask.id && taskResource.resourceId === resourceId
      })

      if (!hasResource) {
        continue
      }

      const taskStart = new Date(task.startDate)
      const taskEnd = new Date(task.endDate)
      const otherStart = new Date(otherTask.startDate)
      const otherEnd = new Date(otherTask.endDate)

      if (taskStart < otherEnd && taskEnd > otherStart) {
        overlappingTasks.push(otherTask)
      }
    }

    return overlappingTasks
  }

  private async checkMilestoneCompletion(viewId: string, taskId: string, progress: number): Promise<void> {
    try {
      const ganttData = await this.plugin.getGanttData(viewId)
      const task = ganttData.tasks.find((candidate) => candidate.id === taskId)

      if (!task || !task.isMilestone || progress < 100 || task.status === 'completed') {
        return
      }

      await this.plugin.updateTask(viewId, taskId, {
        status: 'completed',
      })

      this.context.api.websocket.broadcastTo(`gantt:${viewId}`, 'gantt:milestoneCompleted', {
        viewId,
        milestoneId: taskId,
        milestoneName: task.name,
        completedAt: new Date().toISOString(),
      })

      this.context.logger.info(`Milestone completed in gantt view ${viewId}: ${task.name}`)
    } catch (error) {
      this.context.logger.error('Error checking milestone completion:', error)
    }
  }

  private async rescheduleAllTasks(viewId: string): Promise<void> {
    try {
      const ganttData = await this.plugin.getGanttData(viewId)
      const rootTasks = ganttData.tasks.filter((task) => {
        return !ganttData.dependencies.some((dependency) => dependency.targetTaskId === task.id)
      })

      for (const rootTask of rootTasks) {
        await this.autoScheduleDependentTasks(viewId, rootTask.id)
      }

      this.context.logger.info(`Rescheduled all tasks in gantt view ${viewId}`)
    } catch (error) {
      this.context.logger.error('Error rescheduling all tasks:', error)
    }
  }
}
