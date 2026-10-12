import { randomBytes } from 'node:crypto'
import { generateTaskDomainId } from '../tasks/task-ids'

function randomSuffix(n: number): string {
  return randomBytes(Math.max(n, 1)).toString('hex')
}

export function newTaskEventId(): string {
  return generateTaskDomainId('event', randomSuffix)
}

export function newTaskId(): string {
  return generateTaskDomainId('task', randomSuffix)
}

export function newTaskCommentId(): string {
  return generateTaskDomainId('comment', randomSuffix)
}

export function newTaskListId(): string {
  return generateTaskDomainId('list', randomSuffix)
}

// RULED(2026-10-07): [R23] `tgrp_` prefix for task_groups.id.
export function newTaskGroupId(): string {
  return generateTaskDomainId('group', randomSuffix)
}

// RULED(2026-10-07): [R23] `tlev_` prefix for task_list_events.id.
export function newTaskListEventId(): string {
  return generateTaskDomainId('listEvent', randomSuffix)
}
