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
