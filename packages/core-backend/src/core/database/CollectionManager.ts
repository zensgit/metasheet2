import type { CollectionDefinition } from '../../types/collection'
import { Repository } from './Repository'

export class CollectionManager {
  private definitions = new Map<string, CollectionDefinition>()

  register(definition: CollectionDefinition): void {
    if (!definition) return
    const key = definition.name || definition.id || definition.tableId
    if (!key) return
    this.definitions.set(String(key), definition)
  }

  async getDefinition(sheetId: string): Promise<CollectionDefinition | null> {
    return this.definitions.get(sheetId) ?? null
  }

  getRepository(name: string): Repository {
    return new Repository(name)
  }

  async sync(): Promise<void> {
    // No-op for now; implementations can override with persistence.
  }
}
