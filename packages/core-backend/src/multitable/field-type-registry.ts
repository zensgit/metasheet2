export interface FieldTypeDefinition {
  name: string
  validate: (value: unknown, fieldId: string) => unknown
  sanitizeProperty: (property: unknown) => Record<string, unknown>
  serialize?: (value: unknown) => unknown
  deserialize?: (value: unknown) => unknown
}

export class FieldTypeRegistry {
  private readonly definitions = new Map<string, FieldTypeDefinition>()

  register(typeName: string, definition: FieldTypeDefinition): void {
    if (!typeName || typeof typeName !== 'string') {
      throw new Error('Field type name must be a non-empty string')
    }
    this.definitions.set(typeName, definition)
  }

  has(typeName: string): boolean {
    return this.definitions.has(typeName)
  }

  get(typeName: string): FieldTypeDefinition | undefined {
    return this.definitions.get(typeName)
  }

  unregister(typeName: string): void {
    this.definitions.delete(typeName)
  }

  getRegisteredTypes(): string[] {
    return Array.from(this.definitions.keys())
  }
}

export const fieldTypeRegistry = new FieldTypeRegistry()
