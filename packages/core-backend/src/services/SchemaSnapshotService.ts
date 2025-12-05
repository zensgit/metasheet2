import { db } from '../db/db'

export interface SchemaField {
  name: string
  type: string
  nullable: boolean
  defaultValue?: unknown
  constraints?: string[]
}

export interface SchemaIndex {
  name: string
  columns: string[]
  unique: boolean
}

export interface SchemaRelation {
  name: string
  targetTable: string
  type: 'one-to-one' | 'one-to-many' | 'many-to-many'
}

export interface SchemaDefinition {
  fields: SchemaField[]
  indexes: SchemaIndex[]
  relations: SchemaRelation[]
}

export interface SchemaDiff {
  addedFields: SchemaField[]
  removedFields: SchemaField[]
  modifiedFields: Array<{ before: SchemaField; after: SchemaField }>
  addedIndexes: SchemaIndex[]
  removedIndexes: SchemaIndex[]
  addedRelations: SchemaRelation[]
  removedRelations: SchemaRelation[]
  isBreakingChange: boolean
}

export class SchemaSnapshotService {
  /**
   * Create a schema snapshot
   */
  async createSchemaSnapshot(
    viewId: string,
    createdBy: string
  ): Promise<{ id: string; view_id: string; schema_version: string; schema_definition: SchemaDefinition; is_current: boolean; created_by: string }> {
    // Extract current schema (Mock implementation for now)
    const schemaDefinition = await this.extractSchemaDefinition(viewId)

    const version = `v${Date.now()}`

    const schemaSnapshot = await db
      .insertInto('schema_snapshots')
      .values({
        view_id: viewId,
        schema_version: version,
        schema_definition: JSON.stringify(schemaDefinition),
        validation_rules: JSON.stringify({}),
        migration_script: null,
        rollback_script: null,
        created_by: createdBy,
        is_current: true
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    // metrics.schemaSnapshotsCreatedTotal.inc()

    return {
      ...schemaSnapshot,
      schema_definition: schemaSnapshot.schema_definition as unknown as SchemaDefinition
    }
  }

  /**
   * Diff two schema snapshots
   */
  async diffSchemas(
    snapshotId1: string,
    snapshotId2: string
  ): Promise<SchemaDiff> {
    const s1 = await this.getSchemaSnapshot(snapshotId1)
    const s2 = await this.getSchemaSnapshot(snapshotId2)

    const schema1 = s1.schema_definition as unknown as SchemaDefinition
    const schema2 = s2.schema_definition as unknown as SchemaDefinition

    const diff: SchemaDiff = {
      addedFields: [],
      removedFields: [],
      modifiedFields: [],
      addedIndexes: [],
      removedIndexes: [],
      addedRelations: [],
      removedRelations: [],
      isBreakingChange: false
    }

    // Compare fields
    const fieldsMap1 = new Map<string, SchemaField>(schema1.fields.map((f) => [f.name, f]))
    const fieldsMap2 = new Map<string, SchemaField>(schema2.fields.map((f) => [f.name, f]))

    for (const [name, field] of fieldsMap2) {
      if (!fieldsMap1.has(name)) {
        diff.addedFields.push(field)
      } else {
        const oldField = fieldsMap1.get(name)!
        if (JSON.stringify(oldField) !== JSON.stringify(field)) {
          diff.modifiedFields.push({ before: oldField, after: field })
        }
      }
    }

    for (const [, field] of fieldsMap1) {
      if (!fieldsMap2.has(field.name)) {
        diff.removedFields.push(field)
        diff.isBreakingChange = true // Removing field is breaking
      }
    }

    // Check for breaking changes in modifications
    for (const mod of diff.modifiedFields) {
      if (mod.before.type !== mod.after.type) {
        diff.isBreakingChange = true
      }
      if (mod.before.nullable && !mod.after.nullable) {
        diff.isBreakingChange = true
      }
    }

    return diff
  }

  private async getSchemaSnapshot(id: string) {
    const snapshot = await db
      .selectFrom('schema_snapshots')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst()
    
    if (!snapshot) throw new Error(`Schema snapshot ${id} not found`)
    return snapshot
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async extractSchemaDefinition(_viewId: string): Promise<SchemaDefinition> {
    // Mock extraction
    return {
      fields: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: true }
      ],
      indexes: [],
      relations: []
    }
  }
}

export const schemaSnapshotService = new SchemaSnapshotService()
