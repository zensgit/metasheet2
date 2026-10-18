import { AsyncLocalStorage } from 'node:async_hooks'

export type ManagedRequestStore = {
  userId: string | null
  sessionId: string | null
  conflict: boolean
}

export const managedRequestContext = new AsyncLocalStorage<ManagedRequestStore>()

export function currentManagedRequest(): ManagedRequestStore | null {
  return managedRequestContext.getStore() ?? null
}
